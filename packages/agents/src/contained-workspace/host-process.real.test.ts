/**
 * W13-B on-machine tests: real /bin/sh, real pipes, real fds, real ps and lsof. Needs a POSIX host with lsof
 * (macOS or Linux). Each case is kept to a few seconds; the ones that wait on a live process are marked slow.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDir } from "@osstack/core";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HardenedGitError, runHardenedGit } from "./hardened-git.js";
import {
  argvDigest,
  classifyHostProcess,
  createHostProcessProbe,
  currentBootSession,
  GATED_EXIT_BAD_RELEASE,
  GATED_EXIT_EOF_BEFORE_RELEASE,
  GATED_SHELL,
  GATED_WRAPPER_SCRIPT,
  HolderScanUnavailableError,
  type HostProcessJournal,
  type HostProcessLaunchInput,
  type HostProcessOutcome,
  type HostProcessRecord,
  processGroupPresent,
  readLeader,
  runGatedProcess,
  scanMarkerHolders,
} from "./host-process.js";

const SLOW = 15_000;
let dir: string;
let markerDir: string;

beforeAll(async () => {
  dir = await createScratchDir("tests", "host-process");
  markerDir = join(dir, "host-processes");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("waitFor timeout");
    await sleep(20);
  }
};

interface Recording extends HostProcessJournal {
  events: string[];
  launched?: HostProcessLaunchInput;
  identity?: { pid: number; pgid: number; leader_start: string | null };
  outcome?: HostProcessOutcome;
}
function journal(options: { failRelease?: Error } = {}): Recording {
  const j: Recording = {
    events: [],
    launching(input) {
      j.events.push("launching");
      j.launched = input;
    },
    registered(_id, identity) {
      j.events.push("registered");
      j.identity = identity;
    },
    release(_id, fence) {
      j.events.push("release:fence");
      fence();
      if (options.failRelease) throw options.failRelease;
      j.events.push("release:committed");
    },
    stopped(_id, outcome) {
      j.events.push(`stopped:${outcome.proof}`);
      j.outcome = outcome;
    },
  };
  return j;
}
const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...extra });
const launch = (program: string, args: string[]) => ({
  mission_id: "m1",
  kind: "git_update_ref" as const,
  local_target: "repo#refs/heads/x",
  argv_digest: argvDigest(program, args),
  boot_id: currentBootSession() ?? "unknown",
});
function run(j: Recording, program: string, args: string[], extra: { fence?: () => void; env?: NodeJS.ProcessEnv; proofWaitMs?: number; timeoutMs?: number } = {}) {
  return runGatedProcess(program, args, {
    cwd: dir,
    env: extra.env ?? baseEnv(),
    timeoutMs: extra.timeoutMs ?? 10_000,
    maxOutputBytes: 1 << 20,
    journal: j,
    markerDir,
    launch: launch(program, args),
    fence: extra.fence ?? (() => undefined),
    proofWaitMs: extra.proofWaitMs ?? 2000,
  });
}
const record = (j: Recording, state: HostProcessRecord["state"]): HostProcessRecord => {
  const launched = j.launched;
  if (launched === undefined) throw new Error("not launched");
  return {
    op_id: launched.op_id,
    state,
    pid: j.identity?.pid ?? null,
    pgid: j.identity?.pgid ?? null,
    leader_start: j.identity?.leader_start ?? null,
    boot_id: launched.boot_id,
    marker: launched.marker,
  };
};

describe("gated wrapper (T1, T2)", () => {
  it("never runs the command when the parent closes stdin before release", async () => {
    const sentinel = join(dir, "eof-sentinel");
    const child = spawn(GATED_SHELL, ["-c", GATED_WRAPPER_SCRIPT, "hp_x", "/bin/sh", "-c", `touch ${sentinel}`], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    expect(code).toBe(GATED_EXIT_EOF_BEFORE_RELEASE);
    await sleep(100);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("never runs the command on a partial line without a newline, or on the wrong op id", async () => {
    for (const [payload, expected] of [
      ["hp_x", GATED_EXIT_EOF_BEFORE_RELEASE],
      ["hp_other\n", GATED_EXIT_BAD_RELEASE],
      ["\n", GATED_EXIT_BAD_RELEASE],
    ] as const) {
      const sentinel = join(dir, `bad-sentinel-${expected}-${payload.length}`);
      const child = spawn(GATED_SHELL, ["-c", GATED_WRAPPER_SCRIPT, "hp_x", "/bin/sh", "-c", `touch ${sentinel}`], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(payload);
      const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
      expect(code).toBe(expected);
      expect(existsSync(sentinel)).toBe(false);
    }
  });

  it("does not interpret shell metacharacters in the program or arguments", async () => {
    const sentinel = join(dir, "inject-sentinel");
    const j = journal();
    const result = await run(j, "/bin/echo", [`$(touch ${sentinel})`, "`touch " + sentinel + "`", `; touch ${sentinel}`, "a b\nc"]);
    expect(result.stdout.toString()).toBe(`$(touch ${sentinel}) \`touch ${sentinel}\` ; touch ${sentinel} a b\nc\n`);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects a program that could be parsed as an option, or NUL bytes", async () => {
    const j = journal();
    await expect(run(j, "-c", [])).rejects.toThrow(/HOST_PROCESS_INVALID_ARGS/);
    await expect(run(j, "/bin/echo", ["a\0b"])).rejects.toThrow(/HOST_PROCESS_INVALID_ARGS/);
    expect(j.events).toEqual([]);
  });

  it("T1: registers, fences, releases, runs, passes output through, proves the stop and removes the marker", async () => {
    const j = journal();
    const sentinel = join(dir, "t1-sentinel");
    let fenced = false;
    const result = await run(j, "/bin/sh", ["-c", `echo out; echo err >&2; touch ${sentinel}; exit 3`], {
      fence: () => {
        fenced = true;
        expect(j.events).toEqual(["launching", "registered", "release:fence"]);
      },
    });
    expect(fenced).toBe(true);
    expect(j.events).toEqual(["launching", "registered", "release:fence", "release:committed", "stopped:group_empty+marker_unheld"]);
    expect(result).toMatchObject({ exitCode: 3, signal: null, released: true, terminated: null, proof: "group_empty+marker_unheld" });
    expect(result.stdout.toString()).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(j.launched?.marker.path ?? "")).toBe(false);
    expect(j.identity?.pgid).toBe(j.identity?.pid);
    expect(j.identity?.leader_start).toEqual(expect.any(String));
    expect(j.outcome).toMatchObject({ exit_code: 3, exit_signal: null });
  });

  it("T2: a throwing fence means the command never starts, the process group is stopped and the fence error surfaces", async () => {
    const j = journal();
    const sentinel = join(dir, "t2-sentinel");
    await expect(
      run(j, "/bin/sh", ["-c", `touch ${sentinel}`], {
        fence: () => {
          throw new Error("fence_denied");
        },
      }),
    ).rejects.toThrow("fence_denied");
    await sleep(100);
    expect(existsSync(sentinel)).toBe(false);
    expect(j.events).toEqual(["launching", "registered", "release:fence", "stopped:never_released"]);
    expect(existsSync(j.launched?.marker.path ?? "")).toBe(false);
  });

  it("a release that fails to commit leaves the command unrun", async () => {
    const j = journal({ failRelease: new Error("stale_owner") });
    const sentinel = join(dir, "stale-sentinel");
    await expect(run(j, "/bin/sh", ["-c", `touch ${sentinel}`])).rejects.toThrow("stale_owner");
    await sleep(100);
    expect(existsSync(sentinel)).toBe(false);
    expect(j.events.at(-1)).toBe("stopped:never_released");
  });

  it("a journal that refuses launching leaves no marker and no process", async () => {
    const before = existsSync(markerDir) ? readdirCount(markerDir) : 0;
    const j = journal();
    j.launching = () => {
      throw new Error("host_process_launch_denied");
    };
    await expect(run(j, "/bin/echo", ["x"])).rejects.toThrow("host_process_launch_denied");
    expect(readdirCount(markerDir)).toBe(before);
  });

  it("timeout kills a running released command's group and still proves the stop", { timeout: SLOW }, async () => {
    const j = journal();
    const result = await run(j, "/bin/sh", ["-c", "sleep 30 & wait"], { timeoutMs: 300 });
    expect(result.terminated).toBe("timeout");
    expect(result.proof).toBe("group_empty+marker_unheld");
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it("abort before release is a distinct error and never runs the command", async () => {
    const j = journal();
    const sentinel = join(dir, "abort-sentinel");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGatedProcess("/bin/sh", ["-c", `touch ${sentinel}`], {
        cwd: dir,
        env: baseEnv(),
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        signal: controller.signal,
        journal: j,
        markerDir,
        launch: launch("/bin/sh", []),
        fence: () => undefined,
      }),
    ).rejects.toThrow(/HOST_PROCESS_ABORTED/);
    await sleep(100);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("spawn failure (missing cwd) records never_spawned and removes the marker", async () => {
    const j = journal();
    await expect(
      runGatedProcess("/bin/echo", ["x"], {
        cwd: join(dir, "does-not-exist"),
        env: baseEnv(),
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        journal: j,
        markerDir,
        launch: launch("/bin/echo", ["x"]),
        fence: () => undefined,
      }),
    ).rejects.toThrow(/HOST_PROCESS_SPAWN_FAILED/);
    expect(j.events).toEqual(["launching", "stopped:never_spawned"]);
    expect(existsSync(j.launched?.marker.path ?? "")).toBe(false);
  });

  it("refuses a marker directory that is group or world accessible", async () => {
    const loose = join(dir, "loose");
    mkdirSync(loose, { mode: 0o777 });
    spawnSync("chmod", ["777", loose]);
    await expect(
      runGatedProcess("/bin/echo", [], {
        cwd: dir,
        env: baseEnv(),
        timeoutMs: 1000,
        maxOutputBytes: 10,
        journal: journal(),
        markerDir: loose,
        launch: launch("/bin/echo", []),
        fence: () => undefined,
      }),
    ).rejects.toThrow(/HOST_PROCESS_MARKER_DIR/);
  });
});

// `stat -L -f %i /dev/fd/3` is BSD stat; the lsof based tests elsewhere in this file are portable.
describe.skipIf(process.platform !== "darwin")("fd 3 inheritance (T12 on-machine probe, no network)", () => {
  /** Writes "<inode of fd 3> <own pgid>" to $1. Runs inside whatever process tree the gated command builds. */
  const probeScript = () => {
    const path = join(dir, "fd-probe.sh");
    writeFileSync(path, '#!/bin/sh\necho "$(stat -L -f %i /dev/fd/3) $(ps -o pgid= -p $$ | tr -d \' \')" > "$1"\n', { mode: 0o755 });
    return path;
  };
  const read = (out: string, name: string) => (existsSync(join(out, name)) ? readFileSync(join(out, name), "utf8").trim() : null);
  const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

  it("the gated child, its grandchildren, git alias children and gh alias children hold the marker inside the registered group", { timeout: SLOW }, async () => {
    const out = join(dir, "fd-out");
    mkdirSync(out);
    const probe = probeScript();
    const script = join(dir, "fd-run.sh");
    writeFileSync(
      script,
      [
        'sh "$PROBE" "$OUT/self"',
        '( sh "$PROBE" "$OUT/grandchild" )',
        'git --version > "$OUT/gitver"',
        `git -c 'alias.chk=!sh "$PROBE" "$OUT/git"' chk`,
        'gh --version > "$OUT/ghver"',
        'export GH_CONFIG_DIR="$OUT/ghcfg" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1',
        'mkdir -p "$GH_CONFIG_DIR"',
        'gh alias set --shell chk \'sh "$PROBE" "$OUT/gh"\' > "$OUT/ghalias" 2>&1 && gh chk > "$OUT/ghrun" 2>&1',
        "",
      ].join("\n"),
    );
    const j = journal();
    const result = await run(j, "/bin/sh", [script], { env: baseEnv({ OUT: out, PROBE: probe, ...gitEnv }) });
    expect(result.exitCode).toBe(0);
    const expected = `${j.launched?.marker.ino} ${j.identity?.pgid}`;
    expect(read(out, "gitver")).toMatch(/^git version /);
    expect(read(out, "ghver")).toMatch(/^gh version /);
    for (const name of ["self", "grandchild", "git", "gh"]) expect(read(out, name), name).toBe(expected);
    expect(result.proof).toBe("group_empty+marker_unheld");
  });

  it("T12 (1): a real `git push` to a local bare repository keeps fd 3 and the group in its receive-pack child", { timeout: SLOW }, async () => {
    const out = join(dir, "push-out");
    mkdirSync(out);
    const probe = probeScript();
    const repo = join(dir, "push-work");
    const bare = join(dir, "push-bare.git");
    for (const args of [["init", "-q", "-b", "main", repo], ["init", "-q", "--bare", bare]]) {
      spawnSync("git", args, { env: { ...process.env, ...gitEnv }, stdio: "ignore" });
    }
    spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "c"], { env: { ...process.env, ...gitEnv }, stdio: "ignore" });
    const receivePack = join(dir, "receive-pack.sh");
    writeFileSync(receivePack, '#!/bin/sh\nsh "$PROBE" "$OUT/receive-pack"\nexec git receive-pack "$@"\n', { mode: 0o755 });
    const j = journal();
    const result = await runGatedProcess("git", ["-c", "protocol.file.allow=always", "push", `--receive-pack=${receivePack}`, bare, "HEAD:refs/heads/main"], {
      cwd: repo,
      env: baseEnv({ OUT: out, PROBE: probe, ...gitEnv }),
      timeoutMs: 10_000,
      maxOutputBytes: 1 << 20,
      journal: j,
      markerDir,
      launch: launch("git", []),
      fence: () => undefined,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(read(out, "receive-pack")).toBe(`${j.launched?.marker.ino} ${j.identity?.pgid}`);
    expect(result.proof).toBe("group_empty+marker_unheld");
    expect(spawnSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).status).toBe(0);
  });

  it("exec preserves pid and pgid: the registered identity is the program itself (git --version)", async () => {
    const j = journal();
    const result = await run(j, "git", ["--version"], { env: baseEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }) });
    expect(result.stdout.toString()).toMatch(/^git version /);
    expect(j.identity?.pid).toBe(j.identity?.pgid);
  });

  it("gh --version runs through the gate with no network", async () => {
    const j = journal();
    const result = await run(j, "gh", ["--version"], { env: baseEnv({ GH_CONFIG_DIR: join(dir, "gh-plain"), GH_NO_UPDATE_NOTIFIER: "1" }) });
    expect(result.stdout.toString()).toMatch(/^gh version /);
    expect(result.proof).toBe("group_empty+marker_unheld");
  });
});

