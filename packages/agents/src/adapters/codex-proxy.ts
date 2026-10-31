// Codex in proxy mode for contained Missions (W11 §5): read-only sandbox, the
// proposed patch through `-o`, an isolated HOME/CODEX_HOME, its own process
// group, and a host-run qualification probe. Verified on codex-cli 0.160.1 (§5.7).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export const CODEX_PROXY_PATCH_MAX_BYTES = 256 * 1024;
export const CODEX_PROXY_END_MARKER = "END-OF-PATCH";
const OUTPUT_LIMIT = 1024 * 1024;
const PASS_ENV = /^(PATH|LANG|LC_[A-Z_]+|TZ)$/;

export interface CodexProxyOptions {
  /** Codex launcher to execute, e.g. /opt/homebrew/bin/codex. */
  bin: string;
  /** File whose digest identifies the build; for npm installs this is the vendored native binary, not the Node launcher. */
  identityBinary?: string;
  /** Source of the login copied into each isolated CODEX_HOME. Only auth.json is copied. */
  sourceCodexHome: string;
  /** Per-Mission runtime directory under the scratch root; created if missing. */
  runtimeDir: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  /** Extra variable names to pass through unchanged, for executor auth only. */
  passEnv?: readonly string[];
  timeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL when stopping the group. */
  terminationGraceMs?: number;
  /** TCP target for the network probe; the host first connects to it unsandboxed as a control. */
  probeTarget?: { host: string; port: number };
}
export interface CodexProxyLaunch { pid: number; pgid: number; started_at: number }
export interface CodexProxyStopEvidence { stop_proof: "group_empty+sandbox_inherited"; pgid: number; signals: NodeJS.Signals[]; confirmed_at: number }
export type CodexProxyPatch =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: "PATCH_MISSING" | "PATCH_TOO_LARGE" | "PATCH_NOT_UTF8" | "PATCH_INCOMPLETE" };
export interface CodexProxyRun {
  launch: CodexProxyLaunch; exit_code: number | null; signal: NodeJS.Signals | null; timed_out: boolean; cancelled: boolean;
  /** Present only when the whole process group was proven gone. */
  stop?: CodexProxyStopEvidence;
  patch: CodexProxyPatch; stdout: string; stderr: string; stdout_truncated: boolean; stderr_truncated: boolean;
}
export interface CodexProxyRunInput {
  worktree: string; prompt: string; signal?: AbortSignal;
  /** Called after spawn, before any output is read, so the host can journal the group (§9). */
  onLaunched?: (launch: CodexProxyLaunch) => void;
}
export type CodexProbeOperation = "write_worktree" | "write_outside" | "write_gitdir" | "network";
export interface CodexQualification {
  qualified: boolean; version: string; identity_sha256: string | null; profile: ":read-only";
  /** Each operation must be denied for both the probe process and a descendant that left its process group. */
  results: Record<"parent" | "escaped_child", Record<CodexProbeOperation, "denied" | "allowed" | "inconclusive" | "missing">>;
  host_observed_writes: string[]; reasons: string[];
}

/** Host-side Codex proxy executor. It never writes into the worktree; the patch is data for the host classifier. */
export class CodexProxyExecutor {
  private readonly options: Required<Pick<CodexProxyOptions, "timeoutMs" | "terminationGraceMs">> & CodexProxyOptions;
  constructor(options: CodexProxyOptions) {
    if (!options.bin || !options.sourceCodexHome || !options.runtimeDir) throw Error("codex_proxy_config_invalid");
    this.options = { timeoutMs: 600_000, terminationGraceMs: 2_000, ...options };
  }

