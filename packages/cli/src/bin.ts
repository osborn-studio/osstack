// osstack CLI entry. Talks to the running daemon via Unix socket when needed.
// (shebang is injected by tsup banner)

import { execFile } from "node:child_process";
import { connect, type Socket } from "node:net";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { defaultAdapters } from "@osstack/agents";
import { LoopEngine, enqueueTask, readLoopState, renderLoopStateMarkdown } from "@osstack/loop";
import { initProject } from "@osstack/skills";
import {
  addSource, checkAll, defaultManifestPath, readManifest,
  removeSource, writeManifest,
} from "@osstack/skill-registry";
import { startDaemon, DEFAULT_SOCKET_PATH } from "./daemon.js";
import { handleConfigCommand } from "./config.js";

const VERSION = "0.0.0";
const execFileAsync = promisify(execFile);

function socketPath(): string {
  return process.env["OSSTACK_SOCKET"] ?? DEFAULT_SOCKET_PATH;
}

async function rpc(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath());
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`osstack: daemon RPC timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(encodeFrame({ id: 1, method, params }));
    });
    sock.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timer);
      sock.end();
      resolve(frames[0]);
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        reject(new Error(`osstack: daemon not running (socket: ${socketPath()}). Start it with: osstack serve`));
      } else {
        reject(err);
      }
    });
  });
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const cmd = args[0];

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(`osstack ${VERSION}`);
    return 0;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help" || !cmd) {
    console.log(`osstack ${VERSION} — Hermes-resident project manager agent

Usage:
  osstack <command> [args]

Daemon commands:
  serve               Start the daemon (Unix socket at ${DEFAULT_SOCKET_PATH})
  health              Show daemon health (requires running daemon)
  stats               Show per-agent and loop metrics (requires running daemon)
  killswitch          Check if the policy layer is earning its keep (F4)
  agent list          List registered sub-agents and their capabilities

Project commands:
  init [dir]          Scaffold OSBORN project layout (V2 osb-init)

Agent configuration (role-based; no daemon needed):
  config [show]         Show active profile + how coding/test-verify/design resolve
  config doctor         Probe which agents are installed/available on this machine
  config pick           Interactively choose the primary agent per role
  config init           Write the default config to ~/.osstack/config.yaml
  config use <profile>  Set active_profile (or "auto")
  config bind <profile> Attach this machine's hostname to a profile
  config get [path]     Print config (or a dotted path)
  config set <profile>.<role>.<primary|fallback> <value...>

Task commands (require running daemon):
  task submit <prompt> [--kind K] [--agent A] [--tag T] [--max-iter N] [--repo P]
                                 Submit a new task (streams events).
                                 --kind research.ml --agent autoresearch runs
                                 the Karpathy autoresearch loop.
  task status <run_id>           Show current state of a run
  task cancel <run_id>           Abort a running task
  task observe <run_id> [seq]    Replay events from log, starting after seq

Kanban board (osstack's own; subscribable from Telegram via Hermes):
  kanban board [--archived]      Show the board, columns and cards
  kanban create <title> [--priority N] [--assignee A]
  kanban move <card_id> <status> [reason]   triage|todo|ready|running|blocked|done|archived
  kanban comment <card_id> <text>
  kanban subscribe <card_id> <platform> <chat_id> [thread_id]
  kanban events [--since N]      Drain pending card events (for relays)

Loop engineering (local, testable hot-loop MVP):
  loop run [--workspace P] [--source S] [--execute CMD] [--verify CMD]
           [--reviewer ID] [--checker ID] [--goal CMD] [--max-iter N] [--cycles N] [--interval-ms N]
           [--state P] [--markdown P] [--worktree] [--json] [--daemon]
                                 Run one discover→execute→verify→iterate cycle
  loop start [--workspace P] [--source S] [--execute CMD] [--verify CMD]
             [--reviewer ID] [--checker ID] [--goal CMD] [--schedule CRON] [--interval-ms N] [--cycles N]
             [--stop-when-idle] [--once] [--worktree]
                                 Start a daemon-managed polling loop
  loop enqueue <prompt> [--workspace P] [--capability C] [--priority N]
                                 Add a JSON task to tasks/
  loop doctor [--workspace P] [--daemon] [--json]
                                 Check workspace, queue, git, and optional daemon readiness
  loop list [--json]             List daemon-managed polling loops
  loop stop <loop_session_id>     Stop a daemon-managed polling loop
  loop status [--workspace P] [--state P] [--daemon]
                                 Render LOOP-STATE.json as STATE.md

Hermes integration:
  hermes health                  Show kanban-sync bridge state
  hermes dashboard               Open the Hermes WebUI in a browser
  hermes register-cron           Print example \`hermes cron\` recipes

External skill registry (S6):
  skills list                    List tracked external skill sources
  skills check                   Compare blessed_sha vs origin HEAD
  skills add <id> <origin> [ref] Track a new source
  skills bless <id>              Pin current origin HEAD as blessed

Local:
  version             Print version
  help                Show this help

Environment:
  OSSTACK_HOME        Storage root (default ~/.osstack)
  OSSTACK_SOCKET      Daemon socket path (default ${DEFAULT_SOCKET_PATH})

See docs/V2_REFACTOR_PLAN.md for the full roadmap.
`);
    return 0;
  }

  if (cmd === "serve") {
    const handle = await startDaemon();
    console.log(`osstack daemon listening on ${handle.socketPath}`);
    console.log(`db_path=${handle.dbPath}  pid=${process.pid}`);
    console.log("Send SIGTERM/SIGINT to stop.");
    return await new Promise<number>(() => { /* run forever until signal */ });
  }

  if (cmd === "health") {
    const out = await rpc("health");
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  if (cmd === "stats") {
    const resp = (await rpc("stats")) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "stats failed");
      return 1;
    }
    printStats(resp.result);
    return 0;
  }

  if (cmd === "agent" && args[1] === "list") {
    const resp = (await rpc("agent.list")) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "agent.list failed");
      return 1;
    }
    console.log(JSON.stringify(resp.result, null, 2));
    return 0;
  }

  if (cmd === "config") {
    return await handleConfigCommand(args.slice(1));
  }

  if (cmd === "task") {
    return await handleTaskCommand(args.slice(1));
  }

  if (cmd === "kanban") {
    return await handleKanbanCommand(args.slice(1));
  }

  if (cmd === "loop") {
    return await handleLoopCommand(args.slice(1));
  }

  if (cmd === "hermes") {
    return await handleHermesCommand(args.slice(1));
  }

  if (cmd === "skills") {
    return await handleSkillsCommand(args.slice(1));
  }

  if (cmd === "init") {
    // S5 V1 shim: V2 equivalent of `osb-init`. Idempotent.
    const target = args[1] ?? process.cwd();
    const result = initProject(target);
    console.log(`osstack init: ${result.project} @ ${target}`);
    for (const p of result.created) console.log(`  created  ${p}`);
    for (const p of result.skipped) console.log(`  skipped  ${p} (already exists)`);
    return 0;
  }

  if (cmd === "killswitch") {
    // F4 kill switch — warn if policy hasn't fired enough recently to justify itself.
    const resp = (await rpc("killswitch.check")) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "killswitch check failed");
      return 1;
    }
    const r = resp.result as {
      window_days: number; min_fires: number; observed: number;
      armed: boolean; recommendation: string;
    };
    console.log(`Kill switch window: last ${r.window_days} days`);
    console.log(`Observed policy decisions: ${r.observed}`);
    console.log(`Threshold:                 ${r.min_fires} required to stay armed`);
    console.log(`Status:                    ${r.armed ? "ARMED ✓" : "TRIPPED ⚠️"}`);
    console.log(`Recommendation:            ${r.recommendation}`);
    return r.armed ? 0 : 2;
  }

  console.error(`osstack: unknown command "${args.join(" ")}" — see "osstack help"`);
  return 1;
}

