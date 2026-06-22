// osstack CLI entry. Talks to the running daemon via Unix socket when needed.
// (shebang is injected by tsup banner)

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { defaultAdapters } from "@osstack/agents";
import {
  getCompliancePack,
  listCompliancePacks,
  renderComplianceReport,
  renderComplianceReportFromProofDir,
  renderProofViewFromProofDir,
  type ProofAudience,
} from "@osstack/compliance";
import { getAgentScorecard, listAgentScorecards, listPitfallLessons, openDb, upsertPitfallLesson } from "@osstack/core";
import { scanFiles, type GovernanceFinding } from "@osstack/governance";
import {
  renderBranchStewardReport,
  scanBranchStewardCandidates,
  type BranchStewardConfig,
} from "@osstack/github";
import {
  LoopEngine,
  enqueueTask,
  readLoopState,
  renderLoopStateMarkdown,
  renderLoopStateReportFromState,
  renderLoopStateReportFromStateAndEvents,
  createLoopStateReport,
  createLoopStateScorecardFromState,
  renderLoopStateScorecardHtml,
  renderLoopStateScorecardMarkdown,
  type LoopEvent,
  type LoopState,
} from "@osstack/loop";
import {
  cacheKnowledgeFeedback,
  evaluateKnowledgeRetrieval,
  importKnowledgeSource,
  listCachedKnowledgePacks,
  loadKnowledgePack,
  pinKnowledgePack,
  resolveKnowledgeSearch,
  syncKnowledgeCache,
  type KnowledgeScope,
  type KnowledgeMode,
  type KnowledgeRetrievalEvalCase,
  type KnowledgeSearchEvidence,
} from "@osstack/knowledge";
import { initProject } from "@osstack/skills";
import {
  addSource, checkAll, defaultManifestPath, readManifest,
  removeSource, writeManifest,
} from "@osstack/skill-registry";
import { startDaemon } from "./daemon.js";
import { handleConfigCommand } from "./config.js";
import { osstackHome, resolveSocketPath } from "./paths.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";
import { handleUpgradeCommand } from "./upgrade.js";

const execFileAsync = promisify(execFile);

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
  serve               Start the daemon (Unix socket at ${socketPath()})
  health              Show daemon health (requires running daemon)
  status              CLI/daemon version handshake + update availability
  dashboard url       Print the local development dashboard URL
  dashboard open      Open the local development dashboard in a browser
  cockpit [url|open|snapshot]
                      Product cockpit alias for dashboard
  stats               Show per-agent and loop metrics (requires running daemon)
  killswitch          Check if the policy layer is earning its keep (F4)
  agent list          List registered sub-agents and their capabilities
  agent scorecard [agent_id]
                      Show agent run-history scorecards

Self-update:
  upgrade [--channel latest|canary] [--dry-run] [--auto]
                      Backup state.db, drain + stop the daemon, install the
                      newest @osstack/cli from npm, restart, health-check,
                      and roll back automatically on failure.

Project commands:
  init [dir]          Scaffold OSBORN project layout (V2 osb-init)
  deliver <prompt> [--verify CMD] [--auto-agent] [--worktree]
                      Product entry: task queue -> loop -> report/scorecard/proof

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
  report [--workspace P] [--state P]
                                 Render an evidence-oriented report from LOOP-STATE.json
  scorecard [--workspace P] [--state P] [--output-dir P] [--stdout]
                                 Generate Markdown + HTML evidence scorecards
  proof [--workspace P] [--state P] [--output-dir P] [--json]
                                 Generate a checksumed local proof pack
  pr [run_id] [--workspace P] [--state P] [--events P] [--proof-dir P] [--dry-run]
                                 Write a GitHub-ready PR body from run evidence
  loop run [--workspace P] [--source S] [--execute CMD] [--verify CMD]
           [--reviewer ID] [--checker ID] [--goal CMD] [--max-iter N] [--cycles N] [--interval-ms N]
           [--state P] [--markdown P] [--worktree] [--report] [--scorecard] [--proof] [--json] [--daemon]
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

Branch Steward:
  steward scan [--repo O/R] [--base B] [--remote R] [--workspace P] [--json]