  /** Read-only argv for one proposal turn. Explicit `-s` overrides any repository config (§5.7). */
  args(worktree: string, outputFile: string, prompt: string): string[] {
    return ["exec", "-s", "read-only", "-C", worktree, "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "-o", outputFile,
      ...(this.options.model ? ["-c", `model=${JSON.stringify(this.options.model)}`] : []),
      ...(this.options.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(this.options.reasoningEffort)}`] : []),
      prompt];
  }

  /** Fresh HOME and CODEX_HOME holding only a copied auth.json; never links to the user's home. */
  isolatedEnv(): NodeJS.ProcessEnv {
    const home = join(this.options.runtimeDir, "home"); const codexHome = join(this.options.runtimeDir, "codex-home");
    rmSync(home, { recursive: true, force: true }); rmSync(codexHome, { recursive: true, force: true });
    mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const auth = join(this.options.sourceCodexHome, "auth.json");
    if (existsSync(auth)) copyFileSync(auth, join(codexHome, "auth.json"));
    const env: NodeJS.ProcessEnv = {};
    const extra = new Set(this.options.passEnv ?? []);
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && (PASS_ENV.test(key) || extra.has(key))) env[key] = value;
    env["HOME"] = home; env["CODEX_HOME"] = codexHome;
    return env;
  }

  async run(input: CodexProxyRunInput): Promise<CodexProxyRun> {
    const outputFile = join(this.options.runtimeDir, "last-message.txt");
    mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    rmSync(outputFile, { force: true });
    const env = this.isolatedEnv();
    const result = await runGroup(this.options.bin, this.args(input.worktree, outputFile, input.prompt), {
      cwd: input.worktree, env, timeoutMs: this.options.timeoutMs, graceMs: this.options.terminationGraceMs,
      ...(input.signal ? { signal: input.signal } : {}), ...(input.onLaunched ? { onLaunched: input.onLaunched } : {}),
    });
    return { ...result, patch: readCodexProxyPatch(outputFile) };
  }

  /** Host-run probe through Codex's own sandbox entry; no model is involved (§5.5). */
  async qualify(worktree: string, gitDir: string): Promise<CodexQualification> {
    const reasons: string[] = [];
    const version = (await runGroup(this.options.bin, ["--version"], { cwd: worktree, env: this.isolatedEnv(), timeoutMs: 15_000, graceMs: 500 })).stdout.trim();
    if (!version) reasons.push("VERSION_UNAVAILABLE");
    const identity = this.options.identityBinary ?? nativeCodexBinary(resolveExecutable(this.options.bin));
    let identitySha: string | null = null;
    try {
      const bytes = readFileSync(realpathSync(identity ?? ""));
      // A script launcher can stay unchanged while the build it starts is replaced; it is not an identity.
      if (bytes.subarray(0, 2).toString() === "#!" || /\.(?:c|m)?js$/.test(identity!)) reasons.push("IDENTITY_LAUNCHER_ONLY");
      else identitySha = createHash("sha256").update(bytes).digest("hex");
    } catch { reasons.push("IDENTITY_UNREADABLE"); }
    const target = this.options.probeTarget ?? { host: "1.1.1.1", port: 443 };
    // Without host connectivity a denied connection proves nothing about the sandbox.
    if (!(await reachable(target))) reasons.push("NETWORK_CONTROL_UNREACHABLE");
    const probeDir = join(this.options.runtimeDir, `probe-${randomBytes(6).toString("hex")}`);
    const outside = join(probeDir, "outside"); mkdirSync(outside, { recursive: true, mode: 0o700 });
    const script = join(probeDir, "probe.mjs"); writeFileSync(script, PROBE_SOURCE, { mode: 0o600 });
    const tag = randomBytes(6).toString("hex");
    // Unsandboxed write controls: a target the host itself cannot write proves nothing when the sandbox denies it.
    for (const [name, dir] of [["WORKTREE", worktree], ["OUTSIDE", outside], ["GITDIR", gitDir]] as const) {
      const control = join(dir, `probe-control-${tag}`);
      try { writeFileSync(control, "x"); rmSync(control); } catch { reasons.push(`${name}_CONTROL_UNWRITABLE`); }
    }
    const before = snapshot([worktree, outside, gitDir]);
    const run = await runGroup(this.options.bin, ["sandbox", "-P", ":read-only", "-C", worktree, "--", process.execPath, script, worktree, outside, gitDir, tag, target.host, String(target.port)], {
      cwd: worktree, env: this.isolatedEnv(), timeoutMs: 60_000, graceMs: 1_000,
    });
    const after = snapshot([worktree, outside, gitDir]);
    const written = [...after].filter(path => !before.has(path) && path.includes(tag));
    const results = parseProbe(run.stdout);
    for (const who of ["parent", "escaped_child"] as const)
      for (const op of OPERATIONS) if (results[who][op] !== "denied") reasons.push(`${who.toUpperCase()}_${op.toUpperCase()}_${results[who][op].toUpperCase()}`);
    if (written.length > 0) reasons.push("HOST_OBSERVED_WRITE");
    if (!run.stop) reasons.push("PROBE_GROUP_NOT_STOPPED");
    rmSync(probeDir, { recursive: true, force: true });
    for (const path of written) rmSync(path, { force: true });
    return { qualified: reasons.length === 0, version, identity_sha256: identitySha, profile: ":read-only", results, host_observed_writes: written, reasons };
  }
}

/** Lossless `-o` channel check (§5.3): bounded, valid UTF-8, last non-empty line is the end marker; EOF may follow it directly. */
export function readCodexProxyPatch(path: string, marker = CODEX_PROXY_END_MARKER): CodexProxyPatch {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return { ok: false, reason: "PATCH_MISSING" }; }
  const buffer = Buffer.alloc(CODEX_PROXY_PATCH_MAX_BYTES + 1); let length = 0;
  try {
    for (let n = 1; n > 0 && length < buffer.length; length += n) n = readSync(fd, buffer, length, buffer.length - length, null);
  } finally { closeSync(fd); }
  if (length > CODEX_PROXY_PATCH_MAX_BYTES) return { ok: false, reason: "PATCH_TOO_LARGE" };
  const bytes = buffer.subarray(0, length);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, reason: "PATCH_NOT_UTF8" }; }
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length === 0 || lines[lines.length - 1]!.trim() !== marker) return { ok: false, reason: "PATCH_INCOMPLETE" };
  lines.pop();
  return { ok: true, text: lines.length > 0 ? `${lines.join("\n")}\n` : "", bytes: bytes.length };
}

/** True only when no process remains in the group; EPERM means one exists under another user. */
export function processGroupEmpty(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw Error("invalid_pgid");
  try { process.kill(-pgid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

interface GroupOptions {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; graceMs: number; signal?: AbortSignal;
  onLaunched?: (launch: CodexProxyLaunch) => void;
}
async function runGroup(bin: string, args: string[], options: GroupOptions): Promise<Omit<CodexProxyRun, "patch">> {
  // detached: the child leads a new session and process group, so the group can be signalled and inspected as a whole.
  const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const out = capture(); const err = capture();
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk)); child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const spawned = await new Promise<number | Error>(resolve => {
    child.once("spawn", () => resolve(child.pid!)); child.once("error", error => resolve(error));
  });
  if (spawned instanceof Error) throw Error(`codex_proxy_spawn_failed: ${spawned.message}`);
  const launch = { pid: spawned, pgid: spawned, started_at: Date.now() };
  const signals: NodeJS.Signals[] = [];
  const kill = (signal: NodeJS.Signals) => { signals.push(signal); try { process.kill(-launch.pgid, signal); } catch { /* ESRCH: proven by processGroupEmpty below */ } };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try { options.onLaunched?.(launch); } catch (error) {
    // The host could not journal the launch: do not leave an unrecorded executor running.
    kill("SIGTERM"); if (!(await waitEmpty(launch.pgid, options.graceMs))) { kill("SIGKILL"); await waitEmpty(launch.pgid, options.graceMs); }
    child.stdout.destroy(); child.stderr.destroy();
    throw error;
  }
  let timedOut = false; let cancelled = false;
  const stop = () => { kill("SIGTERM"); setTimeout(() => { if (!processGroupEmpty(launch.pgid)) kill("SIGKILL"); }, options.graceMs).unref(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs); timer.unref();
  const onAbort = () => { cancelled = true; stop(); };
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
  // Wait for the leader's exit, not for its pipes: a descendant that inherited them could hold close open.
  const exit = await exited;
  clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
  // The leader has exited; give remaining members a grace period, then kill and re-check the group.
  let empty = await waitEmpty(launch.pgid, options.graceMs);
  if (!empty) { kill("SIGTERM"); empty = await waitEmpty(launch.pgid, options.graceMs); }
  if (!empty) { kill("SIGKILL"); empty = await waitEmpty(launch.pgid, options.graceMs); }
  const drained = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), options.graceMs).unref())]);
  if (!drained) { child.stdout.destroy(); child.stderr.destroy(); }
  return {
    launch, exit_code: exit.code, signal: exit.signal, timed_out: timedOut, cancelled,
    ...(empty ? { stop: { stop_proof: "group_empty+sandbox_inherited" as const, pgid: launch.pgid, signals, confirmed_at: Date.now() } } : {}),
    stdout: out.text(), stderr: err.text(), stdout_truncated: out.truncated(), stderr_truncated: err.truncated(),
  };
}
async function waitEmpty(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!processGroupEmpty(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}
function capture() {
  const chunks: Buffer[] = []; let size = 0; let cut = false;
  return {
    push(chunk: Buffer) { if (size >= OUTPUT_LIMIT) { cut = true; return; } const part = chunk.subarray(0, OUTPUT_LIMIT - size); if (part.length < chunk.length) cut = true; chunks.push(part); size += part.length; },
    text: () => Buffer.concat(chunks).toString("utf8"), truncated: () => cut,
  };
}

const OPERATIONS: readonly CodexProbeOperation[] = ["write_worktree", "write_outside", "write_gitdir", "network"];
function parseProbe(stdout: string): CodexQualification["results"] {
  const missing = Object.fromEntries(OPERATIONS.map(op => [op, "missing"])) as Record<CodexProbeOperation, "missing">;
  const results: CodexQualification["results"] = { parent: { ...missing }, escaped_child: { ...missing } };
  for (const line of stdout.split("\n")) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const { who, ...ops } = row as Record<string, unknown>;
    if (who !== "parent" && who !== "escaped_child") continue;
    for (const op of OPERATIONS) if (ops[op] === "denied" || ops[op] === "allowed" || ops[op] === "inconclusive") results[who][op] = ops[op];
  }
  return results;
}
/** npm installs start a Node launcher; the build identity is the vendored native binary beside it. */
function nativeCodexBinary(launcher: string | undefined): string | undefined {
  if (!launcher) return undefined;
  let real: string;
  try { real = realpathSync(launcher); } catch { return launcher; }
  if (!/\/@openai\/codex\/bin\/codex\.js$/.test(real)) return real;
  const vendor = join(dirname(dirname(real)), "node_modules", "@openai");
  try {
    for (const pkg of readdirSync(vendor).filter(name => name.startsWith("codex-")).sort())
      for (const triple of readdirSync(join(vendor, pkg, "vendor"))) {
        const candidate = join(vendor, pkg, "vendor", triple, "bin", "codex");
        if (existsSync(candidate)) return candidate;
      }
  } catch { /* fall through to the launcher, which is then refused as an identity */ }
  return real;
}
function resolveExecutable(bin: string): string | undefined {
  if (bin.includes("/")) return isAbsolute(bin) ? bin : join(process.cwd(), bin);
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(dir, bin);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return undefined;
}
function reachable(target: { host: string; port: number }): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: target.host, port: target.port, timeout: 3_000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}
function snapshot(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const path = join(dir, name); seen.add(path);
      try { if (depth < 2 && statSync(path).isDirectory() && name !== "objects") walk(path, depth + 1); } catch { /* raced */ }
    }
  };
  for (const root of roots) walk(root, 0);
  return seen;
}

// Runs inside the sandbox under the host's own Node, never from the repository.
// The escaped child is spawned detached (setsid), so it is outside the probe's process group.
const PROBE_SOURCE = `
import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; import { connect } from "node:net"; import { join } from "node:path";
const [wt, outside, gitDir, tag, host, port, role] = process.argv.slice(2);
// Only permission errors are sandbox denial; any other failure is inconclusive.
const tryWrite = p => { try { writeFileSync(p, "x"); return "allowed"; } catch (e) { return ["EPERM", "EACCES", "EROFS"].includes(e.code) ? "denied" : "inconclusive"; } };
// Only a permission error is sandbox denial; timeouts and unreachable hosts prove nothing.
const tryNet = () => new Promise(r => { const s = connect({ host, port: Number(port), timeout: 3000 }); s.once("connect", () => { s.destroy(); r("allowed"); }); s.once("error", e => r(e.code === "EPERM" || e.code === "EACCES" ? "denied" : "inconclusive")); s.once("timeout", () => { s.destroy(); r("inconclusive"); }); });
const run = async who => JSON.stringify({ who,
  write_worktree: tryWrite(join(wt, "probe-" + who + "-" + tag)), write_outside: tryWrite(join(outside, "probe-" + who + "-" + tag)),
  write_gitdir: tryWrite(join(gitDir, "probe-" + who + "-" + tag)), network: await tryNet() });
if (role === "child") { process.stdout.write(await run("escaped_child") + "\\n"); }
else {
  process.stdout.write(await run("parent") + "\\n");
  const c = spawn(process.execPath, [process.argv[1], wt, outside, gitDir, tag, host, port, "child"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  c.stdout.pipe(process.stdout); await new Promise(r => c.once("close", r));
}
`;