async function handleSkillsCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const path = defaultManifestPath();

  if (sub === "list" || sub === undefined) {
    const m = readManifest(path);
    console.log(`Skill manifest: ${path}`);
    console.log(`Schema version: ${m.version}`);
    console.log(`Tracked sources: ${m.sources.length}`);
    for (const s of m.sources) {
      const blessed = s.blessed_sha === null ? "(none)" : s.blessed_sha.slice(0, 12);
      console.log(`  • ${s.id}  ref=${s.ref}  blessed=${blessed}  auto_minor=${s.auto_minor}`);
      console.log(`      ${s.origin}`);
      if (s.notes) console.log(`      ${s.notes}`);
    }
    return 0;
  }

  if (sub === "check") {
    const m = readManifest(path);
    console.log(`Checking ${m.sources.length} source(s) against their tracked refs...`);
    const result = await checkAll(m);
    let drifted = 0;
    for (const e of result.entries) {
      if (!e.ok) {
        console.log(`  ✗ ${e.source.id}  unreachable: ${e.reason}`);
        continue;
      }
      if (e.drifted) {
        drifted += 1;
        const head = e.current_sha?.slice(0, 12) ?? "?";
        const blessed = e.source.blessed_sha?.slice(0, 12) ?? "(none)";
        console.log(`  ⚠ ${e.source.id}  drift  blessed=${blessed}  head=${head}  ref=${e.source.ref}`);
      } else {
        console.log(`  ✓ ${e.source.id}  up-to-date (${e.current_sha?.slice(0, 12)})`);
      }
    }
    console.log(`\n${drifted} source(s) drifted from blessed_sha.`);
    return drifted > 0 ? 2 : 0;
  }

  if (sub === "add") {
    const id = args[1];
    const origin = args[2];
    const ref = args[3] ?? "main";
    if (!id || !origin) {
      console.error("usage: osstack skills add <id> <origin-url> [ref]");
      return 1;
    }
    const m = readManifest(path);
    const next = addSource(m, { id, origin, ref });
    writeManifest(next, path);
    console.log(`added ${id} (${origin} @ ${ref})`);
    return 0;
  }

  if (sub === "remove") {
    const id = args[1];
    if (!id) { console.error("usage: osstack skills remove <id>"); return 1; }
    const m = readManifest(path);
    const next = removeSource(m, id);
    writeManifest(next, path);
    console.log(`removed ${id}`);
    return 0;
  }

  if (sub === "bless") {
    // Mark the current remote head as blessed for this source.
    const id = args[1];
    if (!id) { console.error("usage: osstack skills bless <id>"); return 1; }
    const m = readManifest(path);
    const src = m.sources.find((s) => s.id === id);
    if (!src) { console.error(`no source with id=${id}`); return 1; }
    const result = await checkAll({ version: 1, sources: [src] });
    const entry = result.entries[0]!;
    if (!entry.ok || !entry.current_sha) {
      console.error(`could not fetch head: ${entry.reason}`);
      return 1;
    }
    const next = addSource(m, {
      id: src.id, origin: src.origin, ref: src.ref,
      blessed_sha: entry.current_sha,
      last_checked: result.generated_at,
    });
    writeManifest(next, path);
    console.log(`blessed ${id} @ ${entry.current_sha.slice(0, 12)}`);
    return 0;
  }

  if (sub === "help") {
    console.log(`osstack skills — external skill registry (S6)

  osstack skills list                       Show tracked sources + versions
  osstack skills add <id> <origin> [ref]    Add or update a source
  osstack skills remove <id>                Remove a source
  osstack skills check                      Compare blessed_sha vs origin HEAD
  osstack skills bless <id>                 Pin the current HEAD as blessed
  osstack skills help                       This help

Manifest path: ${path}
`);
    return 0;
  }

  console.error(`osstack: unknown skills subcommand "${sub}"`);
  return 1;
}

type RpcResp = { ok: boolean; result?: unknown; error?: { message: string } };

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      values.push(args[i + 1]!);
      i++;
    }
  }
  return values;
}

function positionalValues(args: string[], flagsWithValues: Set<string>): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flagsWithValues.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