Governance:
  governance scan <path...> [--json]
                                 Run deterministic governance checks over files
  compliance list [--json]
                                 List compliance mapping packs
  compliance render <run_id> --pack P [--proof-dir P]
                                 Render a compliance evidence mapping report
  knowledge list --pack P [--json]
                                 List local Osstack knowledge packs
  knowledge search <query> [--pack P] [--cloud-url URL] [--json]
                                 Search Osstack knowledge packs or cloud
  knowledge import P --scope team|project --output P
                                 Import local docs as an Osstack-native pack
  lessons list [--family F] [--json]
                                 List learned local pitfall lessons
  lessons learn [--workspace P] [--state P] [--json]
                                 Extract pitfall lessons from LOOP-STATE.json

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

  if (cmd === "dashboard" || cmd === "cockpit") {
    return await handleDashboardCommand(args.slice(1));
  }

  if (cmd === "agent") {
    return await handleAgentCommand(args.slice(1));
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

  if (cmd === "deliver") {
    return await handleDeliverCommand(args.slice(1));
  }

  if (cmd === "report") {
    return await handleReportCommand(args.slice(1));
  }

  if (cmd === "scorecard") {
    return await handleScorecardCommand(args.slice(1));
  }

  if (cmd === "proof") {
    return await handleProofCommand(args.slice(1));
  }

  if (cmd === "pr") {
    return await handlePrCommand(args.slice(1));
  }

  if (cmd === "steward") {
    return await handleStewardCommand(args.slice(1));
  }

  if (cmd === "governance") {
    return await handleGovernanceCommand(args.slice(1));
  }

  if (cmd === "compliance") {
    return await handleComplianceCommand(args.slice(1));
  }

  if (cmd === "knowledge") {
    return await handleKnowledgeCommand(args.slice(1));
  }

  if (cmd === "lessons") {
    return await handleLessonsCommand(args.slice(1));
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

async function handleAgentCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack agent — agent registry and performance

  osstack agent list
  osstack agent scorecard [agent_id] [--json]
`);
    return 0;
  }

  if (sub === "list") {
    const resp = (await rpc("agent.list")) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "agent.list failed");
      return 1;
    }
    console.log(JSON.stringify(resp.result, null, 2));
    return 0;
  }

  if (sub === "scorecard") {
    const agentId = positionalValues(args.slice(1), new Set()).find((value) => value !== "scorecard");
    const dbPath = await ensureLocalStateDbPath();
    const db = openDb({ path: dbPath });
    try {
      if (agentId !== undefined) {
        const scorecard = getAgentScorecard(db, agentId);
        if (args.includes("--json")) {
          console.log(JSON.stringify(scorecard, null, 2));
        } else {
          printAgentScorecard(scorecard);
        }
        return 0;
      }
      const scorecards = listAgentScorecards(db);
      if (args.includes("--json")) {
        console.log(JSON.stringify({ scorecards }, null, 2));
      } else if (scorecards.length === 0) {
        console.log("No agent run history yet.");
      } else {
        for (const scorecard of scorecards) printAgentScorecard(scorecard);
      }
      return 0;
    } finally {
      db.close();
    }
  }

  console.error(`osstack: unknown agent subcommand "${sub}"`);
  return 1;
}

function printAgentScorecard(scorecard: ReturnType<typeof getAgentScorecard>): void {
  console.log(`${scorecard.agent_id}`);
  console.log(`  runs=${scorecard.total_runs} completed=${scorecard.completed_runs} failed=${scorecard.failed_runs} success=${Math.round(scorecard.success_rate * 100)}%`);
  console.log(`  avg_duration_ms=${scorecard.avg_duration_ms ?? "unknown"} cost_tier=${scorecard.cost_tier} fit=${scorecard.capability_fit}`);
  console.log(`  recent_failures=${scorecard.recent_failures}`);
  if (scorecard.best_task_kinds.length > 0) {
    console.log(`  best_task_kinds=${scorecard.best_task_kinds.map((kind) => `${kind.kind}:${Math.round(kind.success_rate * 100)}%`).join(", ")}`);
  }
  if (scorecard.warnings.length > 0) {
    console.log(`  warnings=${scorecard.warnings.join("; ")}`);
  }
}

function printStewardHelp(): void {
  console.log(`osstack steward — Branch Steward dry-run reports

  osstack steward scan [--repo O/R] [--base B] [--remote R] [--workspace P] [--json]
  osstack steward help
`);
}

async function handleStewardCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printStewardHelp();
    return 0;
  }

  if (sub !== "scan") {
    console.error(`osstack: unknown steward subcommand "${sub}"`);
    return 1;
  }

  const workspacePathValue = stewardFlagValue(args, "--workspace");
  const repoValue = stewardFlagValue(args, "--repo");
  const baseValue = stewardFlagValue(args, "--base");
  const remoteValue = stewardFlagValue(args, "--remote");
  if (workspacePathValue instanceof Error) {
    console.error(`osstack: ${workspacePathValue.message}`);
    return 1;
  }
  if (repoValue instanceof Error) {
    console.error(`osstack: ${repoValue.message}`);
    return 1;
  }
  if (baseValue instanceof Error) {
    console.error(`osstack: ${baseValue.message}`);
    return 1;
  }
  if (remoteValue instanceof Error) {
    console.error(`osstack: ${remoteValue.message}`);
    return 1;
  }

  const workspacePath = workspacePathValue ?? process.cwd();
  const remote = remoteValue ?? "origin";
  const repo = repoValue ?? await inferGitHubRepoSlug(workspacePath, remote);
  if (repo === undefined) {
    console.error(`osstack: unable to infer GitHub repo from ${remote} remote; pass --repo owner/repo`);
    return 1;
  }

  const config: BranchStewardConfig = {
    repo,
    base: baseValue ?? "main",
    remote,
    branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
    sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
    maxChangedFiles: 80,
    maxBehindBy: 25,
    prThreshold: 80,
    autoMergeThreshold: 90,
  };

  let report: Awaited<ReturnType<typeof scanBranchStewardCandidates>>;
  try {
    report = await scanBranchStewardCandidates(config, undefined, { cwd: workspacePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`osstack: steward scan failed: ${message}`);
    return 1;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderBranchStewardReport(report));
  }
  return 0;
}

async function inferGitHubRepoSlug(workspacePath: string, remote: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", remote], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 10_000,
    });
    return parseGitHubRepoSlug(String(stdout).trim());
  } catch {
    return undefined;
  }
}

function stewardFlagValue(args: string[], name: string): string | undefined | Error {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    return new Error(`${name} requires a value`);
  }
  return value;
}

function parseGitHubRepoSlug(remoteUrl: string): string | undefined {
  const match = remoteUrl.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`;
}

async function handleGovernanceCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack governance — deterministic run governance checks

  osstack governance scan <path...> [--json]
`);
    return 0;
  }

  if (sub !== "scan") {
    console.error(`osstack: unknown governance subcommand "${sub}"`);
    return 1;
  }

  const paths = positionalValues(args.slice(1), new Set()).filter((value) => value !== "scan");
  if (paths.length === 0) {
    console.error("osstack: governance scan requires at least one path");
    return 1;
  }

  const result = await scanFiles(paths);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printGovernanceScan(result);
  }
  return result.ok ? 0 : 2;
}

function printGovernanceScan(result: Awaited<ReturnType<typeof scanFiles>>): void {
  if (result.findings.length === 0) {
    console.log("Governance scan clean.");
    return;
  }
  console.log(`Governance findings: ${result.findings.length}`);
  for (const finding of result.findings) {
    const location = finding.file === undefined ? `line ${finding.line}` : `${finding.file}:${finding.line}`;
    console.log(`- [${finding.severity}] ${finding.rule_id} ${location} - ${finding.message}`);
  }
}

async function handleComplianceCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack compliance — evidence mapping reports

  osstack compliance list [--json]
  osstack compliance render <run_id> --pack engineering-readiness [--proof-dir P] [--workspace P] [--output P] [--json]

Notes:
  Compliance reports map osstack proof evidence to internal controls.
  They do not claim SOC 2, ISO 27001, EU AI Act, or third-party certification.
`);
    return 0;
  }

  if (sub === "list") {
    const packs = listCompliancePacks().map((pack) => ({
      id: pack.id,
      version: pack.version,
      name: pack.name,
      certification_claim: pack.certification_claim,
      controls: pack.controls.length,
    }));
    if (args.includes("--json")) {
      console.log(JSON.stringify({ packs }, null, 2));
    } else {
      for (const pack of packs) {
        console.log(`${pack.id}@${pack.version} ${pack.name} claim=${pack.certification_claim} controls=${pack.controls}`);
      }
    }
    return 0;
  }

  if (sub === "render") {
    const runId = firstPositionalValue(args.slice(1), new Set(["--pack", "--proof-dir", "--workspace", "--output"]));
    if (runId === undefined) {
      console.error("osstack: compliance render requires a run_id");
      return 1;
    }
    const packId = flagValue(args, "--pack");
    if (packId === undefined) {
      console.error("osstack: compliance render requires --pack");
      return 1;
    }
    let packVersion: string;
    try {
      packVersion = getCompliancePack(packId).version;
    } catch (error) {
      console.error(`osstack: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const proofDir = flagValue(args, "--proof-dir") ?? join(workspacePath, "release", `osstack-proof-${safeFileSegment(runId)}`);
    const output = flagValue(args, "--output") ?? join(workspacePath, "reports", `compliance-${packId}-${safeFileSegment(runId)}.md`);
    const markdown = await renderComplianceReportFromProofDir({ packId, runId, proofDir });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, markdown, "utf-8");
    if (args.includes("--json")) {
      console.log(JSON.stringify({ run_id: runId, pack_id: packId, pack_version: packVersion, output }, null, 2));
    } else {
      console.log(`compliance=${output}`);
      console.log(`pack=${packId}@${packVersion}`);
    }
    return 0;
  }

  console.error(`osstack: unknown compliance subcommand "${sub}"`);
  return 1;
}

async function handleKnowledgeCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack knowledge — Osstack knowledge pack bootstrap and cloud client

  osstack knowledge list --pack P [--json]
  osstack knowledge sync [--cloud-url URL] [--cache-dir P] [--json]
  osstack knowledge search <query> [--pack P] [--cloud-url URL] [--cache-dir P] [--limit N] [--json]
  osstack knowledge import P --scope team|project --id ID --name NAME --license L --output P [--taxonomy T] [--json]
  osstack knowledge pin <pack_id>@<version> [--cache-dir P] [--json]
  osstack knowledge feedback <chunk_id> --useful|--bad [--cloud-url URL] [--cache-dir P] [--json]
  osstack knowledge eval --pack P --fixtures P [--top-k N] [--json]
  osstack knowledge sources --internal --pack P [--json]

Env:
  OSSTACK_KNOWLEDGE_URL  Default Knowledge Cloud base URL
  OSSTACK_KNOWLEDGE_CACHE_DIR
                         Default local Knowledge Cloud cache directory
`);
    return 0;
  }

  if (sub === "list") {
    const packPaths = flagValues(args, "--pack");
    if (packPaths.length === 0) {
      console.error("osstack: knowledge list requires at least one --pack path");
      return 1;
    }
    const packs = await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath)));
    const summaries = packs.map((pack) => ({
      id: pack.manifest.id,
      version: pack.manifest.version,
      name: pack.manifest.name,
      license: pack.manifest.license,
      source_kind: pack.manifest.source_kind,
      quality_score: pack.manifest.quality_score,
      chunks: pack.manifest.chunks.length,
      path: pack.path,
    }));
    if (args.includes("--json")) {
      console.log(JSON.stringify({ packs: summaries }, null, 2));
    } else {
      for (const pack of summaries) {
        console.log(`${pack.id}@${pack.version} ${pack.name}`);
        console.log(`  license=${pack.license} source_kind=${pack.source_kind} quality=${pack.quality_score} chunks=${pack.chunks}`);
      }
    }
    return 0;
  }

  if (sub === "sync") {
    const cloudUrl = flagValue(args, "--cloud-url") ?? process.env["OSSTACK_KNOWLEDGE_URL"];
    if (cloudUrl === undefined) {
      console.error("osstack: knowledge sync requires --cloud-url or OSSTACK_KNOWLEDGE_URL");
      return 1;
    }
    const evidence = await syncKnowledgeCache({
      cacheDir: knowledgeCacheDir(args),
      cloudUrl,
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(evidence, null, 2));
    } else if (evidence.status === "synced") {
      console.log(`synced=${evidence.packs.length}`);
      console.log(`cache=${evidence.cache_dir}`);
    } else {
      console.error(`osstack: knowledge sync failed: ${evidence.reason ?? "unknown"}`);
      return 1;
    }
    return evidence.status === "synced" ? 0 : 1;
  }

  if (sub === "search") {
    const packPaths = flagValues(args, "--pack");
    const cloudUrl = flagValue(args, "--cloud-url") ?? process.env["OSSTACK_KNOWLEDGE_URL"];
    const mode = parseKnowledgeMode(flagValue(args, "--mode"));
    if (mode === undefined && flagValue(args, "--mode") !== undefined) {
      console.error("osstack: --mode must be one of off, local, cloud");
      return 1;
    }
    const query = positionalValues(args.slice(1), new Set(["--pack", "--limit", "--cloud-url", "--mode", "--cache-dir"])).join(" ");
    if (query.length === 0) {
      console.error("osstack: knowledge search requires a query");
      return 1;
    }
    const limitRaw = flagValue(args, "--limit");
    const limit = limitRaw === undefined ? 5 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      console.error("osstack: --limit must be a positive integer");
      return 1;
    }
    const packs = [
      ...await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath))),
      ...await listCachedKnowledgePacks(knowledgeCacheDir(args)),
    ];
    if (packs.length === 0 && cloudUrl === undefined && mode !== "off") {
      console.error("osstack: knowledge search requires at least one --pack path, cached pack, or --cloud-url");
      return 1;
    }
    const evidence = await resolveKnowledgeSearch({
      mode,
      query,
      packs,
      limit,
      cloudUrl,
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(evidence, null, 2));
    } else if (evidence.results.length === 0) {
      console.log("No knowledge chunks matched.");
    } else {
      if (evidence.fallback_mode !== undefined && evidence.reason !== undefined) {
        console.log(`Knowledge fallback: ${evidence.fallback_mode} (${evidence.reason})`);
      }
      for (const result of evidence.results) {
        console.log(`${result.pack_id}:${result.chunk_id} score=${result.score} ${result.title}`);
        console.log(result.snippet);
      }
    }
    return 0;
  }

  if (sub === "import") {
    const sourcePath = firstPositionalValue(args.slice(1), new Set([
      "--scope",
      "--id",
      "--name",
      "--license",
      "--output",
      "--taxonomy",
      "--quality-score",
    ]));
    if (sourcePath === undefined) {
      console.error("osstack: knowledge import requires a source path");
      return 1;
    }
    const scope = parseKnowledgeScope(flagValue(args, "--scope"));
    if (scope === undefined) {
      console.error("osstack: --scope must be one of official, team, project");
      return 1;
    }
    const id = flagValue(args, "--id");
    const name = flagValue(args, "--name");
    const license = flagValue(args, "--license");
    const output = flagValue(args, "--output");
    if (id === undefined || name === undefined || license === undefined || output === undefined) {
      console.error("osstack: knowledge import requires --id, --name, --license, and --output");
      return 1;
    }
    const qualityScoreRaw = flagValue(args, "--quality-score");
    const qualityScore = qualityScoreRaw === undefined ? undefined : Number.parseInt(qualityScoreRaw, 10);
    if (qualityScoreRaw !== undefined && (!Number.isInteger(qualityScore) || qualityScore < 0 || qualityScore > 100)) {
      console.error("osstack: --quality-score must be an integer from 0 to 100");
      return 1;
    }
    const manifest = await importKnowledgeSource({
      path: sourcePath,
      id,
      name,
      license,
      scope,
      taxonomy: flagValues(args, "--taxonomy"),
      ...(qualityScore === undefined ? {} : { qualityScore }),
    });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        pack_id: manifest.id,
        output,
        chunks: manifest.chunks.length,
        sources: manifest.source_provenance?.length ?? 0,
      }, null, 2));
    } else {
      console.log(`Imported ${manifest.chunks.length} chunk(s) into ${output}`);
    }
    return 0;
  }

  if (sub === "pin") {
    const spec = firstPositionalValue(args.slice(1), new Set(["--cache-dir"]));
    if (spec === undefined) {
      console.error("osstack: knowledge pin requires <pack_id>@<version>");
      return 1;
    }
    try {
      const pin = await pinKnowledgePack(knowledgeCacheDir(args), spec);
      if (args.includes("--json")) {
        console.log(JSON.stringify({ pin }, null, 2));
      } else {
        console.log(`pinned=${pin.pack_id}@${pin.version}`);
      }
      return 0;
    } catch (error) {
      console.error(`osstack: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (sub === "feedback") {
    const chunkId = firstPositionalValue(args.slice(1), new Set(["--cloud-url", "--cache-dir"]));
    if (chunkId === undefined) {
      console.error("osstack: knowledge feedback requires <chunk_id>");
      return 1;
    }
    const useful = args.includes("--useful");
    const bad = args.includes("--bad");
    if (useful === bad) {
      console.error("osstack: knowledge feedback requires exactly one of --useful or --bad");
      return 1;
    }
    const feedback = await cacheKnowledgeFeedback({
      cacheDir: knowledgeCacheDir(args),
      chunkId,
      rating: useful ? "useful" : "bad",
      cloudUrl: flagValue(args, "--cloud-url") ?? process.env["OSSTACK_KNOWLEDGE_URL"],
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify({ feedback }, null, 2));
    } else {
      console.log(`feedback=${feedback.chunk_id} ${feedback.rating} ${feedback.status}`);
    }
    return 0;
  }

  if (sub === "eval") {
    const packPaths = flagValues(args, "--pack");
    const fixturesPath = flagValue(args, "--fixtures");
    if (packPaths.length === 0 || fixturesPath === undefined) {
      console.error("osstack: knowledge eval requires --pack and --fixtures");
      return 1;
    }
    const topKRaw = flagValue(args, "--top-k");
    const topK = topKRaw === undefined ? 3 : Number.parseInt(topKRaw, 10);
    if (!Number.isInteger(topK) || topK <= 0) {
      console.error("osstack: --top-k must be a positive integer");
      return 1;
    }
    const packs = await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath)));
    const fixtures = JSON.parse(await readFile(fixturesPath, "utf-8")) as KnowledgeRetrievalEvalCase[];
    const summary = evaluateKnowledgeRetrieval(packs, fixtures, { topK });
    if (args.includes("--json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`retrieval_eval=${summary.passed}/${summary.total} top_k=${summary.top_k}`);
      for (const result of summary.results.filter((item) => !item.matched)) {
        console.log(`MISSING ${result.id} expected=${result.expected_chunk_id} top=${result.top_chunk_ids.join(",")}`);
      }
    }
    return summary.failed === 0 ? 0 : 2;
  }

  if (sub === "sources") {
    const packPath = flagValue(args, "--pack");
    if (packPath === undefined) {
      console.error("osstack: knowledge sources requires --pack");
      return 1;
    }
    if (!args.includes("--internal")) {
      console.error("osstack: knowledge sources requires --internal to show provenance");
      return 1;
    }
    const pack = await loadKnowledgePack(packPath);
    const sources = pack.manifest.source_provenance ?? [];
    if (args.includes("--json")) {
      console.log(JSON.stringify({ pack_id: pack.manifest.id, sources }, null, 2));
    } else {
      for (const source of sources) {
        console.log(`${source.source_id} ${source.path} scope=${source.scope} license=${source.license}`);
      }
    }
    return 0;
  }

  console.error(`osstack: unknown knowledge subcommand "${sub}"`);
  return 1;
}

function parseKnowledgeMode(value: string | undefined): KnowledgeMode | undefined {
  if (value === undefined) return undefined;
  if (value === "off" || value === "local" || value === "cloud") return value;
  return undefined;
}

function knowledgeCacheDir(args: string[]): string {
  return flagValue(args, "--cache-dir")
    ?? process.env["OSSTACK_KNOWLEDGE_CACHE_DIR"]
    ?? join(osstackHome(), "knowledge-cache");
}

function parseKnowledgeScope(value: string | undefined): KnowledgeScope | undefined {
  if (value === "official" || value === "team" || value === "project") return value;
  return undefined;
}

async function handleLessonsCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack lessons — local pitfall knowledge base

  osstack lessons list [--family F] [--limit N] [--json]
  osstack lessons learn [--workspace P] [--state P] [--json]
`);
    return 0;
  }

  if (sub === "list") {
    const limit = parsePositiveIntegerFlag(flagValue(args, "--limit"), "--limit");
    if (limit instanceof Error) {
      console.error(`osstack: ${limit.message}`);
      return 1;
    }
    const dbPath = await ensureLocalStateDbPath();
    const db = openDb({ path: dbPath });
    try {
      const lessons = listPitfallLessons(db, {
        ...(flagValue(args, "--family") !== undefined ? { family: flagValue(args, "--family") } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify({ lessons }, null, 2));
      } else if (lessons.length === 0) {
        console.log("No lessons recorded yet.");
      } else {
        for (const lesson of lessons) {
          console.log(`${lesson.pitfall_id} ${lesson.family} verified=${lesson.verified_count}`);
          console.log(`  symptom=${lesson.symptom}`);
          console.log(`  resolution=${lesson.resolution}`);
        }
      }
      return 0;
    } finally {
      db.close();
    }
  }

  if (sub === "learn") {
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const statePath = resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
    const state = await readLoopState(statePath);
    if (state === null) {
      console.error(`osstack: no loop state found at ${statePath}`);
      return 1;
    }
    const candidates = derivePitfallLessonsFromState(state);
    const dbPath = await ensureLocalStateDbPath();
    const db = openDb({ path: dbPath });
    try {
      const lessons = candidates.map((candidate) => upsertPitfallLesson(db, dbPath, candidate));
      if (args.includes("--json")) {
        console.log(JSON.stringify({ learned: lessons.length, lessons }, null, 2));
      } else {
        console.log(`learned=${lessons.length}`);
        for (const lesson of lessons) {
          console.log(`${lesson.pitfall_id} ${lesson.family} verified=${lesson.verified_count}`);
        }
      }
      return 0;
    } finally {
      db.close();
    }
  }

  console.error(`osstack: unknown lessons subcommand "${sub}"`);
  return 1;
}

async function ensureLocalStateDbPath(): Promise<string> {
  const home = osstackHome();
  await mkdir(home, { recursive: true });
  return join(home, "state.db");
}

function derivePitfallLessonsFromState(state: LoopState): Parameters<typeof upsertPitfallLesson>[2][] {
  return state.completed_tasks
    .filter((task) => task.outcome === "failed" || task.outcome === "escalated")
    .map((task) => ({
      family: task.outcome === "failed" ? "verify_failed" : "max_iter_escalation",
      tech_stack: inferLessonTechStack(task.capability),
      symptom: `${task.task_id} ended with ${task.outcome} after ${task.iterations} iteration${task.iterations === 1 ? "" : "s"}.`,
      resolution: task.outcome === "failed"
        ? "Inspect verifier output, rerun deterministic checks, and update the task or dependency setup before retrying."
        : "Break the task into a smaller queue item, add a stronger verify gate, or route to a reviewer/checker before retrying.",
      source_run_id: state.loop_id,
    }));
}

async function learnLessonsFromLoopState(state: LoopState): Promise<{
  learned: number;
  lessons: ReturnType<typeof upsertPitfallLesson>[];
} | undefined> {
  const candidates = derivePitfallLessonsFromState(state);
  if (candidates.length === 0) return undefined;
  try {
    const dbPath = await ensureLocalStateDbPath();
    const db = openDb({ path: dbPath });
    try {
      const lessons = candidates.map((candidate) => upsertPitfallLesson(db, dbPath, candidate));
      return { learned: lessons.length, lessons };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function inferLessonTechStack(capability: string | undefined): string[] {
  if (capability === undefined || capability.length === 0) return ["unknown"];
  return [...new Set(capability.split(/[.:_-]+/).filter((part) => part.length > 0))];
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

type GovernanceProofEvidence =
  | {
    status: "pass" | "fail";
    ok: boolean;
    scanned_files: number;
    findings: GovernanceFinding[];
  }
  | {
    status: "unknown";
    ok: false;
    scanned_files: 0;
    reason: string;
    findings: GovernanceFinding[];
  };

type KnowledgeProofEvidence = KnowledgeSearchEvidence;

interface PrReadinessCheck {
  id: string;
  status: "ok" | "warn" | "error";
  summary: string;
}

interface PrReadinessResult {
  ok: boolean;
  checks: PrReadinessCheck[];
}

async function handleReportCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack report — evidence-oriented loop report

  osstack report [run_id] [--workspace P] [--state P] [--events P]

Options:
  --workspace P       Workspace containing LOOP-STATE.json (default: cwd)
  --state P           JSON state path (default: LOOP-STATE.json)
  --events P          Optional loop events JSONL path for timeline evidence
`);
    return 0;
  }

  const runId = firstPositionalValue(args, new Set(["--workspace", "--state", "--events"]));
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const evidenceResult = runId === undefined
    ? undefined
    : await readPersistedLoopRunEvidence(runId);
  if (evidenceResult instanceof Error) {
    console.error(`osstack: ${evidenceResult.message}`);
    return 1;
  }
  const stateFilePath = evidenceResult?.state_json
    ?? resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  const state = await readLoopState(stateFilePath);
  if (state === null) {
    console.error(`osstack: no loop state found at ${stateFilePath}`);
    return 1;
  }
  const events = evidenceResult?.events ?? await readLoopEventsJsonlFlag(args, workspacePath);
  console.log(renderReportMarkdownForArtifacts(state, events));
  return 0;
}

async function handleScorecardCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack scorecard — loop evidence scorecard

  osstack scorecard [run_id] [--workspace P] [--state P] [--output-dir P] [--stdout]

Options:
  --workspace P       Workspace containing LOOP-STATE.json (default: cwd)
  --state P           JSON state path (default: LOOP-STATE.json)
  --output-dir P      Directory for scorecard files (default: <workspace>/release)
  --stdout            Print Markdown instead of writing files
`);
    return 0;
  }

  const runId = firstPositionalValue(args, new Set(["--workspace", "--state", "--output-dir"]));
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const evidenceResult = runId === undefined
    ? undefined
    : await readPersistedLoopRunEvidence(runId);
  if (evidenceResult instanceof Error) {
    console.error(`osstack: ${evidenceResult.message}`);
    return 1;
  }
  const stateFilePath = evidenceResult?.state_json
    ?? resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  const state = await readLoopState(stateFilePath);
  if (state === null) {
    console.error(`osstack: no loop state found at ${stateFilePath}`);
    return 1;
  }

  const scorecard = createLoopStateScorecardFromState(state);
  const markdown = renderLoopStateScorecardMarkdown(scorecard);
  if (args.includes("--stdout")) {
    console.log(markdown);
    return 0;
  }

  const outputDir = resolveLoopPath(flagValue(args, "--output-dir") ?? "release", workspacePath);
  const baseName = `osstack-scorecard-${safeFileSegment(runId ?? scorecard.loop_id)}`;
  const markdownPath = join(outputDir, `${baseName}.md`);
  const htmlPath = join(outputDir, `${baseName}.html`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(markdownPath, markdown, "utf-8");
  await writeFile(htmlPath, renderLoopStateScorecardHtml(scorecard), "utf-8");
  console.log(`markdown=${markdownPath}`);
  console.log(`html=${htmlPath}`);
  console.log(`score=${scorecard.total_score}/${scorecard.max_score}`);
  return 0;
}

async function handleProofCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack proof — local evidence proof pack

  osstack proof [run_id] [--workspace P] [--state P] [--events P] [--knowledge-pack P] [--knowledge-mode M] [--knowledge-cloud-url URL] [--knowledge-query Q] [--compliance-pack P] [--output-dir P] [--json]
  osstack proof view <run_id> --audience engineer|manager|auditor|customer [--proof-dir P] [--workspace P] [--output P] [--json]

Options:
  --workspace P       Workspace containing LOOP-STATE.json (default: cwd)
  --state P           JSON state path (default: LOOP-STATE.json)
  --events P          Optional loop events JSONL path to include in the pack
  --knowledge-pack P  Optional local knowledge pack path to trace in evidence
  --knowledge-mode M  off, local, or cloud
  --knowledge-cloud-url URL
                      Optional Knowledge Cloud base URL
  --knowledge-query Q Query used for knowledge trace search
  --compliance-pack P
                      Optional compliance mapping pack to include
  --output-dir P      Directory for proof pack folders (default: <workspace>/release)
  --json              Print machine-readable summary
`);
    return 0;
  }

  if (args[0] === "view") {
    return await handleProofViewCommand(args.slice(1));
  }

  const runId = firstPositionalValue(args, new Set([
    "--workspace",
    "--state",
    "--events",
    "--knowledge-pack",
    "--knowledge-mode",
    "--knowledge-cloud-url",
    "--knowledge-query",
    "--compliance-pack",
    "--output-dir",
  ]));
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const evidenceResult = runId === undefined
    ? undefined
    : await readPersistedLoopRunEvidence(runId);
  if (evidenceResult instanceof Error) {
    console.error(`osstack: ${evidenceResult.message}`);
    return 1;
  }
  const stateFilePath = evidenceResult?.state_json
    ?? resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  const state = await readLoopState(stateFilePath);
  if (state === null) {
    console.error(`osstack: no loop state found at ${stateFilePath}`);
    return 1;
  }

  const outputDir = resolveLoopPath(flagValue(args, "--output-dir") ?? "release", workspacePath);
  const events = evidenceResult?.events ?? await readLoopEventsJsonlFlag(args, workspacePath);
  const governanceRoot = dirname(stateFilePath);
  const governance = await scanWorkspaceGovernance(governanceRoot);
  const knowledge = await createKnowledgeProofEvidence(args, state.loop_id);
  const proof = await writeProofPack(state, outputDir, events, runId, governance, knowledge, flagValues(args, "--compliance-pack"));

  const summary = {
    loop_id: state.loop_id,
    proof_dir: proof.proof_dir,
    manifest: proof.proof_manifest,
    artifact_count: proof.artifact_count,
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`proof=${summary.proof_dir}`);
    console.log(`manifest=${summary.manifest}`);
    console.log(`artifacts=${summary.artifact_count}`);
  }
  return 0;
}

async function handleProofViewCommand(args: string[]): Promise<number> {
  const runId = firstPositionalValue(args, new Set(["--audience", "--proof-dir", "--workspace", "--output"]));
  if (runId === undefined) {
    console.error("osstack: proof view requires a run_id");
    return 1;
  }
  const audience = parseProofAudience(flagValue(args, "--audience"));
  if (audience === undefined) {
    console.error("osstack: proof view requires --audience engineer|manager|auditor|customer");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const proofDir = flagValue(args, "--proof-dir") ?? join(workspacePath, "release", `osstack-proof-${safeFileSegment(runId)}`);
  const output = flagValue(args, "--output") ?? join(workspacePath, "reports", `proof-view-${audience}-${safeFileSegment(runId)}.md`);
  const markdown = await renderProofViewFromProofDir({ audience, runId, proofDir });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, markdown, "utf-8");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ run_id: runId, audience, proof_dir: proofDir, output }, null, 2));
  } else {
    console.log(`proof_view=${output}`);
    console.log(`audience=${audience}`);
  }
  return 0;
}

function parseProofAudience(value: string | undefined): ProofAudience | undefined {
  if (value === "engineer" || value === "manager" || value === "auditor" || value === "customer") return value;
  return undefined;
}

async function handlePrCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack pr — generate PR evidence body

  osstack pr [run_id] [--workspace P] [--state P] [--events P] [--proof-dir P] [--output P] [--dry-run|--create] [--json]

Options:
  --workspace P       Workspace containing LOOP-STATE.json (default: cwd)
  --state P           JSON state path (default: LOOP-STATE.json)
  --events P          Optional loop events JSONL path for policy/verify evidence
  --proof-dir P       Optional proof pack directory to read governance/knowledge evidence
  --output P          Output markdown path (default: <workspace>/reports/pr-body-<id>.md)
  --dry-run           Write a local PR body only; this is the default
  --create            Run GitHub PR readiness checks and print manual steps
  --json              Print machine-readable summary
`);
    return 0;
  }

  const runId = firstPositionalValue(args, new Set([
    "--workspace",
    "--state",
    "--events",
    "--proof-dir",
    "--output",
  ]));
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const evidenceResult = runId === undefined
    ? undefined
    : await readPersistedLoopRunEvidence(runId);
  if (evidenceResult instanceof Error) {
    console.error(`osstack: ${evidenceResult.message}`);
    return 1;
  }
  const stateFilePath = evidenceResult?.state_json
    ?? resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  const state = await readLoopState(stateFilePath);
  if (state === null) {
    console.error(`osstack: no loop state found at ${stateFilePath}`);
    return 1;
  }
  const events = evidenceResult?.events ?? await readLoopEventsJsonlFlag(args, workspacePath);
  const artifactId = runId ?? state.loop_id;
  const proofDir = resolveLoopPath(
    flagValue(args, "--proof-dir") ?? join("release", `osstack-proof-${safeFileSegment(artifactId)}`),
    workspacePath,
  );
  const outputPath = resolveLoopPath(
    flagValue(args, "--output") ?? join("reports", `pr-body-${safeFileSegment(artifactId)}.md`),
    workspacePath,
  );
  const proofEvidence = await readProofEvidenceForPr(proofDir);
  const body = renderPrBody({
    state,
    events,
    proofDir,
    governance: proofEvidence.governance,
    knowledge: proofEvidence.knowledge,
    worktree: proofEvidence.worktree,
    verify: proofEvidence.verify,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body, "utf-8");
  const summary = {
    mode: args.includes("--create") ? "create-preflight" : "dry-run",
    loop_id: state.loop_id,
    path: outputPath,
    proof_dir: proofDir,
  };
  if (args.includes("--create")) {
    const readiness = await checkPrCreateReadiness(workspacePath);
    const createSummary = {
      ...summary,
      readiness,
      manual_steps: manualPrCreateSteps(outputPath, readiness),
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(createSummary, null, 2));
    } else {
      console.log(`pr_body=${outputPath}`);
      console.log(`proof=${proofDir}`);
      console.log("manual_steps:");
      for (const step of createSummary.manual_steps) console.log(`- ${step}`);
    }
    if (!readiness.ok) {
      console.error("osstack: PR create preflight failed; no GitHub writes were attempted.");
      return 1;
    }
    console.error("osstack: PR create API call is not enabled yet; use the manual steps above.");
    return 1;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`pr_body=${outputPath}`);
    console.log(`proof=${proofDir}`);
  }
  return 0;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function firstPositionalValue(args: string[], flagsWithValues: Set<string>): string | undefined {
  return positionalValues(args, flagsWithValues)[0];
}

