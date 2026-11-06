/**
 * W13-B: gated launch of host child processes that survive a daemon crash.
 * Design: docs/design/2026-11-06-w13-host-git-survival.md (sections 4, 5).
 *
 * This module has no database knowledge. Persistence goes through the injected `HostProcessJournal`
 * (W13-A's store implements it); recovery goes through the injected `HostProcessProbe`. Node builtins only.
 * Keep it out of CLI startup paths: load it with `await import()` at the use site.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** Constant wrapper. `$0` is the op id, `"$@"` the program and its arguments; nothing is ever interpolated. */
export const GATED_WRAPPER_SCRIPT = 'IFS= read -r g || exit 97; [ "$g" = "$0" ] || exit 98; exec "$@"';
export const GATED_SHELL = "/bin/sh";
export const GATED_EXIT_EOF_BEFORE_RELEASE = 97;
export const GATED_EXIT_BAD_RELEASE = 98;
/** Seconds-level waits from design 5.2 rules 4 and 8. */
export const HOST_PROCESS_EOF_WAIT_MS = 5000;
export const HOST_PROCESS_ONLINE_PROOF_WAIT_MS = 2000;

export const HOST_PROCESS_KINDS = ["git_push", "gh_pr_create", "git_update_ref", "git_worktree_add", "git_index_write"] as const;
export type HostProcessKind = (typeof HOST_PROCESS_KINDS)[number];

export interface HostProcessMarker {
  path: string;
  /** Decimal (or 0x-hex) device number of the marker file, as TEXT in the ledger. */
  dev: string;
  ino: string;
}

export interface HostProcessLaunchInput {
  op_id: string;
  mission_id: string;
  kind: HostProcessKind;
  remote_target?: string;
  local_target: string;
  intent_id?: string;
  argv_digest: string;
  boot_id: string;
  marker: HostProcessMarker;
}

export interface HostProcessIdentity {
  pid: number;
  pgid: number;
  leader_start: string | null;
}

export type HostStopProof =
  | "rebooted"
  | "never_registered+marker_unheld"
  | "group_empty+marker_unheld"
  | "leader_reused+marker_unheld"
  | "never_released"
  | "never_spawned"
  | "already_stopped";

export type HostProcessUnknownReason =
  | "marker_lost"
  | "holder_scan_unavailable"
  | "unregistered_holder"
  | "escaped_holder"
  | "group_alive"
  | "group_present"
  | "probe_failed"
  | "record_invalid";

export interface HostProcessOutcome {
  proof: HostStopProof;
  detail: Record<string, unknown>;
  exit_code?: number | null;
  exit_signal?: string | null;
}

/** Synchronous, top-level-transaction journal (design 3.4). Every method may throw (e.g. `stale_owner`). */
export interface HostProcessJournal {
  launching(input: HostProcessLaunchInput): void;
  registered(opId: string, identity: HostProcessIdentity): void;
  /** Runs `fence()` first, then records the release in one transaction; `fence` throwing must roll everything back. */
  release(opId: string, fence: () => void): void;
  stopped(opId: string, outcome: HostProcessOutcome): void;
}

export class HostProcessError extends Error {
  constructor(
    readonly code: "HOST_PROCESS_INVALID_ARGS" | "HOST_PROCESS_ABORTED" | "HOST_PROCESS_MARKER_DIR" | "HOST_PROCESS_SPAWN_FAILED" | "HOST_PROCESS_IDENTITY",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HostProcessError";
  }
}

/** Thrown by `runHardenedGit({ gate })` when the process could not be proven stopped; the row stays open. */
export class HostProcessUnprovenError extends Error {
  constructor(
    readonly opId: string,
    readonly released: boolean,
  ) {
    super(`HOST_PROCESS_UNPROVEN: ${opId}`);
    this.name = "HostProcessUnprovenError";
  }
}

export class HolderScanUnavailableError extends Error {
  constructor(detail: string) {
    super(`holder_scan_unavailable: ${detail}`);
    this.name = "HolderScanUnavailableError";
  }
}