function parseContextJson(value: string | undefined): Record<string, unknown> | undefined | Error {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`--context-json must be valid JSON: ${message}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return new Error("--context-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function handleLoopCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === "start") {
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
    const markdownPath = flagValue(args, "--markdown");
    const executeCommand = flagValue(args, "--execute");
    const agentId = flagValue(args, "--agent");
    const goalCommand = flagValue(args, "--goal");
    const schedule = flagValue(args, "--schedule");
    const worktreeRoot = flagValue(args, "--worktree-root");
    const verifyCommands = flagValues(args, "--verify");
    const verifierAgentIds = [...flagValues(args, "--reviewer"), ...flagValues(args, "--checker")];
    const sources = flagValues(args, "--source");
    const maxIterRaw = flagValue(args, "--max-iter");
    const cyclesRaw = flagValue(args, "--cycles");
    const intervalRaw = flagValue(args, "--interval-ms");
    const archiveCompletedTasks = args.includes("--archive-completed");
    const once = args.includes("--once");
    const autoAgent = args.includes("--auto-agent");
    const maxIterations = parsePositiveIntegerFlag(maxIterRaw, "--max-iter");
    if (maxIterations instanceof Error) {
      console.error(`osstack: ${maxIterations.message}`);
      return 1;
    }
    const cycles = parsePositiveIntegerFlag(cyclesRaw, "--cycles");
    if (cycles instanceof Error) {
      console.error(`osstack: ${cycles.message}`);
      return 1;
    }
    const intervalMs = parseNonNegativeIntegerFlag(intervalRaw, "--interval-ms");
    if (intervalMs instanceof Error) {
      console.error(`osstack: ${intervalMs.message}`);
      return 1;
    }
    if (once && cycles !== undefined && cycles !== 1) {
      console.error("osstack: --once cannot be combined with --cycles other than 1");
      return 1;
    }
    const effectiveCycles = once ? 1 : cycles;
    const stopWhenIdle = args.includes("--stop-when-idle") || once;

    const resp = await rpc("loop.start", {
      workspacePath,
      stateFilePath,
      ...(markdownPath !== undefined ? { markdownPath } : {}),
      ...(executeCommand !== undefined ? { executeCommand } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(autoAgent ? { autoAgent } : {}),
      ...(goalCommand !== undefined ? { goalCommand } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
      ...(verifierAgentIds.length > 0 ? { verifierAgentIds } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(effectiveCycles !== undefined ? { cycles: effectiveCycles } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(archiveCompletedTasks ? { archiveCompletedTasks } : {}),
      ...(stopWhenIdle ? { stopWhenIdle: true } : {}),
      ...(args.includes("--worktree") ? { useWorktree: true } : {}),
      ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    }) as RpcResp;
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "loop.start failed");
      return 1;
    }
    printLoopSession(resp.result as LoopSessionSummary, args.includes("--json"));
    return 0;
  }

  if (sub === "list") {
    const resp = await rpc("loop.list") as RpcResp;
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "loop.list failed");
      return 1;
    }
    const result = resp.result as { loops: LoopSessionSummary[] };
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    printLoopSessionList(result.loops);
    return 0;
  }

  if (sub === "stop") {
    const loopSessionId = args[1];
    if (loopSessionId === undefined || loopSessionId.startsWith("--")) {
      console.error("osstack: loop stop requires a loop_session_id");
      return 1;
    }
    const resp = await rpc("loop.stop", { loopSessionId }) as RpcResp;
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "loop.stop failed");
      return 1;
    }
    printLoopSession(resp.result as LoopSessionSummary, args.includes("--json"));
    return 0;
  }

  if (sub === "run") {
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
    const markdownPath = flagValue(args, "--markdown");
    const executeCommand = flagValue(args, "--execute");
    const agentId = flagValue(args, "--agent");
    const goalCommand = flagValue(args, "--goal");
    const worktreeRoot = flagValue(args, "--worktree-root");
    const verifyCommands = flagValues(args, "--verify");
    const verifierAgentIds = [...flagValues(args, "--reviewer"), ...flagValues(args, "--checker")];
    const sources = flagValues(args, "--source");
    const maxIterRaw = flagValue(args, "--max-iter");
    const cyclesRaw = flagValue(args, "--cycles");
    const intervalRaw = flagValue(args, "--interval-ms");
    const json = args.includes("--json");
    const useDaemon = args.includes("--daemon");
    const stopWhenIdle = args.includes("--stop-when-idle");
    const archiveCompletedTasks = args.includes("--archive-completed");
    const autoAgent = args.includes("--auto-agent");
    const maxIterations = parsePositiveIntegerFlag(maxIterRaw, "--max-iter");
    if (maxIterations instanceof Error) {
      console.error(`osstack: ${maxIterations.message}`);
      return 1;
    }
    const cycles = parsePositiveIntegerFlag(cyclesRaw, "--cycles");
    if (cycles instanceof Error) {
      console.error(`osstack: ${cycles.message}`);
      return 1;
    }
    const intervalMs = parseNonNegativeIntegerFlag(intervalRaw, "--interval-ms");
    if (intervalMs instanceof Error) {
      console.error(`osstack: ${intervalMs.message}`);
      return 1;
    }
    const runCycles = cycles !== undefined || intervalMs !== undefined || stopWhenIdle;

    if (useDaemon) {
      const resp = await rpc("loop.run", {
        workspacePath,
        stateFilePath,
        ...(markdownPath !== undefined ? { markdownPath } : {}),
        ...(executeCommand !== undefined ? { executeCommand } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(autoAgent ? { autoAgent } : {}),
        ...(goalCommand !== undefined ? { goalCommand } : {}),
        ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
        ...(verifierAgentIds.length > 0 ? { verifierAgentIds } : {}),
        ...(sources.length > 0 ? { sources } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        ...(cycles !== undefined ? { cycles } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(archiveCompletedTasks ? { archiveCompletedTasks } : {}),
        ...(stopWhenIdle ? { stopWhenIdle } : {}),
        ...(args.includes("--worktree") ? { useWorktree: true } : {}),
        ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
      }) as RpcResp;
      if (!resp.ok) {
        console.error("osstack:", resp.error?.message ?? "loop.run failed");
        return 1;
      }
      const result = resp.result as LoopRunSummary;
      printLoopRun(result, json);
      return result.completed_tasks.some((task) => task.outcome !== "success") ? 2 : 0;
    }

    const adapters = agentId !== undefined || verifierAgentIds.length > 0 || autoAgent
      ? defaultAdapters()
      : undefined;
    const engine = new LoopEngine({
      workspacePath,
      stateFilePath,
      ...(markdownPath !== undefined ? { markdownPath } : {}),
      ...(executeCommand !== undefined ? { executeCommand } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(autoAgent ? { autoAgent } : {}),
      ...(adapters !== undefined ? { adapters } : {}),
      ...(verifierAgentIds.length > 0 ? { verifierAgentIds } : {}),
      ...(goalCommand !== undefined ? { goalCommand } : {}),
      ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(archiveCompletedTasks ? { archiveCompletedTasks } : {}),
      ...(args.includes("--worktree") ? { useWorktree: true } : {}),
      ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    });
    const result = runCycles
      ? await engine.runCycles({
          ...(cycles !== undefined ? { cycles } : {}),
          ...(intervalMs !== undefined ? { intervalMs } : {}),
          ...(stopWhenIdle ? { stopWhenIdle } : {}),
        })
      : await engine.runOnce();
    const goal = "goal" in result
      ? result.goal
      : "cycles" in result
        ? result.cycles.at(-1)?.goal
        : undefined;

    printLoopRun({
      loop_id: result.loop_id,
      json_path: result.jsonPath,
      markdown_path: result.markdownPath,
      completed_tasks: result.state.completed_tasks,
      events: result.events,
      ...(goal !== undefined ? { goal } : {}),
      ...(result.state.key_metrics !== undefined ? { metrics: result.state.key_metrics } : {}),
      ...("cycles" in result ? { cycles: result.cycles.map((cycle) => ({
        discovered_task_count: cycle.discoveredTaskCount,
        executed_task_count: cycle.executedTaskCount,
        skipped_task_count: cycle.skippedTaskCount,
        ...(cycle.goal !== undefined ? { goal: cycle.goal } : {}),
      })) } : {}),
    }, json);
    return result.state.completed_tasks.some((task) => task.outcome !== "success") ? 2 : 0;
  }

  if (sub === "enqueue") {
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const capability = flagValue(args, "--capability");
    const taskId = flagValue(args, "--id");
    const priority = parsePositiveIntegerFlag(flagValue(args, "--priority"), "--priority");
    if (priority instanceof Error) {
      console.error(`osstack: ${priority.message}`);
      return 1;
    }
    if (priority !== undefined && priority > 100) {
      console.error("osstack: --priority must be between 1 and 100");
      return 1;
    }
    const context = parseContextJson(flagValue(args, "--context-json"));
    if (context instanceof Error) {
      console.error(`osstack: ${context.message}`);
      return 1;
    }
    const prompt = positionalValues(args.slice(1), new Set([
      "--workspace",
      "--capability",
      "--id",
      "--priority",
      "--context-json",
    ])).join(" ").trim();
    if (prompt === "") {
      console.error("osstack: loop enqueue requires a prompt");
      return 1;
    }
    const result = await enqueueTask({
      workspacePath,
      prompt,
      ...(capability !== undefined ? { capability } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(context !== undefined ? { context } : {}),
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        task: result.task,
        path: result.path,
      }, null, 2));
    } else {
      console.log(`task_id=${result.task.task_id}`);
      console.log(`path=${result.path}`);
    }
    return 0;
  }

  if (sub === "doctor") {
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const stateFilePath = resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
    const result = await loopDoctor({
      workspacePath,
      stateFilePath,
      checkDaemon: args.includes("--daemon"),
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printLoopDoctor(result);
    }
    return result.ok ? 0 : 1;
  }

  if (sub === "status" || sub === undefined) {
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const stateFilePath = resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
    if (args.includes("--daemon")) {
      const resp = await rpc("loop.status", {
        workspacePath,
        stateFilePath,
      }) as RpcResp;
      if (!resp.ok) {
        console.error("osstack:", resp.error?.message ?? "loop.status failed");
        return 1;
      }
      const result = resp.result as { markdown?: string };
      console.log(result.markdown ?? "");
      return 0;
    }
    const state = await readLoopState(stateFilePath);
    if (state === null) {
      const markdownPath = stateFilePath.endsWith(".json")
        ? stateFilePath.replace(/[^/]+$/, "STATE.md")
        : "STATE.md";
      try {
        console.log(await readFile(markdownPath, "utf-8"));
        return 0;
      } catch {
        console.error(`osstack: no loop state found at ${stateFilePath}`);
        return 1;
      }
    }
    console.log(renderLoopStateMarkdown(state));
    return 0;
  }

  if (sub === "help") {
    console.log(`osstack loop — local Loop Engineering runner

  osstack loop run [options]       Run one discover→execute→verify→iterate cycle
  osstack loop start [options]     Start a daemon-managed polling loop
  osstack loop enqueue <prompt>    Add a task_queue JSON file
  osstack loop doctor [options]    Check workspace, queue, git, and daemon readiness
  osstack loop list [--json]       List daemon-managed polling loops
  osstack loop stop <id> [--json]  Stop a daemon-managed polling loop
  osstack loop status [options]    Print current loop state

Options:
  --workspace P       Workspace to scan and run commands in (default: cwd)
  --source S          Discovery source; repeatable. git_diff | task_queue
  --agent ID          Run tasks through a registered adapter (for example codex-cli)
  --auto-agent        Let router + policy choose an available adapter by capability
  --execute CMD       Shell command to run for each task
  --verify CMD        Shell verifier; repeatable. Non-zero exit marks failure
  --reviewer ID       Adapter verifier to run after execution; repeatable
  --checker ID        Alias for --reviewer for checker/verifier agents
  --goal CMD          Global shell command; loop stops when it exits 0
  --schedule CRON     Cron schedule for daemon-managed loop start
  --archive-completed Move successful single-task queue files into tasks/archive/
  --worktree         Run each task in an isolated git worktree, merge success back
  --worktree-root P  Directory for temporary isolated worktrees
  --max-iter N        Iterations before escalation (default: 1)
  --cycles N          Run multiple cycles before exiting, or cap loop start
  --once              Alias for loop start --cycles 1 --stop-when-idle
  --interval-ms N     Delay between cycles in milliseconds (loop start default: 5000)
  --stop-when-idle    Stop after the first cycle that executes no tasks
  --state P           JSON state path (default: LOOP-STATE.json)
  --markdown P        Markdown state path (default: STATE.md beside JSON)
  --json              Emit machine-readable summary
  --daemon            Run through the osstack daemon RPC socket

Example:
  mkdir -p tasks
  printf '{"prompt":"Run local checks","capability":"code.test"}' > tasks/check.json
  osstack loop run --source task_queue --verify "pnpm test"
`);
    return 0;
  }

  console.error(`osstack: unknown loop subcommand "${sub}"`);
  return 1;
}

function resolveLoopPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function parsePositiveIntegerFlag(value: string | undefined, name: string): number | undefined | Error {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeIntegerFlag(value: string | undefined, name: string): number | undefined | Error {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

interface LoopRunSummary {
  loop_id: string;
  json_path: string;
  markdown_path: string;
  completed_tasks: Array<{
    task_id: string;
    outcome: "success" | "failed" | "escalated";
    iterations: number;
    agent_id: string;
    duration_ms: number;
  }>;
  metrics?: {
    success_rate: number;
  };
  goal?: {
    command: string;
    pass: boolean;
    exitCode: number;
    durationMs: number;
    summary: string;
  };
  events?: unknown[];
  cycles?: Array<{
    discovered_task_count: number;
    executed_task_count: number;
    skipped_task_count: number;
    goal?: {
      command: string;
      pass: boolean;
      exitCode: number;
      durationMs: number;
      summary: string;
    };
  }>;
}

interface LoopSessionSummary {
  loop_session_id: string;
  workspace_path: string;
  state_json: string;
  status: "running" | "stopping" | "stopped" | "failed";
  interval_ms: number;
  stop_when_idle: boolean;
  schedule?: string;
  started_at: number;
  updated_at: number;
  cycle_count: number;
  discovered_task_count: number;
  executed_task_count: number;
  skipped_task_count: number;
  successful_task_count: number;
  failed_task_count: number;
  escalated_task_count: number;
  tokens_consumed: number;
  total_cycle_duration_ms: number;
  avg_cycle_duration_ms: number | null;
  last_cycle_duration_ms?: number;
  max_cycles?: number;
  stop_reason?: string;
  last_error?: string;
}

interface LoopDoctorResult {
  ok: boolean;
  workspace_path: string;
  state_json: string;
  daemon_checked: boolean;
  socket_path: string;
  checks: LoopDoctorCheck[];
}

interface LoopDoctorCheck {
  id: string;
  status: "ok" | "warn" | "error";
  summary: string;
  details?: Record<string, unknown>;
}

interface StatsResult {
  total_runs: number;
  total_events: number;
  per_agent: AgentStatsRow[];
  loops?: LoopStatsSummary;
}

interface AgentStatsRow {
  agent_id: string;
  capability_id: string;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  in_flight: number;
  avg_duration_ms: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_pii_redacted: number;
}

interface LoopStatsSummary {
  total_sessions: number;
  running: number;
  stopping: number;
  stopped: number;
  failed: number;
  total_cycles: number;
  total_discovered: number;
  total_executed: number;
  total_skipped: number;
  total_successful: number;
  total_failed: number;
  total_escalated: number;
  total_tokens_consumed: number;
  total_cycle_duration_ms: number;
  avg_cycle_duration_ms: number | null;
  per_loop: LoopStatsRow[];
}

interface LoopStatsRow {
  loop_session_id: string;
  status: string;
  workspace_path: string;
  cycle_count: number;
  discovered_task_count: number;
  executed_task_count: number;
  skipped_task_count: number;
  successful_task_count: number;
  failed_task_count: number;
  escalated_task_count: number;
  tokens_consumed: number;
  total_cycle_duration_ms: number;
  avg_cycle_duration_ms: number | null;
  last_cycle_duration_ms?: number;
  schedule?: string;
  stop_reason?: string;
  last_error?: string;
}

function printLoopRun(result: LoopRunSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`loop_id=${result.loop_id}`);
  console.log(`state_json=${result.json_path}`);
  console.log(`state_markdown=${result.markdown_path}`);
  console.log(`tasks=${result.completed_tasks.length} success_rate=${Math.round((result.metrics?.success_rate ?? 1) * 100)}%`);
  if (result.goal !== undefined) {
    console.log(`goal=${result.goal.pass ? "passed" : "not_met"} exit_code=${result.goal.exitCode}`);
  }
  if (result.cycles !== undefined) {
    console.log(`cycles=${result.cycles.length}`);
    result.cycles.forEach((cycle, index) => {
      const goal = cycle.goal === undefined
        ? ""
        : ` goal=${cycle.goal.pass ? "passed" : "not_met"}`;
      console.log(`  cycle ${index + 1}: discovered=${cycle.discovered_task_count} executed=${cycle.executed_task_count} skipped=${cycle.skipped_task_count}${goal}`);
    });
  }
  for (const task of result.completed_tasks) {
    console.log(`  ${task.task_id}: ${task.outcome} (${task.iterations} iteration${task.iterations === 1 ? "" : "s"})`);
  }
}

function printLoopSession(result: LoopSessionSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`loop_session_id=${result.loop_session_id}`);
  console.log(`status=${result.status}`);
  console.log(`workspace=${result.workspace_path}`);
  console.log(`state_json=${result.state_json}`);
  console.log(`interval_ms=${result.interval_ms}`);
  if (result.schedule !== undefined) console.log(`schedule=${result.schedule}`);
  console.log(`cycles=${result.cycle_count} discovered=${result.discovered_task_count} executed=${result.executed_task_count} skipped=${result.skipped_task_count}`);
  console.log(`tasks_ok=${result.successful_task_count} failed=${result.failed_task_count} escalated=${result.escalated_task_count} tokens=${result.tokens_consumed}`);
  if (result.cycle_count > 0) {
    const avg = result.avg_cycle_duration_ms === null ? "-" : result.avg_cycle_duration_ms.toFixed(0);
    console.log(`cycle_duration_ms_total=${result.total_cycle_duration_ms} avg=${avg}`);
  }
  if (result.max_cycles !== undefined) console.log(`max_cycles=${result.max_cycles}`);
  if (result.stop_reason !== undefined) console.log(`stop_reason=${result.stop_reason}`);
  if (result.last_error !== undefined) console.log(`last_error=${result.last_error}`);
}

function printLoopSessionList(loops: LoopSessionSummary[]): void {
  if (loops.length === 0) {
    console.log("No loop sessions.");
    return;
  }
  for (const loop of loops) {
    console.log(`${loop.loop_session_id}  ${loop.status}  cycles=${loop.cycle_count} executed=${loop.executed_task_count}  ${loop.workspace_path}`);
  }
}

async function loopDoctor(input: {
  workspacePath: string;
  stateFilePath: string;
  checkDaemon: boolean;
}): Promise<LoopDoctorResult> {
  const checks: LoopDoctorCheck[] = [];
  const add = (
    id: string,
    status: LoopDoctorCheck["status"],
    summary: string,
    details?: Record<string, unknown>,
  ) => {
    const check: LoopDoctorCheck = { id, status, summary };
    if (details !== undefined) check.details = details;
    checks.push(check);
  };

  let workspaceReady = false;
  try {
    const workspace = await stat(input.workspacePath);
    if (workspace.isDirectory()) {
      workspaceReady = true;
      add("workspace", "ok", "workspace directory exists");
    } else {
      add("workspace", "error", "workspace path is not a directory");
    }
  } catch (error) {
    add("workspace", "error", "workspace directory is not accessible", { error: errorMessage(error) });
  }

  if (workspaceReady) {
    await checkTaskQueue(input.workspacePath, add);
    await checkLoopState(input.stateFilePath, add);
    await checkGit(input.workspacePath, add);
  }

  if (input.checkDaemon) {
    await checkLoopDaemon(add);
  }

  return {
    ok: !checks.some((check) => check.status === "error"),
    workspace_path: input.workspacePath,
    state_json: input.stateFilePath,
    daemon_checked: input.checkDaemon,
    socket_path: socketPath(),
    checks,
  };
}

async function checkTaskQueue(
  workspacePath: string,
  add: (id: string, status: LoopDoctorCheck["status"], summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  const taskDir = join(workspacePath, "tasks");
  let entries: string[];
  try {
    entries = await readdir(taskDir);
  } catch (error) {
    add("task_queue", "warn", "tasks/ directory is missing; loop enqueue will create it", {
      path: taskDir,
      error: errorMessage(error),
    });
    return;
  }

  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  let validTasks = 0;
  const invalidFiles: string[] = [];
  for (const file of jsonFiles) {
    const path = join(taskDir, file);
    try {
      validTasks += countQueueTasks(JSON.parse(await readFile(path, "utf-8")) as unknown);
    } catch {
      invalidFiles.push(file);
    }
  }

  if (invalidFiles.length > 0) {
    add("task_queue", "error", "task queue contains invalid JSON task files", {
      path: taskDir,
      json_files: jsonFiles.length,
      valid_tasks: validTasks,
      invalid_files: invalidFiles,
    });
    return;
  }

  add("task_queue", "ok", "task queue is readable", {
    path: taskDir,
    json_files: jsonFiles.length,
    valid_tasks: validTasks,
  });
}

async function checkLoopState(
  stateFilePath: string,
  add: (id: string, status: LoopDoctorCheck["status"], summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const stateFile = await stat(stateFilePath);
    if (stateFile.isFile()) {
      add("state_file", "ok", "loop state file exists", { path: stateFilePath });
    } else {
      add("state_file", "warn", "loop state path exists but is not a file", { path: stateFilePath });
    }
  } catch {
    add("state_file", "warn", "loop state file will be created after the first run", { path: stateFilePath });
  }
}

async function checkGit(
  workspacePath: string,
  add: (id: string, status: LoopDoctorCheck["status"], summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 5_000 });
  } catch (error) {
    add("git", "warn", "git is not available; git_diff and --worktree modes will not work", {
      error: errorMessage(error),
    });
    return;
  }

  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workspacePath,
      timeout: 5_000,
    });
  } catch {
    add("git", "warn", "workspace is not a git worktree; task_queue mode still works", {
      workspace: workspacePath,
    });
    return;
  }

  try {
    const status = await execFileAsync("git", ["status", "--short"], {
      cwd: workspacePath,
      timeout: 5_000,
    });
    const changedFiles = String(status.stdout).split("\n").filter((line) => line.trim() !== "").length;
    add("git", "ok", changedFiles === 0 ? "git worktree is clean" : "git worktree is usable with local changes", {
      changed_files: changedFiles,
    });
  } catch (error) {
    add("git", "warn", "git status failed in workspace", { error: errorMessage(error) });
  }
}

async function checkLoopDaemon(
  add: (id: string, status: LoopDoctorCheck["status"], summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const response = await rpc("health", undefined, 1_000) as RpcResp;
    if (response.ok) {
      add("daemon", "ok", "daemon RPC is reachable", {
        socket: socketPath(),
        health: response.result,
      });
    } else {
      add("daemon", "error", "daemon RPC returned an error", {
        socket: socketPath(),
        error: response.error?.message ?? "unknown error",
      });
    }
  } catch (error) {
    add("daemon", "error", "daemon RPC is not reachable", {
      socket: socketPath(),
      error: errorMessage(error),
    });
  }
}

function countQueueTasks(value: unknown): number {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) throw new Error("task queue file cannot be empty");
  let count = 0;
  for (const item of items) {
    if (item === null || Array.isArray(item) || typeof item !== "object") {
      throw new Error("task queue item must be an object");
    }
    const prompt = (item as Record<string, unknown>)["prompt"];
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("task queue item requires a non-empty prompt");
    }
    count++;
  }
  return count;
}

function printLoopDoctor(result: LoopDoctorResult): void {
  console.log(`Loop doctor: ${result.ok ? "ok" : "attention needed"}`);
  console.log(`workspace=${result.workspace_path}`);
  console.log(`state_json=${result.state_json}`);
  if (result.daemon_checked) console.log(`socket=${result.socket_path}`);
  for (const check of result.checks) {
    console.log(`  [${check.status}] ${check.summary}`);
    if (check.details !== undefined) {
      console.log(`      ${formatDoctorDetails(check.details)}`);
    }
  }
}

function formatDoctorDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${formatDoctorValue(value)}`)
    .join(" ");
}

function formatDoctorValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatDoctorValue).join(",")}]`;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleKanbanCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === "board") {
    const includeArchived = args.includes("--archived");
    const resp = (await rpc("kanban.board", { include_archived: includeArchived })) as RpcResp;
    if (!resp.ok) { console.error("osstack:", resp.error?.message ?? "kanban.board failed"); return 1; }
    const view = resp.result as {
      changed: boolean; board: string; latest_event_id: number;
      columns?: { name: string; cards: { card_id: string; title: string; priority: number; assignee: string | null; blocked_reason: string | null }[] }[];
      stats?: { total: number };
    };
    if (!view.changed || !view.columns) { console.log(`[${view.board}] no cards`); return 0; }
    console.log(`Board: ${view.board}  (${view.stats?.total ?? 0} cards, latest_event=${view.latest_event_id})`);
    for (const col of view.columns) {
      if (col.cards.length === 0) continue;
      console.log(`\n  ${col.name.toUpperCase()} (${col.cards.length})`);
      for (const c of col.cards) {
        const tags = [c.priority > 0 ? `P${c.priority}` : null, c.assignee, c.blocked_reason ? `⛔${c.blocked_reason}` : null].filter(Boolean).join(" · ");
        console.log(`    ${c.card_id}  ${c.title}${tags ? `  [${tags}]` : ""}`);
      }
    }
    return 0;
  }

  if (sub === "create") {
    const title = args.slice(1).filter((a) => !a.startsWith("--") && a !== flagValue(args, "--priority") && a !== flagValue(args, "--assignee")).join(" ");
    if (!title) { console.error("osstack: kanban create requires a title"); return 1; }
    const priorityRaw = flagValue(args, "--priority");
    const params: Record<string, unknown> = { title };
    if (priorityRaw !== undefined) params.priority = Number(priorityRaw);
    const assignee = flagValue(args, "--assignee");
    if (assignee !== undefined) params.assignee = assignee;
    const resp = (await rpc("kanban.create", params)) as RpcResp;
    if (!resp.ok) { console.error("osstack:", resp.error?.message ?? "create failed"); return 1; }
    const c = resp.result as { card_id: string; title: string };
    console.log(`created ${c.card_id}: ${c.title}`);
    return 0;
  }

  if (sub === "move") {
    const cardId = args[1];
    const status = args[2];
    const reason = args.slice(3).join(" ") || undefined;
    if (!cardId || !status) { console.error("osstack: kanban move <card_id> <status> [reason]"); return 1; }
    const resp = (await rpc("kanban.move", { card_id: cardId, status, blocked_reason: reason, actor: "cli" })) as RpcResp;
    if (!resp.ok) { console.error("osstack:", resp.error?.message ?? "move failed"); return 1; }
    const c = resp.result as { card_id: string; status: string };
    console.log(`${c.card_id} → ${c.status}`);
    return 0;
  }

  if (sub === "comment") {
    const cardId = args[1];
    const text = args.slice(2).join(" ");
    if (!cardId || !text) { console.error("osstack: kanban comment <card_id> <text>"); return 1; }
    const resp = (await rpc("kanban.comment", { card_id: cardId, body: text, author: "cli" })) as RpcResp;
    if (!resp.ok) { console.error("osstack:", resp.error?.message ?? "comment failed"); return 1; }
    console.log(`commented on ${cardId}`);
    return 0;
  }

  if (sub === "subscribe") {
    const [, cardId, platform, chatId, threadId] = args;
    if (!cardId || !platform || !chatId) { console.error("osstack: kanban subscribe <card_id> <platform> <chat_id> [thread_id]"); return 1; }
    const params: Record<string, unknown> = { card_id: cardId, platform, chat_id: chatId };
    if (threadId) params.thread_id = threadId;
    const resp = (await rpc("kanban.subscribe", params)) as RpcResp;
    if (!resp.ok) { console.error("osstack:", resp.error?.message ?? "subscribe failed"); return 1; }
    console.log(`subscribed ${platform}:${chatId} to ${cardId}`);
    return 0;
  }

  if (sub === "events") {
    const sinceRaw = flagValue(args, "--since");
    const params: Record<string, unknown> = {};
    if (sinceRaw !== undefined) params.since = Number(sinceRaw);
    const resp = (await rpc("kanban.events", params)) as RpcResp;
    if (!resp.ok) { console.error("osstack:", resp.error?.message ?? "events failed"); return 1; }
    console.log(JSON.stringify(resp.result, null, 2));
    return 0;
  }

  console.error(`osstack: unknown kanban subcommand "${sub ?? ""}"`);
  console.error("  try: board | create | move | comment | subscribe | events");
  return 1;
}

async function handleHermesCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === "health") {
    const resp = (await rpc("hermes.health")) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "hermes.health failed");
      return 1;
    }
    console.log(JSON.stringify(resp.result, null, 2));
    return 0;
  }

  if (sub === "dashboard") {
    const port = process.env["HERMES_WEBUI_PORT"] ?? "8787";
    const host = process.env["HERMES_WEBUI_HOST"] ?? "127.0.0.1";
    const url = `http://${host}:${port}`;
    console.log(`osstack: opening ${url}`);
    const { spawn } = await import("node:child_process");
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return 0;
  }

  if (sub === "register-cron") {
    // Print a few example `hermes cron` invocations the user can run manually.
    console.log(`# Example Hermes cron tasks that drive osstack from a schedule.
# Adapt to your workflow and run any of these via \`hermes cron add\`.

# 1) Nightly stats roll-up (e.g. 03:00 local).
hermes cron add --schedule "0 3 * * *" --name osstack-nightly-stats -- \\
  bash -lc 'osstack stats > ~/.osstack/logs/stats-$(date +%F).txt'

# 2) Daily run-history pruning (keep last 30 days of events).
hermes cron add --schedule "30 3 * * *" --name osstack-prune -- \\
  bash -lc 'sqlite3 ~/.osstack/state.db "DELETE FROM events WHERE created_at < strftime(\\'%s\\',\\'now\\',\\'-30 days\\');"'

# 3) Weekly skill-registry check (skill-registry lands in S6; placeholder for now).
# hermes cron add --schedule "0 4 * * 1" --name osstack-skills-check -- osstack skills check
`);
    return 0;
  }

  if (sub === "help" || sub === undefined) {
    console.log(`osstack hermes — bridge commands

  osstack hermes health           Show bridge config + reachability
  osstack hermes dashboard        Open the Hermes WebUI in a browser
  osstack hermes register-cron    Print example \`hermes cron\` snippets

Env:
  HERMES_BIN              Override hermes binary path
  HERMES_KANBAN_BOARD     Board slug for sync (sync is OFF unless set)
  HERMES_WEBUI_PORT/HOST  Where the WebUI listens (default 127.0.0.1:8787)
`);
    return 0;
  }

  console.error(`osstack: unknown hermes subcommand "${sub}"`);
  return 1;
}