async function readPersistedLoopRunEvidence(runId: string): Promise<{
  run_id: string;
  state_json: string;
  events: LoopEvent[];
} | Error> {
  const dbPath = join(osstackHome(), "state.db");
  const db = openDb({ path: dbPath });
  try {
    const run = db.prepare("SELECT run_id, session_id, phase FROM runs WHERE run_id = ?").get(runId) as
      | { run_id: string; session_id: string; phase: string }
      | undefined;
    if (run === undefined) return new Error(`no persisted run found for run_id=${runId}`);
    const rows = db.prepare(
      "SELECT event_id, run_id, session_id, seq, type, created_at, payload_json FROM events WHERE run_id = ? ORDER BY seq ASC",
    ).all(runId) as Array<{
      event_id: string;
      run_id: string;
      session_id: string;
      seq: number;
      type: string;
      created_at: number;
      payload_json: string;
    }>;
    const events = normalizeLoopEvents(rows.map((row) => ({
      event_id: persistedLoopEventId(row),
      loop_id: row.session_id,
      type: row.type,
      seq: row.seq,
      created_at: row.created_at,
      payload: parsePayloadJson(row.payload_json),
    })));
    const stateJson = findStateJsonPath(events);
    if (stateJson === undefined) {
      return new Error(`persisted run ${runId} has no loop.state.written event with jsonPath`);
    }
    return {
      run_id: run.run_id,
      state_json: stateJson,
      events,
    };
  } finally {
    db.close();
  }
}