describe("holders, groups and the escaped holder (T7)", () => {
  function makeMarker(name: string) {
    mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const path = join(markerDir, name);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const st = fstatSync(fd, { bigint: true });
    return { fd, marker: { path, dev: st.dev.toString(), ino: st.ino.toString() } };
  }

  it("lsof sees a child that inherited the marker as fd 3, and sees nothing once it exits", { timeout: SLOW }, async () => {
    const { fd, marker } = makeMarker("held-vs-unheld.hold");
    const probe = createHostProcessProbe();
    // This process still has the marker open: it counts as a holder (conservative).
    expect(await scanMarkerHolders(marker)).toEqual([process.pid]);
    const child = spawn("/bin/sleep", ["30"], { stdio: ["ignore", "ignore", "ignore", fd] });
    closeSync(fd);
    try {
      await sleep(100);
      expect(await probe.markerHeld(marker)).toBe(true);
      expect(await scanMarkerHolders(marker)).toEqual([child.pid]);
    } finally {
      child.kill("SIGKILL");
    }
    await new Promise((resolve) => child.once("exit", resolve));
    expect(await probe.markerHeld(marker)).toBe(false);
    expect(await probe.markerIdentity(marker)).toBe("ok");
    unlinkSync(marker.path);
    expect(await probe.markerIdentity(marker)).toBe("lost");
  });

  it("a replaced marker (same path, new inode) is lost", async () => {
    const { fd, marker } = makeMarker("replaced.hold");
    // Keep the old inode alive while the path is replaced, so the file system cannot hand the same inode
    // number to the new file (Linux ext4/tmpfs reuse it immediately after unlink).
    unlinkSync(marker.path);
    writeFileSync(marker.path, "");
    try {
      expect(await createHostProcessProbe().markerIdentity(marker)).toBe("lost");
    } finally {
      closeSync(fd);
    }
  });

  it("a marker replaced between the identity check and the scan makes the scan unavailable (never an 'unheld' answer)", async () => {
    const { fd, marker } = makeMarker("swapped.hold");
    const escaped = spawn("/bin/sleep", ["30"], { stdio: ["ignore", "ignore", "ignore", fd] });
    closeSync(fd);
    try {
      unlinkSync(marker.path);
      writeFileSync(marker.path, "");
      await expect(scanMarkerHolders(marker)).rejects.toThrow(/marker_replaced/);
    } finally {
      escaped.kill("SIGKILL");
    }
  });

  it("the lsof positive control fails closed when it cannot even create its control file", async () => {
    await expect(scanMarkerHolders({ path: join(dir, "no-such-dir", "m.hold"), dev: "1", ino: "1" })).rejects.toBeInstanceOf(HolderScanUnavailableError);
  });

  it("group presence: present while a member lives, absent after the group is killed; the dead leader is invisible to ps (rule 9 shape)", { timeout: SLOW }, async () => {
    const pidFile = join(dir, "member-pid");
    const leader = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}`], { detached: true, stdio: "ignore" });
    const leaderPid = leader.pid;
    if (leaderPid === undefined) throw new Error("no pid");
    await new Promise((resolve) => leader.once("exit", resolve));
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    // Leader reaped, member alive: the group id is still in use and ps cannot find the leader pid.
    expect(processGroupPresent(leaderPid)).toBe(true);
    expect(await readLeader(leaderPid)).toBeNull();
    process.kill(-leaderPid, "SIGKILL");
    await waitFor(() => !processGroupPresent(leaderPid));
    expect(processGroupPresent(leaderPid)).toBe(false);
  });

  // macOS only: the W13 probe targets macOS lsof (the Linux probe is parser-tested only, design §5).
  it.skipIf(process.platform !== "darwin")("T7: a released command that leaves a detached fd-3 holder behind is unknown(escaped_holder) until the holder exits", { timeout: SLOW }, async () => {
    const j = journal();
    const result = await run(
      j,
      process.execPath,
      [
        "-e",
        "require('node:child_process').spawn('/bin/sleep',['2'],{detached:true,stdio:['ignore','ignore','ignore',3]}).unref()",
      ],
      { proofWaitMs: 300 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.proof).toBeNull();
    expect(j.events.at(-1)).toBe("release:committed");
    const probe = createHostProcessProbe();
    const open = record(j, "released");
    expect(await classifyHostProcess(open, probe, { waitMs: 0 })).toMatchObject({ kind: "unknown", reason: "escaped_holder" });
    await waitFor(() => !readHolders(open), 6000);
    expect(await classifyHostProcess(open, probe, { waitMs: 0 })).toMatchObject({ kind: "stopped", proof: "group_empty+marker_unheld" });

    function readHolders(rec: HostProcessRecord): boolean {
      return spawnSync("/usr/sbin/lsof", ["-w", "-n", "-F", "p", "--", rec.marker.path]).stdout.toString().includes("p");
    }
  });
});

describe("runHardenedGit gate option", () => {
  const gate = (j: Recording, fence: () => void = () => undefined) => ({ journal: j, markerDir, launch: launch("git", []), fence });

  it("runs git through the gate and keeps the result shape", async () => {
    const j = journal();
    const result = await runHardenedGit(["--version"], { cwd: dir, env: baseEnv(), gate: gate(j) });
    expect(result.stdout.toString()).toMatch(/^git version /);
    expect(j.events).toEqual(["launching", "registered", "release:fence", "release:committed", "stopped:group_empty+marker_unheld"]);
  });

  it("maps a git failure to HARDENED_GIT_FAILED and a fence refusal to the fence's own error", async () => {
    const failing = await runHardenedGit(["rev-parse", "--verify", "refs/heads/none"], { cwd: dir, env: baseEnv(), gate: gate(journal()) }).catch((e: unknown) => e);
    expect(failing).toBeInstanceOf(HardenedGitError);
    expect((failing as HardenedGitError).code).toBe("HARDENED_GIT_FAILED");
    const j = journal();
    await expect(
      runHardenedGit(["--version"], {
        cwd: dir,
        env: baseEnv(),
        gate: gate(j, () => {
          throw new Error("stale_owner");
        }),
      }),
    ).rejects.toThrow("stale_owner");
  });

  it("rejects stdin input under a gate and leaves ungated calls untouched", async () => {
    await expect(runHardenedGit(["--version"], { cwd: dir, env: baseEnv(), input: "x", gate: gate(journal()) })).rejects.toThrow(/HARDENED_GIT_INVALID_ARGS/);
    expect((await runHardenedGit(["--version"], { cwd: dir, env: baseEnv() })).stdout.toString()).toMatch(/^git version /);
  });
});

describe("T3 crash points (child process SIGKILLed mid-protocol, run against the current source)", () => {
  const STEPS = ["after_launching", "after_spawn", "after_registered", "after_release_commit", "after_release_write"] as const;
  // host-process.ts only imports node builtins, so transpiling it alone gives the child the exact code under test.
  const childScript = () => {
    const lib = join(dir, "host-process-under-test.mjs");
    if (!existsSync(lib)) {
      const source = readFileSync(new URL("./host-process.ts", import.meta.url), "utf8");
      writeFileSync(lib, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    }
    const path = join(dir, "crash-child.mjs");
    writeFileSync(
      path,
      `import { appendFileSync } from "node:fs";
import { runGatedProcess, argvDigest, currentBootSession } from ${JSON.stringify(pathToFileURL(lib).href)};
const [ledger, markerDir, sentinel] = process.argv.slice(2);
const log = (o) => appendFileSync(ledger, JSON.stringify(o) + "\\n");
const journal = {
  launching: (i) => log({ e: "launching", i }),
  registered: (id, identity) => log({ e: "registered", identity }),
  release: (id, fence) => { fence(); log({ e: "released" }); },
  stopped: (id, o) => log({ e: "stopped", o }),
};
const args = ["-c", "touch " + sentinel + "; sleep 2"];
await runGatedProcess("/bin/sh", args, {
  cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 20000, maxOutputBytes: 1024, journal, markerDir,
  launch: { mission_id: "m", kind: "git_update_ref", local_target: "t", argv_digest: argvDigest("/bin/sh", args), boot_id: currentBootSession() ?? "unknown" },
  fence: () => {}, onStep: (s) => { log({ e: "step", s }); if (s === process.env.CRASH_AT) process.kill(process.pid, "SIGKILL"); },
});
`,
    );
    return path;
  };

  for (const step of STEPS) {
    it(`crash ${step}`, { timeout: SLOW }, async () => {
      const ledger = join(dir, `ledger-${step}.jsonl`);
      const sentinel = join(dir, `crash-sentinel-${step}`);
      writeFileSync(ledger, "");
      const child = spawn(process.execPath, [childScript(), ledger, markerDir, sentinel], { env: { ...process.env, CRASH_AT: step }, stdio: "ignore" });
      const signal = await new Promise<string | null>((resolve) => child.once("exit", (_c, s) => resolve(s)));
      expect(signal).toBe("SIGKILL");
      const lines = readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { e: string; i?: HostProcessLaunchInput; identity?: HostProcessRecord });
      // Prove the child really got to the requested checkpoint before dying, and nowhere past it.
      const stepsSeen = lines.filter((l) => l.e === "step").map((l) => (l as unknown as { s: string }).s);
      expect(stepsSeen).toEqual(STEPS.slice(0, STEPS.indexOf(step) + 1));
      expect(lines.some((l) => l.e === "registered")).toBe(STEPS.indexOf(step) >= STEPS.indexOf("after_registered"));
      expect(lines.some((l) => l.e === "released")).toBe(STEPS.indexOf(step) >= STEPS.indexOf("after_release_commit"));
      const launching = lines.find((l) => l.e === "launching")?.i;
      if (launching === undefined) throw new Error("no launching row");
      const identity = lines.find((l) => l.e === "registered")?.identity as unknown as { pid: number; pgid: number; leader_start: string | null } | undefined;
      const released = lines.some((l) => l.e === "released");
      const rec: HostProcessRecord = {
        op_id: launching.op_id,
        state: released ? "released" : identity ? "registered" : "launching",
        pid: identity?.pid ?? null,
        pgid: identity?.pgid ?? null,
        leader_start: identity?.leader_start ?? null,
        boot_id: launching.boot_id,
        marker: launching.marker,
      };
      const probe = createHostProcessProbe();
      const verdict = await classifyHostProcess(rec, probe, { waitMs: 4000, pollMs: 50 });
      if (step !== "after_release_write") {
        // Never released, or released in the ledger but the byte never left: EOF, no exec.
        expect(existsSync(sentinel)).toBe(false);
        expect(verdict).toMatchObject({ kind: "stopped" });
        expect(released).toBe(step === "after_release_commit");
        return;
      }
      expect(released).toBe(true);
      if (existsSync(sentinel) || (await classifyHostProcess(rec, probe, { waitMs: 0 })).kind === "unknown") {
        // The byte was flushed before the kill: the command is running; stopped only after it exits.
        await waitFor(() => existsSync(sentinel), 2000);
        expect((await classifyHostProcess(rec, probe, { waitMs: 0 })).kind).toBe("unknown");
        await sleep(2500);
        expect(await classifyHostProcess(rec, probe, { waitMs: 3000, pollMs: 100 })).toMatchObject({ kind: "stopped", proof: "group_empty+marker_unheld" });
      } else {
        // Byte not flushed before SIGKILL: wrapper saw EOF; still a safe stopped.
        expect(verdict.kind).toBe("stopped");
      }
    });
  }
});

function readdirCount(path: string): number {
  return spawnSync("/bin/ls", ["-A", path]).stdout.toString().split("\n").filter(Boolean).length;
}