async function handleTaskCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "submit") {
    // Parse flags out of the arg list; everything else joins into the prompt.
    //   --kind <kind>        routing hint (e.g. research.ml)
    //   --agent <id>         pin a specific adapter (e.g. autoresearch)
    //   --tag <tag>          autoresearch run tag → context.tag
    //   --max-iter <n>       autoresearch iteration cap → context.max_iterations
    //   --repo <path>        autoresearch repo → context.repo_path
    const rest = args.slice(1);
    const flags: Record<string, string> = {};
    const promptParts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith("--") && i + 1 < rest.length) {
        flags[a.slice(2)] = rest[i + 1]!;
        i++;
      } else {
        promptParts.push(a);
      }
    }
    const prompt = promptParts.join(" ");
    if (!prompt) {
      console.error("osstack: task submit requires a prompt");
      return 1;
    }
    const params: Record<string, unknown> = { prompt };
    if (flags.kind) params.kind = flags.kind;
    if (flags.agent) params.agent_id = flags.agent;
    const context: Record<string, unknown> = {};
    if (flags.tag) context.tag = flags.tag;
    if (flags["max-iter"]) context.max_iterations = Number(flags["max-iter"]);
    if (flags.repo) context.repo_path = flags.repo;
    if (Object.keys(context).length > 0) params.context = context;
    return await streamTaskSubmit(params);
  }
  if (sub === "status") {
    const run_id = args[1];
    if (!run_id) {
      console.error("osstack: task status requires a run_id");
      return 1;
    }
    const resp = (await rpc("run.status", { run_id })) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "status failed");
      return 1;
    }
    console.log(JSON.stringify(resp.result, null, 2));
    return 0;
  }
  if (sub === "cancel") {
    const run_id = args[1];
    if (!run_id) {
      console.error("osstack: task cancel requires a run_id");
      return 1;
    }
    const resp = (await rpc("task.cancel", { run_id })) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "cancel failed");
      return 1;
    }
    console.log(JSON.stringify(resp.result, null, 2));
    return 0;
  }
  if (sub === "observe") {
    const run_id = args[1];
    if (!run_id) {
      console.error("osstack: task observe requires a run_id");
      return 1;
    }
    const after_seq = args[2] !== undefined ? Number.parseInt(args[2], 10) : undefined;
    return await streamTaskObserve(run_id, after_seq);
  }
  console.error(`osstack: unknown task subcommand "${sub}"`);
  return 1;
}