async function writeRequestedLoopArtifactsFromStateFile(options: {
  args: string[];
  workspacePath: string;
  stateFilePath: string;
  events?: unknown[];
}): Promise<LoopEvidenceArtifacts | undefined | Error> {
  if (!hasRequestedLoopArtifacts(options.args)) return undefined;
  const statePath = resolveLoopPath(options.stateFilePath, options.workspacePath);
  const state = await readLoopState(statePath);
  if (state === null) {
    return new Error(`no loop state found at ${statePath}; cannot generate evidence artifacts`);
  }
  return await writeRequestedLoopArtifacts(
    state,
    options.workspacePath,
    options.args,
    normalizeLoopEvents(options.events),
  );
}

async function writeRequestedLoopArtifacts(
  state: LoopState,
  workspacePath: string,
  args: string[],
  events: LoopEvent[] = [],
): Promise<LoopEvidenceArtifacts | undefined> {
  if (!hasRequestedLoopArtifacts(args)) return undefined;

  const artifacts: LoopEvidenceArtifacts = {};
  const loopId = safeFileSegment(state.loop_id);

  if (args.includes("--report")) {
    const reportDir = join(workspacePath, "reports");
    const reportPath = join(reportDir, `osstack-report-${loopId}.md`);
    await mkdir(reportDir, { recursive: true });
    await writeFile(reportPath, renderReportMarkdownForArtifacts(state, events), "utf-8");
    artifacts.report = reportPath;
  }

  if (args.includes("--scorecard")) {
    const releaseDir = join(workspacePath, "release");
    const scorecard = createLoopStateScorecardFromState(state);
    const markdownPath = join(releaseDir, `osstack-scorecard-${loopId}.md`);
    const htmlPath = join(releaseDir, `osstack-scorecard-${loopId}.html`);
    await mkdir(releaseDir, { recursive: true });
    await writeFile(markdownPath, renderLoopStateScorecardMarkdown(scorecard), "utf-8");
    await writeFile(htmlPath, renderLoopStateScorecardHtml(scorecard), "utf-8");
    artifacts.scorecard_markdown = markdownPath;
    artifacts.scorecard_html = htmlPath;
  }

  if (args.includes("--proof")) {
    const governance = await scanWorkspaceGovernance(workspacePath);
    const knowledge = await createKnowledgeProofEvidence(args, state.loop_id);
    const proof = await writeProofPack(state, join(workspacePath, "release"), events, state.loop_id, governance, knowledge);
    artifacts.proof_dir = proof.proof_dir;
    artifacts.proof_manifest = proof.proof_manifest;
  }

  return artifacts;
}

