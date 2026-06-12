// osstack CLI entry. Talks to the running daemon via Unix socket when needed.
// (shebang is injected by tsup banner)

import { connect, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { initProject } from "@osstack/skills";
import {
  addSource, checkAll, defaultManifestPath, readManifest,
  removeSource, writeManifest,
} from "@osstack/skill-registry";
import { startDaemon } from "./daemon.js";
import { handleConfigCommand } from "./config.js";
import { resolveSocketPath } from "./paths.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";
import { handleUpgradeCommand } from "./upgrade.js";

function socketPath(): string {
  return resolveSocketPath();
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

async function main(): Promise<number> {
  const args = process.argv.slice(2);
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
  serve               Start the daemon (Unix socket at ${socketPath()})
  health              Show daemon health (requires running daemon)
  status              CLI/daemon version handshake + update availability
  stats               Show per-agent metrics (requires running daemon)
  killswitch          Check if the policy layer is earning its keep (F4)
  agent list          List registered sub-agents and their capabilities

Self-update:
  upgrade [--channel latest|canary] [--dry-run] [--auto]
                      Backup state.db, drain + stop the daemon, install the
                      newest @osstack/cli from npm, restart, health-check,
                      and roll back automatically on failure.

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
  OSSTACK_SOCKET      Daemon socket path (default $OSSTACK_HOME/daemon.sock)
  OSSTACK_UPDATE_CHECK  Set 0 to disable the daemon's daily update probe

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

  if (cmd === "status") {
    // Version handshake: compare this CLI binary against the live daemon and
    // surface update availability from the daemon's cached registry probe.
    console.log(`cli_version:      ${VERSION}`);
    console.log(`protocol_version: ${PROTOCOL_VERSION}`);
    let daemon: { version?: string; protocol_version?: number } | null = null;
    try {
      const resp = (await rpc("version", undefined, 3_000)) as RpcResp;
      if (resp.ok) daemon = resp.result as { version?: string; protocol_version?: number };
    } catch { /* not running */ }
    if (daemon === null) {
      console.log("daemon:           not running");
      return 0;
    }
    console.log(`daemon_version:   ${daemon.version ?? "?"}`);
    if (daemon.version !== undefined && daemon.version !== VERSION) {
      console.log(`⚠ version mismatch — restart the daemon to pick up ${VERSION} (osstack upgrade handles this automatically)`);
    }
    if (daemon.protocol_version !== undefined && daemon.protocol_version !== PROTOCOL_VERSION) {
      console.log(`⚠ protocol mismatch (cli=${PROTOCOL_VERSION} daemon=${daemon.protocol_version}) — upgrade both sides`);
    }
    try {
      const u = (await rpc("update.status", undefined, 3_000)) as RpcResp;
      const cache = (u.result as { cache?: { latest?: string | null; update_available?: boolean; checked_at?: number } })?.cache;
      if (cache?.update_available && typeof cache.latest === "string") {
        console.log(`update available: ${cache.latest} (run: osstack upgrade)`);
      } else if (cache?.latest != null) {
        console.log(`registry latest:  ${cache.latest} (up to date)`);
      } else {
        console.log("registry latest:  unknown (no successful probe yet)");
      }
    } catch { /* older daemon without update.status */ }
    return 0;
  }

  if (cmd === "upgrade") {
    return await handleUpgradeCommand(args.slice(1), rpc);
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
  const s = result as { total_runs: number; total_events: number; per_agent: Array<{
    agent_id: string; capability_id: string; runs: number;
    completed: number; failed: number; cancelled: number; in_flight: number;
    avg_duration_ms: number | null; total_tokens_in: number; total_tokens_out: number;
    total_pii_redacted: number;
  }> };
  console.log(`total_runs=${s.total_runs}  total_events=${s.total_events}`);
  if (s.per_agent.length === 0) {
    console.log("(no runs recorded yet — submit a task with `osstack task submit \"...\"`)");
    return;
  }
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

function pad(s: string, n: number): string { return s.length >= n ? s : `${s}${" ".repeat(n - s.length)}`; }
function num(n: number, w: number): string {
  const s = String(n);
  return s.length >= w ? s : `${" ".repeat(w - s.length)}${s}`;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("osstack:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