function streamFrames(method: string, params: unknown): Promise<number> {
  return new Promise((resolve) => {
    const sock = connect(socketPath());
    const decoder = new FrameDecoder();
    let exitCode = 0;
    sock.on("connect", () => sock.write(encodeFrame({ id: 1, method, params })));
    sock.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      for (const f of frames) {
        const obj = f as { ok?: boolean; type?: string; terminal?: boolean; error?: { code: string; message: string }; payload?: unknown };
        if (obj.ok === false) {
          console.error("osstack:", obj.error?.message ?? "rpc error");
          exitCode = 1;
          sock.destroy();
          return;
        }
        console.log(JSON.stringify(f));
        if (obj.terminal) {
          if (obj.type === "error") exitCode = 1;
          sock.end();
        }
      }
    });
    sock.on("close", () => resolve(exitCode));
    sock.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        console.error(`osstack: daemon not running (socket: ${socketPath()}). Start it with: osstack serve`);
      } else {
        console.error("osstack:", err.message);
      }
      resolve(1);
    });
  });
}

function streamTaskSubmit(params: Record<string, unknown>): Promise<number> {
  return streamFrames("task.submit", params);
}

function streamTaskObserve(run_id: string, after_seq?: number): Promise<number> {
  return streamFrames("task.observe", after_seq !== undefined ? { run_id, after_seq } : { run_id });
}