async function writeProofPack(
  state: LoopState,
  outputDir: string,
  events: LoopEvent[] = [],
  artifactId = state.loop_id,
  governance: GovernanceProofEvidence = unknownGovernanceEvidence("No governance scan evidence provided."),
  knowledge: KnowledgeProofEvidence = offKnowledgeEvidence(),
  compliancePackIds: string[] = [],
): Promise<{
  proof_dir: string;
  proof_manifest: string;
  artifact_count: number;
}> {
  const proofDir = join(outputDir, `osstack-proof-${safeFileSegment(artifactId)}`);
  const scorecard = createLoopStateScorecardFromState(state);
  const policyDecision = createPolicyDecisionEvidence(events);
  const verifyResults = createVerifyResultsEvidence(scorecard, events);
  const worktreeStatus = createWorktreeStatusEvidence(events);
  const artifacts = [
    { path: "report.md", content: renderReportMarkdownForArtifacts(state, events) },
    { path: "scorecard.md", content: renderLoopStateScorecardMarkdown(scorecard) },
    { path: "scorecard.html", content: renderLoopStateScorecardHtml(scorecard) },
    { path: "loop-state.json", content: `${JSON.stringify(state, null, 2)}\n` },
    { path: "events.jsonl", content: events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "") },
    { path: "policy-decision.json", content: `${JSON.stringify(policyDecision, null, 2)}\n` },
    { path: "verify-results.json", content: `${JSON.stringify(verifyResults, null, 2)}\n` },
    { path: "worktree-status.json", content: `${JSON.stringify(worktreeStatus, null, 2)}\n` },
    { path: "governance-results.json", content: `${JSON.stringify(governance, null, 2)}\n` },
    { path: "knowledge-results.json", content: `${JSON.stringify(knowledge, null, 2)}\n` },
  ];
  for (const packId of compliancePackIds) {
    artifacts.push({
      path: `compliance-${safeFileSegment(packId)}.md`,
      content: renderComplianceReport({
        packId,
        runId: artifactId,
        evidence: {
          manifest: { artifacts: artifacts.map((artifact) => ({ path: artifact.path, sha256: sha256(artifact.content) })) },
          verify: verifyResults,
          policy: policyDecision,
          governance,
          worktree: worktreeStatus,
          knowledge,
        },
      }),
    });
  }

  await mkdir(proofDir, { recursive: true });
  const manifestArtifacts: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const artifact of artifacts) {
    await writeFile(join(proofDir, artifact.path), artifact.content, "utf-8");
    manifestArtifacts.push({
      path: artifact.path,
      sha256: sha256(artifact.content),
      bytes: Buffer.byteLength(artifact.content, "utf-8"),
    });
  }

  const manifest = {
    schema_version: 1,
    kind: "osstack.proof_pack",
    loop_id: state.loop_id,
    generated_from: "LOOP-STATE.json",
    generated_at: new Date().toISOString(),
    artifacts: manifestArtifacts,
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const proofManifest = join(proofDir, "manifest.json");
  await writeFile(proofManifest, manifestContent, "utf-8");
  return {
    proof_dir: proofDir,
    proof_manifest: proofManifest,
    artifact_count: manifestArtifacts.length + 1,
  };
}