type Maybe<T> = T | Promise<T>;

export interface HostProcessLeader {
  pgid: number | null;
  /** `lstart` text (macOS, second resolution) or `starttime` ticks (Linux). null when unreadable. */
  start: string | null;
}

/** Read-only observations. Implementations must never send a signal (kill(pid, 0) excepted). */
export interface HostProcessProbe {
  bootSession(): Maybe<string | null>;
  /** kill(-pgid, 0): false only on ESRCH. */
  groupPresent(pgid: number): Maybe<boolean>;
  /** null: no such process. Throws when the observation itself failed. */
  leader(pid: number): Maybe<HostProcessLeader | null>;
  markerIdentity(marker: HostProcessMarker): Maybe<"ok" | "lost">;
  /** Throws `HolderScanUnavailableError` when the lsof positive control fails. */
  markerHeld(marker: HostProcessMarker): Maybe<boolean>;
}

// ---------------------------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------------------------

export interface LsofRecord {
  pid: number;
  fd: string;
  dev: bigint;
  ino: bigint;
}

/**
 * macOS dev_t is a signed 32-bit value that Node widens with sign extension, while lsof prints it as unsigned hex.
 * Compare the low 32 bits there; elsewhere compare exactly.
 */
export function normalizeDev(dev: bigint, platform: NodeJS.Platform = process.platform): bigint {
  return platform === "darwin" ? BigInt.asUintN(32, dev) : dev;
}

function parseId(text: string): bigint | null {
  return /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(text) ? BigInt(text) : null;
}

/** Parse `lsof -F pfDi`. Any malformed or unexpected line, or a process section without a file, yields null (scan failure). */
export function parseLsofFields(stdout: string): LsofRecord[] | null {
  const records: LsofRecord[] = [];
  let pid: number | null = null;
  let filesInSection = 0;
  let current: { fd?: string; dev?: bigint; ino?: bigint } | null = null;
  const flush = (): boolean => {
    if (current === null) return true;
    if (pid === null || current.fd === undefined || current.dev === undefined || current.ino === undefined) return false;
    records.push({ pid, fd: current.fd, dev: current.dev, ino: current.ino });
    filesInSection += 1;
    current = null;
    return true;
  };
  if (stdout === "") return records;
  if (!stdout.endsWith("\n")) return null;
  for (const line of stdout.slice(0, -1).split("\n")) {
    const tag = line.slice(0, 1);
    const value = line.slice(1);
    if (tag === "p") {
      if (!flush() || (pid !== null && filesInSection === 0) || !/^[0-9]+$/.test(value)) return null;
      filesInSection = 0;
      pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
    } else if (tag === "f") {
      if (pid === null || !flush() || value === "") return null;
      current = { fd: value };
    } else if (tag === "D") {
      const dev = parseId(value);
      if (current === null || dev === null || current.dev !== undefined) return null;
      current.dev = dev;
    } else if (tag === "i") {
      const ino = parseId(value);
      if (current === null || ino === null || current.ino !== undefined) return null;
      current.ino = ino;
    } else {
      return null;
    }
  }
  return flush() && filesInSection > 0 ? records : null;
}

function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.ino === b.ino && normalizeDev(a.dev) === normalizeDev(b.dev);
}

export interface LsofVerdict {
  held: boolean;
  /** Holder pids for diagnostics (never used to signal). A pid listed here may be this process (see below). */
  holders: number[];
}

/**
 * Apply the design 5.3 acceptance rules to an lsof run.
 *
 * The scanner holds BOTH files open itself (`self` is its pid), so lsof must exit 0 and list each of them for
 * `self`: the control proves lsof can read our descriptor table, and our own marker descriptor proves the path
 * resolved to the recorded inode (a marker swapped after the identity check cannot be mistaken for it). Our own
 * marker descriptor is not a holder; any other pid, or a second descriptor in our own pid (a leak), is.
 * Output about any other file, any warning on stderr, or any parse problem makes the scan unavailable.
 */