function printStats(result: unknown): void {
  const s = result as StatsResult;
  console.log(`total_runs=${s.total_runs}  total_events=${s.total_events}`);
  if (s.per_agent.length === 0) {
    console.log("(no runs recorded yet — submit a task with `osstack task submit \"...\"`)");
  } else {
    console.log();
    console.log("agent_id           capability_id                  runs ok  fail cncl iflt   avg_dur_ms    tok_in    tok_out  pii_red");
    console.log("-".repeat(120));
    for (const r of s.per_agent) {
      const avg = r.avg_duration_ms === null ? "—" : r.avg_duration_ms.toFixed(0);
      console.log(
        `${pad(r.agent_id, 18)} ${pad(r.capability_id, 30)} ${num(r.runs, 4)} ${num(r.completed, 3)} ${num(r.failed, 4)} ${num(r.cancelled, 4)} ${num(r.in_flight, 4)} ${pad(avg, 12)} ${num(r.total_tokens_in, 9)} ${num(r.total_tokens_out, 10)} ${num(r.total_pii_redacted, 8)}`,
      );
    }
  }

  if (s.loops === undefined) return;
  console.log();
  const loopAvg = s.loops.avg_cycle_duration_ms === null ? "—" : s.loops.avg_cycle_duration_ms.toFixed(0);
  console.log(
    `loop_sessions=${s.loops.total_sessions} running=${s.loops.running} stopping=${s.loops.stopping} stopped=${s.loops.stopped} failed=${s.loops.failed}`,
  );
  console.log(
    `loop_cycles=${s.loops.total_cycles} discovered=${s.loops.total_discovered} executed=${s.loops.total_executed} skipped=${s.loops.total_skipped} ok=${s.loops.total_successful} failed=${s.loops.total_failed} escalated=${s.loops.total_escalated} tokens=${s.loops.total_tokens_consumed} avg_cycle_ms=${loopAvg}`,
  );
  if (s.loops.per_loop.length === 0) return;
  console.log();
  console.log("loop_session_id      status    cycles exec ok fail escl avg_cycle_ms  tokens workspace");
  console.log("-".repeat(124));
  for (const loop of s.loops.per_loop) {
    const avg = loop.avg_cycle_duration_ms === null ? "—" : loop.avg_cycle_duration_ms.toFixed(0);
    console.log(
      `${pad(loop.loop_session_id, 20)} ${pad(loop.status, 9)} ${num(loop.cycle_count, 6)} ${num(loop.executed_task_count, 4)} ${num(loop.successful_task_count, 2)} ${num(loop.failed_task_count, 4)} ${num(loop.escalated_task_count, 4)} ${pad(avg, 13)} ${num(loop.tokens_consumed, 6)} ${loop.workspace_path}`,
    );
  }
}

function pad(s: string, n: number): string { return s.length >= n ? s : `${s}${" ".repeat(n - s.length)}`; }
function num(n: number, w: number): string {
  const s = String(n);
  return s.length >= w ? s : `${" ".repeat(w - s.length)}${s}`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("osstack:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