function hasRequestedLoopArtifacts(args: string[]): boolean {
  return args.includes("--report") || args.includes("--scorecard") || args.includes("--proof");
}

async function scanWorkspaceGovernance(workspacePath: string): Promise<GovernanceProofEvidence> {
  try {
    const files = await collectGovernanceScanFiles(workspacePath);
    if (files.length === 0) {
      return {
        status: "pass",
        ok: true,
        scanned_files: 0,
        findings: [],
      };
    }
    const result = await scanFiles(files);
    return {
      status: result.ok ? "pass" : "fail",
      ok: result.ok,
      scanned_files: files.length,
      findings: result.findings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unknownGovernanceEvidence(`Governance scan failed: ${message}`);
  }
}

async function collectGovernanceScanFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  await collectGovernanceScanFilesInto(workspacePath, files);
  return files;
}

async function collectGovernanceScanFilesInto(dir: string, files: string[]): Promise<void> {
  if (files.length >= 500) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= 500) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isGovernanceExcludedDir(entry.name)) continue;
      await collectGovernanceScanFilesInto(path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isGovernanceScannableFile(entry.name)) continue;
    files.push(path);
  }
}

function isGovernanceExcludedDir(name: string): boolean {
  return new Set([
    ".git",
    ".next",
    ".turbo",
    "coverage",
    "dist",
    "node_modules",
    "release",
    "reports",
    "tmp",
    "vendor",
  ]).has(name);
}

function isGovernanceScannableFile(name: string): boolean {
  if (name === ".env") return true;
  return new Set([
    ".cjs",
    ".css",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
  ]).has(extname(name));
}

function unknownGovernanceEvidence(reason: string): GovernanceProofEvidence {
  return {
    status: "unknown",
    ok: false,
    scanned_files: 0,
    reason,
    findings: [],
  };
}

async function readProofEvidenceForPr(proofDir: string): Promise<{
  governance?: unknown;
  knowledge?: unknown;
  worktree?: unknown;
  verify?: unknown;
}> {
  const [governance, knowledge, worktree, verify] = await Promise.all([
    readJsonFileIfExists(join(proofDir, "governance-results.json")),
    readJsonFileIfExists(join(proofDir, "knowledge-results.json")),
    readJsonFileIfExists(join(proofDir, "worktree-status.json")),
    readJsonFileIfExists(join(proofDir, "verify-results.json")),
  ]);
  return { governance, knowledge, worktree, verify };
}

async function readJsonFileIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function renderPrBody(options: {
  state: LoopState;
  events: LoopEvent[];
  proofDir: string;
  governance?: unknown;
  knowledge?: unknown;
  worktree?: unknown;
  verify?: unknown;
}): string {
  const report = createLoopStateReport(options.state, { events: options.events });
  const lines: string[] = [
    `# PR Evidence - ${options.state.loop_id}`,
    "",
    "## Summary",
    `- Loop: ${options.state.loop_id}`,
    `- Conformance: ${report.conformance.level} ${report.conformance.name}`,
    `- Completed: ${report.summary.completed_count}`,
    `- Failed: ${report.summary.failed_count}`,
    `- Escalated: ${report.summary.escalated_count}`,
    `- Success rate: ${Math.round(report.summary.success_rate * 100)}%`,
    "",
    "## Tasks Completed",
    ...renderPrTasks(options.state),
    "",
    "## Agent Selection",
    ...renderPrPolicy(options.events),
    "",
    "## Verification",
    ...renderPrVerification(options.events, options.verify),
    "",
    "## Governance",
    ...renderPrGovernance(options.governance),
    "",
    "## Knowledge Trace",
    ...renderPrKnowledge(options.knowledge),
    "",
    "## Worktree",
    ...renderPrWorktree(options.worktree),
    "",
    "## Proof Pack",
    `- ${options.proofDir}`,
    "",
    "## Risks / Open Questions",
    ...report.risks.map((risk) => `- ${risk}`),
    ...report.next_steps.map((step) => `- Next: ${step}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function checkPrCreateReadiness(workspacePath: string): Promise<PrReadinessResult> {
  const checks: PrReadinessCheck[] = [];
  const insideWorkTree = await gitOutput(workspacePath, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree instanceof Error || insideWorkTree.trim() !== "true") {
    checks.push({
      id: "git_repository",
      status: "error",
      summary: "Workspace is not a git repository.",
    });
    checks.push({
      id: "branch",
      status: "error",
      summary: "Cannot inspect branch outside a git repository.",
    });
    checks.push({
      id: "remote",
      status: "error",
      summary: "Cannot inspect GitHub remote outside a git repository.",
    });
    checks.push({
      id: "gh_auth",
      status: "warn",
      summary: "GitHub CLI auth was not checked because git repository checks failed.",
    });
    return { ok: false, checks };
  }
  checks.push({ id: "git_repository", status: "ok", summary: "Workspace is a git repository." });

  const branch = await gitOutput(workspacePath, ["branch", "--show-current"]);
  const currentBranch = branch instanceof Error ? "" : branch.trim();
  const defaultBranch = await inferDefaultBranch(workspacePath);
  if (currentBranch.length === 0) {
    checks.push({ id: "branch", status: "error", summary: "Detached HEAD; create a named branch before opening a PR." });
  } else if (currentBranch === defaultBranch) {
    checks.push({ id: "branch", status: "error", summary: `Current branch ${currentBranch} is the default branch; create a feature branch first.` });
  } else {
    checks.push({ id: "branch", status: "ok", summary: `Current branch ${currentBranch}; default branch ${defaultBranch}.` });
  }

  const remote = await gitOutput(workspacePath, ["remote", "get-url", "origin"]);
  if (remote instanceof Error || parseGitHubRepoSlug(remote.trim()) === undefined) {
    checks.push({ id: "remote", status: "error", summary: "No GitHub origin remote was found." });
  } else {
    checks.push({ id: "remote", status: "ok", summary: `GitHub remote: ${parseGitHubRepoSlug(remote.trim())}` });
  }

  const ghAuth = await execOutput("gh", ["auth", "status"], workspacePath);
  if (ghAuth instanceof Error) {
    checks.push({ id: "gh_auth", status: "warn", summary: "GitHub CLI auth is unavailable or not logged in; use manual PR steps." });
  } else {
    checks.push({ id: "gh_auth", status: "ok", summary: "GitHub CLI auth is available." });
  }
  return {
    ok: checks.every((check) => check.status !== "error"),
    checks,
  };
}

async function inferDefaultBranch(workspacePath: string): Promise<string> {
  const symbolic = await gitOutput(workspacePath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (!(symbolic instanceof Error)) {
    const match = symbolic.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  }
  const localMain = await gitOutput(workspacePath, ["show-ref", "--verify", "--quiet", "refs/heads/main"]);
  if (!(localMain instanceof Error)) return "main";
  const localMaster = await gitOutput(workspacePath, ["show-ref", "--verify", "--quiet", "refs/heads/master"]);
  return localMaster instanceof Error ? "main" : "master";
}

async function gitOutput(workspacePath: string, args: string[]): Promise<string | Error> {
  return execOutput("git", args, workspacePath);
}

async function execOutput(command: string, args: string[], cwd: string): Promise<string | Error> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    });
    return String(stdout);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function manualPrCreateSteps(prBodyPath: string, readiness: PrReadinessResult): string[] {
  const steps = [
    "git checkout -b codex/osstack-evidence-pr",
    "git status --short",
    "git add <changed-files>",
    "git commit -m \"feat: describe the change\"",
    "git push -u origin HEAD",
    `gh pr create --fill --body-file ${prBodyPath}`,
  ];
  if (!readiness.ok) {
    steps.unshift("Resolve the failed readiness checks listed above.");
  }
  return steps;
}

function renderPrTasks(state: LoopState): string[] {
  if (state.completed_tasks.length === 0) return ["- None"];
  return state.completed_tasks.map((task) => (
    `- ${task.task_id}: ${task.outcome} via ${task.agent_id} (${task.iterations} iteration${task.iterations === 1 ? "" : "s"})`
  ));
}

function renderPrPolicy(events: LoopEvent[]): string[] {
  const decisions = createPolicyDecisionEvidence(events);
  if (decisions.status === "unknown" || decisions.decisions === undefined || decisions.decisions.length === 0) {
    return [`- ${decisions.reason ?? "No policy decision evidence found."}`];
  }
  return decisions.decisions.map((decision) => (
    `- ${decision.task_id}: ${decision.agent_id} - ${decision.reason} (scorecard: \`osstack agent scorecard ${decision.agent_id}\`)`
  ));
}

function renderPrVerification(events: LoopEvent[], proofVerify: unknown): string[] {
  const eventLines = events
    .filter((event) => event.type === "loop.verify.done")
    .map((event) => (
      `- ${stringEventPayload(event, "task_id")}: ${booleanEventPayload(event, "pass") ? "pass" : "fail"} - ${stringEventPayload(event, "summary")}`
    ));
  if (eventLines.length > 0) return eventLines;
  if (isRecord(proofVerify) && typeof proofVerify["status"] === "string") {
    return [`- Proof verify status: ${proofVerify["status"]}`];
  }
  return ["- No verify evidence found."];
}

function renderPrGovernance(governance: unknown): string[] {
  if (!isRecord(governance)) return ["- No governance evidence found."];
  const status = typeof governance["status"] === "string" ? governance["status"] : "unknown";
  const findings = Array.isArray(governance["findings"]) ? governance["findings"] : [];
  if (findings.length === 0) return [`- Status: ${status}`];
  return [
    `- Status: ${status}`,
    ...findings.map((finding) => {
      if (!isRecord(finding)) return "- Unknown governance finding";
      const rule = typeof finding["rule_id"] === "string" ? finding["rule_id"] : "unknown";
      const severity = typeof finding["severity"] === "string" ? finding["severity"] : "unknown";
      const file = typeof finding["file"] === "string" ? finding["file"] : "unknown";
      const line = typeof finding["line"] === "number" ? finding["line"] : "unknown";
      const message = typeof finding["message"] === "string" ? finding["message"] : "";
      return `- [${severity}] ${rule} ${file}:${line} - ${message}`;
    }),
  ];
}

function renderPrKnowledge(knowledge: unknown): string[] {
  if (!isRecord(knowledge)) return ["- Mode: off"];
  const mode = typeof knowledge["mode"] === "string" ? knowledge["mode"] : "unknown";
  const status = typeof knowledge["status"] === "string" ? knowledge["status"] : "unknown";
  const packs = Array.isArray(knowledge["packs"]) ? knowledge["packs"] : [];
  const results = Array.isArray(knowledge["results"]) ? knowledge["results"] : [];
  return [
    `- Mode: ${mode}`,
    `- Status: ${status}`,
    ...packs.map((pack) => {
      if (!isRecord(pack)) return "- Pack: unknown";
      const id = typeof pack["id"] === "string" ? pack["id"] : "unknown";
      const version = typeof pack["version"] === "string" ? pack["version"] : "unknown";
      const sourceKind = typeof pack["source_kind"] === "string" ? pack["source_kind"] : "unknown";
      return `- Pack: ${id}@${version} (${sourceKind})`;
    }),
    ...results.map((result) => {
      if (!isRecord(result)) return "- Chunk: unknown";
      const chunkId = typeof result["chunk_id"] === "string" ? result["chunk_id"] : "unknown";
      const title = typeof result["title"] === "string" ? result["title"] : "unknown";
      return `- Chunk: ${chunkId} - ${title}`;
    }),
  ];
}

function renderPrWorktree(worktree: unknown): string[] {
  if (!isRecord(worktree)) return ["- No worktree evidence found."];
  const entries = Array.isArray(worktree["entries"]) ? worktree["entries"] : [];
  if (entries.length === 0) {
    const status = typeof worktree["status"] === "string" ? worktree["status"] : "unknown";
    return [`- Status: ${status}`];
  }
  return entries.map((entry) => {
    if (!isRecord(entry)) return "- Unknown worktree entry";
    const taskId = typeof entry["task_id"] === "string" ? entry["task_id"] : "unknown";
    const status = typeof entry["status"] === "string" ? entry["status"] : "unknown";
    const branch = typeof entry["branch"] === "string" ? entry["branch"] : "unknown";
    const commit = typeof entry["commit"] === "string" ? entry["commit"] : "unknown";
    return `- ${taskId}: ${status} branch=${branch} commit=${commit}`;
  });
}

async function createKnowledgeProofEvidence(args: string[], defaultQuery: string): Promise<KnowledgeProofEvidence> {
  const packPaths = flagValues(args, "--knowledge-pack");
  const modeValue = flagValue(args, "--knowledge-mode");
  const mode = parseKnowledgeMode(modeValue);
  const cloudUrl = flagValue(args, "--knowledge-cloud-url") ?? process.env["OSSTACK_KNOWLEDGE_URL"];
  if (modeValue !== undefined && mode === undefined) {
    return {
      mode: "off",
      status: "not_used",
      reason: "--knowledge-mode must be one of off, local, cloud",
      packs: [],
      results: [],
    };
  }
  if (packPaths.length === 0 && cloudUrl === undefined && mode !== "cloud") return offKnowledgeEvidence();
  const query = flagValue(args, "--knowledge-query") ?? defaultQuery;
  try {
    const packs = await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath)));
    return await resolveKnowledgeSearch({
      mode,
      query,
      packs,
      limit: 5,
      cloudUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: mode ?? "local",
      status: "error",
      query,
      reason: message,
      packs: [],
      results: [],
    };
  }
}