export function interpretLsof(
  run: { code: number | null; stdout: string; stderr: string },
  marker: { dev: bigint; ino: bigint },
  control: { dev: bigint; ino: bigint },
  self: number,
): LsofVerdict {
  if (run.stderr !== "") throw new HolderScanUnavailableError("stderr_not_empty");
  if (run.code !== 0) throw new HolderScanUnavailableError(`exit_${String(run.code)}`);
  const records = parseLsofFields(run.stdout);
  if (records === null) throw new HolderScanUnavailableError("unparseable");
  const controlRecords = records.filter((record) => sameFile(record, control));
  const markerRecords = records.filter((record) => sameFile(record, marker));
  if (controlRecords.length + markerRecords.length !== records.length) throw new HolderScanUnavailableError("unexpected_file");
  const [onlyControl] = controlRecords;
  if (controlRecords.length !== 1 || onlyControl === undefined || onlyControl.pid !== self) throw new HolderScanUnavailableError("control_missing");
  const ours = markerRecords.filter((record) => record.pid === self);
  if (ours.length === 0) throw new HolderScanUnavailableError("marker_unseen");
  const others = markerRecords.filter((record) => record.pid !== self).map((record) => record.pid);
  const holders = ours.length > 1 ? [self, ...others] : others;
  return { held: holders.length > 0, holders };
}

/** Complete C-locale `lstart` ("Fri Nov  6 10:00:00 2026") or Linux starttime ticks. Anything else cannot prove pid reuse. */
export function isWellFormedLeaderStart(start: string): boolean {
  return /^[A-Z][a-z]{2} +[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start) || /^\d+$/.test(start);
}

/** `ps -o pgid=,lstart= -p <pid>` line to leader observation. */
export function parsePsLeader(stdout: string): HostProcessLeader | null {
  const text = stdout.trim();
  if (text === "") return null;
  const match = /^(\d+)\s+(\S.*)$/.exec(text);
  if (match === null) throw new Error("ps_unparseable");
  const pgid = Number(match[1]);
  const start = (match[2] ?? "").replace(/\s+/g, " ").trim();
  if (!Number.isSafeInteger(pgid) || pgid < 1 || !isWellFormedLeaderStart(start)) throw new Error("ps_unparseable");
  return { pgid, start };
}

/** `/proc/<pid>/stat` to leader observation. comm may contain spaces and parentheses; fields after the last ')' start at state. */
export function parseProcStat(stat: string, pid: number): HostProcessLeader {
  const close = stat.lastIndexOf(")");
  if (close < 0 || Number(stat.slice(0, stat.indexOf(" "))) !== pid) throw new Error("proc_stat_unparseable");
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const pgid = Number(fields[2]);
  const start = fields[19];
  if (!Number.isSafeInteger(pgid) || pgid < 1 || start === undefined || !/^\d+$/.test(start)) throw new Error("proc_stat_unparseable");
  return { pgid, start };
}

// ---------------------------------------------------------------------------------------------
// Real probe (macOS + Linux)
// ---------------------------------------------------------------------------------------------

const PS_ENV = { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" } as const;

function run(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...PS_ENV } },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") return resolve({ code, stdout, stderr });
        reject(error);
      },
    );
  });
}

function lsofBinary(): string {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new HolderScanUnavailableError("lsof_missing");
}

export function currentBootSession(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    if (platform === "darwin") {
      return (
        execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() ||
        null
      );
    }
  } catch {
    /* unreadable */
  }
  return null;
}