function offKnowledgeEvidence(): KnowledgeProofEvidence {
  return {
    mode: "off",
    status: "not_used",
    packs: [],
    results: [],
  };
}

function createPolicyDecisionEvidence(events: LoopEvent[]): {
  status: "recorded" | "unknown";
  decisions?: Array<{ task_id: string; agent_id: string; reason: string; event_seq: number }>;
  reason?: string;
} {
  const decisions = events
    .filter((event) => event.type === "loop.plan.done")
    .map((event) => ({
      task_id: stringEventPayload(event, "task_id"),
      agent_id: stringEventPayload(event, "agent_id"),
      reason: stringEventPayload(event, "routing_reason"),
      event_seq: event.seq,
    }));
  if (decisions.length === 0) {
    return {
      status: "unknown",
      reason: "No loop.plan.done policy decision evidence found.",
    };
  }
  return { status: "recorded", decisions };
}

function createVerifyResultsEvidence(
  scorecard: ReturnType<typeof createLoopStateScorecardFromState>,
  events: LoopEvent[],
): {
  status: "pass" | "fail" | "unknown";
  results?: Array<{
    task_id: string;
    pass: boolean;
    score: number | "unknown";
    reviewer_agent_id: string;
    summary: string;
    event_seq: number;
  }>;
  reason?: string;
} {
  const results = events
    .filter((event) => event.type === "loop.verify.done")
    .map((event) => ({
      task_id: stringEventPayload(event, "task_id"),
      pass: booleanEventPayload(event, "pass"),
      score: numberEventPayload(event, "score") ?? "unknown",
      reviewer_agent_id: stringEventPayload(event, "reviewer_agent_id"),
      summary: stringEventPayload(event, "summary"),
      event_seq: event.seq,
    }));
  if (results.length === 0) {
    return {
      status: scorecard.items.find((item) => item.id === "verify_gates_passed")?.status ?? "unknown",
      reason: "No loop.verify.done event evidence found; status derived from completed task outcomes in LOOP-STATE.json.",
    };
  }
  return {
    status: results.every((result) => result.pass) ? "pass" : "fail",
    results,
  };
}

function createWorktreeStatusEvidence(events: LoopEvent[]): {
  status: "recorded" | "unknown";
  entries?: Array<{
    task_id: string;
    status: "created" | "merged" | "cleaned";
    branch: string;
    commit: string;
    path: string;
    event_seq: number;
  }>;
  reason?: string;
} {
  const entries = events
    .filter((event) => (
      event.type === "loop.worktree.created"
      || event.type === "loop.worktree.merged"
      || event.type === "loop.worktree.cleaned"
    ))
    .map((event) => ({
      task_id: stringEventPayload(event, "task_id"),
      status: event.type === "loop.worktree.created"
        ? "created" as const
        : event.type === "loop.worktree.merged"
          ? "merged" as const
          : "cleaned" as const,
      branch: stringEventPayload(event, "branch"),
      commit: stringEventPayload(event, "commit"),
      path: stringEventPayload(event, "path"),
      event_seq: event.seq,
    }));
  if (entries.length === 0) {
    return {
      status: "unknown",
      reason: "No loop.worktree.* event evidence found.",
    };
  }
  return { status: "recorded", entries };
}

function stringEventPayload(event: LoopEvent, key: string): string {
  const value = event.payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function booleanEventPayload(event: LoopEvent, key: string): boolean {
  const value = event.payload?.[key];
  return typeof value === "boolean" ? value : false;
}

function numberEventPayload(event: LoopEvent, key: string): number | undefined {
  const value = event.payload?.[key];
  return typeof value === "number" ? value : undefined;
}

function renderReportMarkdownForArtifacts(state: LoopState, events: LoopEvent[]): string {
  return events.length === 0
    ? renderLoopStateReportFromState(state)
    : renderLoopStateReportFromStateAndEvents(state, events);
}

async function readLoopEventsJsonlFlag(args: string[], workspacePath: string): Promise<LoopEvent[]> {
  const eventsPath = flagValue(args, "--events");
  if (eventsPath === undefined) return [];
  return readLoopEventsJsonl(resolveLoopPath(eventsPath, workspacePath));
}

async function readLoopEventsJsonl(path: string): Promise<LoopEvent[]> {
  const raw = await readFile(path, "utf-8");
  const parsed: unknown[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      parsed.push(JSON.parse(trimmed) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid events JSONL at ${path}:${index + 1}: ${message}`);
    }
  }
  return normalizeLoopEvents(parsed);
}

function normalizeLoopEvents(events: unknown[] | undefined): LoopEvent[] {
  if (events === undefined) return [];
  return events.filter((event): event is LoopEvent => (
    typeof event === "object"
    && event !== null
    && typeof (event as { event_id?: unknown }).event_id === "string"
    && typeof (event as { loop_id?: unknown }).loop_id === "string"
    && typeof (event as { type?: unknown }).type === "string"
    && typeof (event as { seq?: unknown }).seq === "number"
    && typeof (event as { created_at?: unknown }).created_at === "number"
  ));
}

function persistedLoopEventId(row: { event_id: string; payload_json: string }): string {
  const payload = parsePayloadJson(row.payload_json);
  const original = payload["loop_event_id"];
  return typeof original === "string" ? original : row.event_id;
}

function parsePayloadJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findStateJsonPath(events: LoopEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "loop.state.written") continue;
    const jsonPath = event.payload?.["jsonPath"];
    if (typeof jsonPath === "string" && jsonPath.length > 0) return jsonPath;
  }
  return undefined;
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

async function handleDeliverCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack deliver — product entry from one intent to proof

  osstack deliver "Add billing dashboard" [--workspace P] [--execute CMD] [--verify CMD] [--auto-agent] [--worktree] [--json]

Stages:
  intake -> plan -> execute-loop -> verify-review -> proof
`);
    return 0;
  }

  const prompt = firstPositionalValue(args, new Set([
    "--workspace",
    "--state",
    "--execute",
    "--verify",
    "--agent",
    "--capability",
    "--priority",
    "--max-iter",
    "--worktree-root",
  ]));
  if (prompt === undefined) {
    console.error("osstack: deliver requires a prompt");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
  const executeCommand = flagValue(args, "--execute");
  const agentId = flagValue(args, "--agent");
  const capability = flagValue(args, "--capability") ?? "code.write";
  const priority = parsePositiveIntegerFlag(flagValue(args, "--priority"), "--priority");
  if (priority instanceof Error) {
    console.error(`osstack: ${priority.message}`);
    return 1;
  }
  const maxIterations = parsePositiveIntegerFlag(flagValue(args, "--max-iter"), "--max-iter");
  if (maxIterations instanceof Error) {
    console.error(`osstack: ${maxIterations.message}`);
    return 1;
  }
  const verifyCommands = flagValues(args, "--verify");
  const suggestedVerify = await suggestVerifyCommand(workspacePath);
  const autoAgent = args.includes("--auto-agent");
  const stages = ["intake", "plan", "execute-loop", "verify-review", "proof"];
  const task = await enqueueTask({
    workspacePath,
    prompt,
    capability,
    ...(priority !== undefined ? { priority } : {}),
    context: {
      deliver_pipeline: {
        stages,
        suggested_verify: suggestedVerify,
        verify_commands: verifyCommands,
        auto_agent: autoAgent,
      },
    },
  });
  const adapters = agentId !== undefined || autoAgent ? defaultAdapters() : undefined;
  const engine = new LoopEngine({
    workspacePath,
    stateFilePath,
    ...(executeCommand !== undefined ? { executeCommand } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(autoAgent ? { autoAgent } : {}),
    ...(adapters !== undefined ? { adapters } : {}),
    ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
    sources: ["task_queue"],
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(args.includes("--worktree") ? { useWorktree: true } : {}),
    ...(flagValue(args, "--worktree-root") !== undefined ? { worktreeRoot: flagValue(args, "--worktree-root") } : {}),
  });
  const result = await engine.runOnce();
  const artifactArgs = ensureFlags(args, ["--report", "--scorecard", "--proof"]);
  const artifacts = await writeRequestedLoopArtifacts(result.state, workspacePath, artifactArgs, result.events);
  const learnedLessons = await learnLessonsFromLoopState(result.state);
  const summary = {
    prompt,
    stages,
    suggested_verify: suggestedVerify,
    verify_commands: verifyCommands,
    task: task.task,
    task_path: task.path,
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(learnedLessons !== undefined ? { learned_lessons: learnedLessons } : {}),
    ...(result.state.key_metrics !== undefined ? { metrics: result.state.key_metrics } : {}),
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`deliver=${result.loop_id}`);
    console.log(`task=${task.path}`);
    if (suggestedVerify !== undefined) console.log(`suggested_verify=${suggestedVerify}`);
    if (artifacts?.report !== undefined) console.log(`report=${artifacts.report}`);
    if (artifacts?.proof_dir !== undefined) console.log(`proof=${artifacts.proof_dir}`);
  }
  return result.state.completed_tasks.some((completed) => completed.outcome !== "success") ? 2 : 0;
}

function ensureFlags(args: string[], flags: string[]): string[] {
  const next = [...args];
  for (const flag of flags) {
    if (!next.includes(flag)) next.push(flag);
  }
  return next;
}

async function suggestVerifyCommand(workspacePath: string): Promise<string | undefined> {
  if (await fileExists(join(workspacePath, "pnpm-lock.yaml"))) return "pnpm test";
  if (await fileExists(join(workspacePath, "bun.lockb")) || await fileExists(join(workspacePath, "bun.lock"))) return "bun test";
  if (await fileExists(join(workspacePath, "package-lock.json"))) return "npm test";
  try {
    const packageJson = JSON.parse(await readFile(join(workspacePath, "package.json"), "utf-8")) as unknown;
    if (isRecord(packageJson) && isRecord(packageJson["scripts"]) && typeof packageJson["scripts"]["test"] === "string") {
      return "npm test";
    }
  } catch {
    // No package.json or unreadable package metadata.
  }
  return undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
      const artifacts = await writeRequestedLoopArtifactsFromStateFile({
        args,
        workspacePath,
        stateFilePath,
        events: result.events,
      });
      if (artifacts instanceof Error) {
        console.error(`osstack: ${artifacts.message}`);
        return 1;
      }
      if (artifacts !== undefined) result.artifacts = artifacts;
      const persistedState = await readLoopState(resolveLoopPath(stateFilePath, workspacePath));
      if (persistedState !== null) {
        result.learned_lessons = await learnLessonsFromLoopState(persistedState);
      }
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

    const artifacts = await writeRequestedLoopArtifacts(result.state, workspacePath, args, result.events);
    const learnedLessons = await learnLessonsFromLoopState(result.state);
    printLoopRun({
      loop_id: result.loop_id,
      json_path: result.jsonPath,
      markdown_path: result.markdownPath,
      completed_tasks: result.state.completed_tasks,
      events: result.events,
      ...(artifacts !== undefined ? { artifacts } : {}),
      ...(learnedLessons !== undefined ? { learned_lessons: learnedLessons } : {}),
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
  --source S          Discovery source; repeatable. git_diff | task_queue | github_branch
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
  --report            Generate reports/osstack-report-<loop_id>.md after run
  --scorecard         Generate release/osstack-scorecard-<loop_id>.md/html after run
  --proof             Generate release/osstack-proof-<loop_id>/ after run
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

function safeFileSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
  artifacts?: LoopEvidenceArtifacts;
  learned_lessons?: {
    learned: number;
    lessons: ReturnType<typeof upsertPitfallLesson>[];
  };
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

interface LoopEvidenceArtifacts {
  report?: string;
  scorecard_markdown?: string;
  scorecard_html?: string;
  proof_dir?: string;
  proof_manifest?: string;
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
  if (result.artifacts !== undefined) {
    if (result.artifacts.report !== undefined) console.log(`report=${result.artifacts.report}`);
    if (result.artifacts.scorecard_markdown !== undefined) console.log(`scorecard_markdown=${result.artifacts.scorecard_markdown}`);
    if (result.artifacts.scorecard_html !== undefined) console.log(`scorecard_html=${result.artifacts.scorecard_html}`);
    if (result.artifacts.proof_dir !== undefined) console.log(`proof=${result.artifacts.proof_dir}`);
    if (result.artifacts.proof_manifest !== undefined) console.log(`proof_manifest=${result.artifacts.proof_manifest}`);
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

async function handleDashboardCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "url";

  if (sub === "url") {
    const resp = (await rpc("dashboard.url")) as { ok: boolean; result?: { url?: string | null; available?: boolean }; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "dashboard.url failed");
      return 1;
    }
    const url = resp.result?.url;
    if (!url) {
      console.error("osstack: dashboard URL is not available yet; check `osstack health`");
      return 1;
    }
    console.log(url);
    return 0;
  }

  if (sub === "open") {
    const resp = (await rpc("dashboard.url")) as { ok: boolean; result?: { url?: string | null }; error?: { message: string } };
    if (!resp.ok || !resp.result?.url) {
      console.error("osstack:", resp.error?.message ?? "dashboard URL is not available");
      return 1;
    }
    const { spawn } = await import("node:child_process");
    spawn("open", [resp.result.url], { detached: true, stdio: "ignore" }).unref();
    console.log(resp.result.url);
    return 0;
  }

  if (sub === "snapshot") {
    const resp = (await rpc("dashboard.snapshot")) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "dashboard.snapshot failed");
      return 1;
    }
    console.log(JSON.stringify(resp.result, null, 2));
    return 0;
  }

  if (sub === "help") {
    console.log(`osstack dashboard / cockpit — local development cockpit

  osstack dashboard url       Print the URL for chat bots to return
  osstack dashboard open      Open the dashboard locally
  osstack dashboard snapshot  Print the JSON backing the dashboard
  osstack cockpit url         Same as dashboard url
  osstack cockpit open        Same as dashboard open

Env:
  OSSTACK_DASHBOARD_PORT      Port for the HTTP dashboard (default 8799)
  OSSTACK_DASHBOARD_HOST      Bind host (default 127.0.0.1)
  OSSTACK_DASHBOARD_URL_HOST  Host shown in returned URLs (default localhost)
`);
    return 0;
  }

  console.error(`osstack: unknown dashboard subcommand "${sub}"`);
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

function isDirectCliEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  const invoked = pathToFileURL(realpathSync(process.argv[1])).href;
  return import.meta.url === invoked;
}

if (isDirectCliEntrypoint()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("osstack:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