export function processGroupPresent(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new RangeError("invalid_pgid");
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

export async function readLeader(pid: number, platform: NodeJS.Platform = process.platform): Promise<HostProcessLeader | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError("invalid_pid");
  if (platform === "linux") {
    try {
      return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return null;
      throw error;
    }
  }
  const result = await run("/bin/ps", ["-o", "pgid=,lstart=", "-p", String(pid)], 3000);
  if (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return null;
  if (result.code !== 0 || result.stderr.trim() !== "") throw new Error(`ps_failed_${String(result.code)}`);
  return parsePsLeader(result.stdout);
}

function sameMarker(marker: HostProcessMarker, st: { dev: number | bigint; ino: number | bigint; isFile(): boolean }): boolean {
  if (!st.isFile()) return false;
  const dev = parseId(marker.dev);
  const ino = parseId(marker.ino);
  return dev !== null && ino !== null && normalizeDev(BigInt(st.dev)) === normalizeDev(dev) && BigInt(st.ino) === ino;
}

/**
 * lsof holder scan with the design 5.3 positive control. Returns holder pids (diagnostic only; never signal them).
 * Throws HolderScanUnavailableError when the control fails.
 */
export async function scanMarkerHolders(marker: HostProcessMarker): Promise<number[]> {
  const markerDev = parseId(marker.dev);
  const markerIno = parseId(marker.ino);
  if (markerDev === null || markerIno === null) throw new HolderScanUnavailableError("marker_identity_invalid");
  const controlPath = join(dirname(marker.path), `.lsof-control-${process.pid}-${randomBytes(6).toString("hex")}`);
  let controlFd: number | null = null;
  let markerFd: number | null = null;
  try {
    // Open the marker ourselves first and pin its identity: lsof then has to find this very inode through the path.
    markerFd = openSync(marker.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!sameMarker(marker, fstatSync(markerFd, { bigint: true }))) throw new HolderScanUnavailableError("marker_replaced");
    controlFd = openSync(controlPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    const control = fstatSync(controlFd, { bigint: true });
    const result = await run(lsofBinary(), ["-n", "-P", "-F", "pfDi", "--", marker.path, controlPath], 8000);
    return interpretLsof(result, { dev: markerDev, ino: markerIno }, { dev: control.dev, ino: control.ino }, process.pid).holders;
  } catch (error) {
    if (error instanceof HolderScanUnavailableError) throw error;
    throw new HolderScanUnavailableError(error instanceof Error ? error.message : "lsof_failed");
  } finally {
    if (markerFd !== null) closeSync(markerFd);
    if (controlFd !== null) closeSync(controlFd);
    try {
      unlinkSync(controlPath);
    } catch {
      /* control may never have been created */
    }
  }
}

export function createHostProcessProbe(options: { platform?: NodeJS.Platform } = {}): HostProcessProbe {
  const platform = options.platform ?? process.platform;
  return {
    bootSession: () => currentBootSession(platform),
    groupPresent: (pgid) => processGroupPresent(pgid),
    leader: (pid) => readLeader(pid, platform),
    markerIdentity(marker) {
      try {
        const st = lstatSync(marker.path, { bigint: true });
        return sameMarker(marker, st) ? "ok" : "lost";
      } catch {
        return "lost";
      }
    },
    async markerHeld(marker) {
      return (await scanMarkerHolders(marker)).length > 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Classifier (design 5.2)
// ---------------------------------------------------------------------------------------------

export interface HostProcessRecord {
  op_id: string;
  state: "launching" | "registered" | "released" | "stopped";
  pid: number | null;
  pgid: number | null;
  leader_start: string | null;
  boot_id: string;
  marker: HostProcessMarker;
}

export type HostProcessClassification =
  | { kind: "stopped"; proof: HostStopProof; detail: Record<string, unknown> }
  | { kind: "unknown"; reason: HostProcessUnknownReason; detail: Record<string, unknown> };

export interface ClassifyOptions {
  /** Maximum wait for rules 4 and 8 (default 5 s). */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Step = HostProcessClassification | { kind: "pending"; reason: HostProcessUnknownReason; detail: Record<string, unknown> };

/**
 * Decide whether the process behind one open ledger row is provably stopped. Observes only; never signals.
 * Rule numbers in comments refer to design section 5.2.
 */
export async function classifyHostProcess(
  record: HostProcessRecord,
  probe: HostProcessProbe,
  options: ClassifyOptions = {},
): Promise<HostProcessClassification> {
  const waitMs = options.waitMs ?? HOST_PROCESS_EOF_WAIT_MS;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  for (;;) {
    let step: Step;
    try {
      step = await evaluateOnce(record, probe);
    } catch (error) {
      if (error instanceof HolderScanUnavailableError) {
        return { kind: "unknown", reason: "holder_scan_unavailable", detail: { error: error.message } };
      }
      return { kind: "unknown", reason: "probe_failed", detail: { error: error instanceof Error ? error.message : String(error) } };
    }
    const waited = now() - started;
    if (step.kind !== "pending") return { ...step, detail: { ...step.detail, waited_ms: waited } };
    if (waited >= waitMs) return { kind: "unknown", reason: step.reason, detail: { ...step.detail, waited_ms: waited } };
    await sleep(Math.min(pollMs, waitMs - waited));
  }
}

async function evaluateOnce(record: HostProcessRecord, probe: HostProcessProbe): Promise<Step> {
  if (record.state === "stopped") return { kind: "stopped", proof: "already_stopped", detail: {} };
  // Rule 0
  const boot = await probe.bootSession();
  if (boot !== null && boot !== "unknown" && record.boot_id !== "unknown" && boot !== record.boot_id) {
    return { kind: "stopped", proof: "rebooted", detail: { recorded_boot: record.boot_id } };
  }
  // Rule 1
  if ((await probe.markerIdentity(record.marker)) !== "ok") return { kind: "unknown", reason: "marker_lost", detail: {} };
  // Rule 2 (throws HolderScanUnavailableError, mapped by the caller)
  const held = await probe.markerHeld(record.marker);
  const launching = record.pid === null && record.pgid === null;
  if (record.state === "launching" || launching) {
    if (record.state !== "launching" || !launching) return { kind: "unknown", reason: "record_invalid", detail: { state: record.state } };
    // Rules 3 and 4
    if (!held) return { kind: "stopped", proof: "never_registered+marker_unheld", detail: {} };
    return { kind: "pending", reason: "unregistered_holder", detail: {} };
  }
  const { pgid } = record;
  if (pgid === null || record.pid === null || pgid !== record.pid || pgid <= 1) {
    return { kind: "unknown", reason: "record_invalid", detail: { state: record.state } };
  }
  // Rules 5 and 6
  if (!(await probe.groupPresent(pgid))) {
    return held
      ? { kind: "unknown", reason: "escaped_holder", detail: { group: "empty" } }
      : { kind: "stopped", proof: "group_empty+marker_unheld", detail: {} };
  }
  // The group exists. Rules 7 to 9 look at its leader.
  const leader = await probe.leader(pgid);
  if (
    leader === null ||
    leader.pgid !== pgid ||
    leader.start === null ||
    record.leader_start === null ||
    !isWellFormedLeaderStart(leader.start) ||
    !isWellFormedLeaderStart(record.leader_start)
  ) {
    return { kind: "unknown", reason: "group_present", detail: { leader: leader === null ? "absent" : "unusable" } };
  }
  if (leader.start !== record.leader_start) {
    // Rule 7: only ever evidence of "stopped", never authority to signal; still requires the marker to be unheld.
    return held
      ? { kind: "unknown", reason: "escaped_holder", detail: { leader_reused: true } }
      : { kind: "stopped", proof: "leader_reused+marker_unheld", detail: { leader_reused: true, leader_start: leader.start } };
  }
  // Rule 8: same leader (as far as second-resolution start time can tell)
  if (record.state === "registered") return { kind: "pending", reason: "group_alive", detail: {} };
  return { kind: "unknown", reason: "group_alive", detail: {} };
}

// ---------------------------------------------------------------------------------------------
// Gated launch (design 4.2)
// ---------------------------------------------------------------------------------------------

export type GatedStep = "after_launching" | "after_spawn" | "after_registered" | "after_release_commit" | "after_release_write";

export interface GatedProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  journal: HostProcessJournal;
  /** Directory for hold markers (`$OSSTACK_HOME/contained/host-processes`); created 0700. */
  markerDir: string;
  launch: Omit<HostProcessLaunchInput, "op_id" | "marker">;
  /** Synchronous write fence. Runs inside `journal.release` after registration and before the release byte. */
  fence: () => void;
  probe?: HostProcessProbe;
  /** Online stop-proof wait after the leader exits (default 2 s). */
  proofWaitMs?: number;
  /** Test seam (crash harness). Called synchronously at the named protocol points. */
  onStep?: (step: GatedStep) => void;
}

export type GatedTermination = "timeout" | "abort" | "output_limit";

export interface GatedProcessResult {
  op_id: string;
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  released: boolean;
  terminated: GatedTermination | null;
  /** null: stop could not be proven; the caller must treat the Mission as stop_unknown. */
  proof: HostStopProof | null;
  stopError?: string;
}

const MAX_STDERR_BYTES = 64 * 1024;

export function argvDigest(program: string, args: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([program, ...args])).digest("hex");
}

function prepareMarkerDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new HostProcessError("HOST_PROCESS_MARKER_DIR", "marker directory must be a private directory owned by the daemon user");
  }
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* ESRCH: already gone */
  }
}

export async function runGatedProcess(program: string, args: readonly string[], options: GatedProcessOptions): Promise<GatedProcessResult> {
  if (program === "" || program.startsWith("-") || [program, ...args].some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new HostProcessError("HOST_PROCESS_INVALID_ARGS", "program and arguments must be NUL-free strings; program must not start with '-'");
  }
  const probe = options.probe ?? createHostProcessProbe();
  const opId = `hp_${randomBytes(16).toString("hex")}`;
  const step = (name: GatedStep) => options.onStep?.(name);

  // L0
  prepareMarkerDir(options.markerDir);
  const markerPath = join(options.markerDir, `${opId}.hold`);
  let markerFd: number | null = openSync(markerPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
  let marker: HostProcessMarker;
  try {
    const markerStat = fstatSync(markerFd, { bigint: true });
    marker = { path: markerPath, dev: markerStat.dev.toString(), ino: markerStat.ino.toString() };
  } catch (error) {
    closeSync(markerFd);
    markerFd = null;
    try {
      unlinkSync(markerPath);
    } catch {
      /* nothing to remove */
    }
    throw error;
  }
  const dropMarker = () => {
    try {
      unlinkSync(markerPath);
    } catch {
      /* already removed */
    }
  };
  const closeMarkerFd = () => {
    if (markerFd !== null) {
      try {
        closeSync(markerFd);
      } catch {
        /* ignore */
      }
      markerFd = null;
    }
  };

  // L1
  try {
    options.journal.launching({ ...options.launch, op_id: opId, marker });
  } catch (error) {
    closeMarkerFd();
    dropMarker();
    throw error;
  }
  step("after_launching");

  // L2
  let child: ChildProcess;
  try {
    child = spawn(GATED_SHELL, ["-c", GATED_WRAPPER_SCRIPT, opId, program, ...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", markerFd as number],
    });
  } catch (error) {
    closeMarkerFd();
    settleNeverSpawned(options.journal, opId, dropMarker);
    throw new HostProcessError("HOST_PROCESS_SPAWN_FAILED", error instanceof Error ? error.message : "spawn threw");
  }
  closeMarkerFd();
  const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
  if (child.pid === undefined) {
    const error = await spawnError;
    settleNeverSpawned(options.journal, opId, dropMarker);
    throw new HostProcessError("HOST_PROCESS_SPAWN_FAILED", error.message);
  }
  const pid = child.pid;
  step("after_spawn");

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  let terminated: GatedTermination | null = null;
  let leaderExited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let released = false;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, sig) => {
      leaderExited = true;
      exitCode = code;
      exitSignal = sig;
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdin?.on("error", () => undefined);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > options.maxOutputBytes) return terminate("output_limit");
    stdout.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
  });
  /** Signals only while the leader has not been reaped, so neither the pid nor the group id can have been reused. */
  function terminate(reason: GatedTermination): void {
    if (terminated === null) terminated = reason;
    if (!leaderExited) killGroup(pid);
  }
  const proofWaitMs = options.proofWaitMs ?? HOST_PROCESS_ONLINE_PROOF_WAIT_MS;
  const unreleased = async (cause: unknown): Promise<never> => {
    if (!leaderExited) killGroup(pid);
    child.stdin?.end();
    await Promise.race([exited, delay(proofWaitMs)]);
    const proven = await observeStopped(probe, { pid, pgid: pid }, marker, proofWaitMs);
    if (proven.ok) {
      try {
        options.journal.stopped(opId, { proof: "never_released", detail: { ...proven.detail }, exit_code: exitCode, exit_signal: exitSignal });
        dropMarker();
      } catch {
        /* row stays open for the next owner */
      }
    }
    throw cause;
  };

  // L3
  let leaderStart: string | null = null;
  try {
    const leader = await readLeader(pid);
    if (leader !== null) {
      if (leader.pgid !== pid) throw new HostProcessError("HOST_PROCESS_IDENTITY", "child is not its own process group leader");
      leaderStart = leader.start;
    }
  } catch (error) {
    if (error instanceof HostProcessError) return unreleased(error);
    leaderStart = null;
  }

  // L4
  try {
    options.journal.registered(opId, { pid, pgid: pid, leader_start: leaderStart });
  } catch (error) {
    return unreleased(error);
  }
  step("after_registered");
  if (options.signal?.aborted) return unreleased(new HostProcessError("HOST_PROCESS_ABORTED", "aborted before release"));

  // L5 and L6 share one synchronous call chain: nothing may await between the fence and the release byte.
  try {
    options.journal.release(opId, options.fence);
  } catch (error) {
    return unreleased(error);
  }
  released = true;
  step("after_release_commit");
  child.stdin?.write(`${opId}\n`);
  child.stdin?.end();
  step("after_release_write");

  // L7
  const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
  const onAbort = () => terminate("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  await exited;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", onAbort);
  // A grandchild holding stdout open must not block us forever; leave it to the proof below.
  await Promise.race([closed, delay(1000)]);
  child.stdout?.destroy();
  child.stderr?.destroy();

  // L8: observe only, never signal
  const proven = await observeStopped(probe, { pid, pgid: pid }, marker, proofWaitMs);
  const result: GatedProcessResult = {
    op_id: opId,
    stdout: Buffer.concat(stdout),
    stderr,
    exitCode,
    signal: exitSignal,
    released,
    terminated,
    proof: null,
  };
  if (!proven.ok) return result;
  try {
    options.journal.stopped(opId, { proof: "group_empty+marker_unheld", detail: { ...proven.detail }, exit_code: exitCode, exit_signal: exitSignal });
    dropMarker();
    result.proof = "group_empty+marker_unheld";
  } catch (error) {
    result.stopError = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function settleNeverSpawned(journal: HostProcessJournal, opId: string, dropMarker: () => void): void {
  try {
    journal.stopped(opId, { proof: "never_spawned", detail: {} });
    dropMarker();
  } catch {
    /* row stays `launching`; recovery proves it from the marker */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Online variant of rules 5/6: group empty and marker unheld, polled until `waitMs`. */
export async function observeStopped(
  probe: HostProcessProbe,
  identity: { pid: number; pgid: number },
  marker: HostProcessMarker,
  waitMs: number,
): Promise<{ ok: true; detail: Record<string, unknown> } | { ok: false; detail: Record<string, unknown> }> {
  const deadline = Date.now() + waitMs;
  let last: Record<string, unknown> = {};
  for (;;) {
    try {
      const groupPresent = await probe.groupPresent(identity.pgid);
      if (!groupPresent) {
        const markerOk = (await probe.markerIdentity(marker)) === "ok";
        const held = markerOk ? await probe.markerHeld(marker) : true;
        last = { group_present: false, marker_ok: markerOk, marker_held: held };
        if (markerOk && !held) return { ok: true, detail: { ...last, waited_ms: waitMs - Math.max(0, deadline - Date.now()) } };
      } else {
        last = { group_present: true };
      }
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    if (Date.now() >= deadline) return { ok: false, detail: last };
    await delay(50);
  }
}
