// osstack CLI entry. Talks to the running daemon via Unix socket when needed.
// (shebang is injected by tsup banner)

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { agentAuthMode, defaultAdapters, rolesForCapabilityKinds } from "@osstack/agents";
import {
  getCompliancePack,
  listCompliancePacks,
  loadProofEvidence,
  renderComplianceReport,
  renderComplianceReportFromProofDir,
  renderProofViewFromProofDir,
  validateProofEvidence,
  type ProofAudience,
} from "@osstack/compliance";
import { getAgentScorecard, listAgentScorecards, listPitfallLessons, openDb, PIIRedactor, upsertPitfallLesson } from "@osstack/core";
import { scanFiles, type GovernanceFinding } from "@osstack/governance";
import {
  renderBranchStewardReport,
  scanBranchStewardCandidates,
  type BranchStewardConfig,
} from "@osstack/github";
import {
  LoopEngine,
  countTaskQueueTasks,
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
  type LoopKnowledgeTrace,
  type LoopReportLanguage,
  type LoopState,
} from "@osstack/loop";
import {
  cacheKnowledgeFeedback,
  evaluateKnowledgeRetrieval,
  ingestKnowledgeSource,
  importKnowledgeSource,
  listCachedKnowledgePacks,
  loadKnowledgePackIndex,
  loadKnowledgePack,
  pinKnowledgePack,
  resolveKnowledgeSearch,
  syncKnowledgeCache,
  validateKnowledgePublishGate,
  type KnowledgePack,
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
import { logsDir, osstackHome, resolveSocketPath } from "./paths.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";
import { handleUpgradeCommand } from "./upgrade.js";

const execFileAsync = promisify(execFile);

function socketPath(): string {
  return resolveSocketPath();
}

function resolveLanguage(value = process.env["OSSTACK_LANG"]): LoopReportLanguage {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "zh-cn" || normalized === "zh" || normalized === "cn") return "zh-CN";
  return "en";
}

function renderChineseMainHelp(): string {
  return `osstack ${VERSION} — Hermes 驻留项目经理 Agent

用法：
  osstack <命令> [参数]

守护进程命令：
  serve               启动 daemon（Unix socket：${socketPath()}）
  serve --install     安装 macOS launchd daemon
  health              查看 daemon 健康状态
  status              查看 CLI/daemon 版本与升级状态
  cockpit             打开或查看产品控制台
  stats               查看 agent 与 loop 指标

项目命令：
  doctor              检查 workspace、loop、agent 与下一步建议
  examples            输出可直接运行的工作流示例
  guide               输出或写入 5 分钟 Quickstart
  release doctor      检查 npm / Knowledge Cloud 发布前置条件
  deliver <需求>      从一句需求进入 task queue -> loop -> report/scorecard/proof

Loop 工程：
  loop run            运行 discover -> execute -> verify -> iterate 循环
  loop enqueue        写入 tasks/ 队列任务
  loop status         渲染 LOOP-STATE.json / STATE.md
  report              生成证据报告（支持 --lang en|zh-CN）
  scorecard           生成证据评分卡
  proof               生成 proof pack
  proof view          按 engineer/manager/auditor/customer 重排已有证据
  pr                  生成 GitHub PR evidence body

治理与知识：
  govern check        运行确定性治理检查
  compliance list     列出合规映射包
  knowledge search    搜索本地或云端 Osstack 知识库
  lessons list        查看本地 pitfall 知识库

Agent：
  agent list          查看 agent 的 role/capability/auth mode
  agent scorecard     查看 agent 历史表现

环境变量：
  OSSTACK_LANG        语言：en 或 zh-CN
  OSSTACK_HOME        存储根目录（默认 ~/.osstack）
  OSSTACK_SOCKET      daemon socket 路径
`;
}

const LAUNCHD_LABEL = "ai.osstack.daemon";

interface ServeLaunchdStatus {
  label: string;
  plist_path: string;
  installed: boolean;
  loaded: boolean;
  socket_path: string;
}

interface ServeLaunchdInstallResult extends ServeLaunchdStatus {
  loaded: boolean;
  load_skipped: boolean;
  home: string;
  logs_dir: string;
}

interface ServeLaunchdUninstallResult extends ServeLaunchdStatus {
  unloaded: boolean;
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
    if (resolveLanguage() === "zh-CN") {
      console.log(renderChineseMainHelp());
      return 0;
    }
    console.log(`osstack ${VERSION} — Hermes-resident project manager agent

Usage:
  osstack <command> [args]

Daemon commands:
  serve               Start the daemon (Unix socket at ${socketPath()})
  serve --install     Install the macOS launchd daemon (use --uninstall/--status to manage it)
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
  doctor [--workspace P] [--daemon] [--json]
                      Product readiness check: loop + agents + next steps
  examples [--json]   Print runnable workflow examples
  guide [--output P]  Print or write the 5-minute quickstart
  release doctor [--target all|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--json]
                      Check publish/deploy prerequisites: GitHub auth, repo
                      secrets, npm auth, and Fly.io deploy readiness
  release plan [--target all|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--json]
                      Generate a blocker-aware publish/deploy runbook
  init [dir]          Scaffold OSBORN project layout (V2 osb-init)
  deliver <prompt> [--verify CMD] [--auto-agent] [--worktree]
                      Product entry: task queue -> loop -> report/scorecard/proof
  checkpoint create [--workspace P] [--json]
                      Create a shadow checkpoint outside .git for non-worktree recovery

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
  report [run_id] [--loop loop_id] [--workspace P] [--state P]
                                 Render an evidence-oriented report from LOOP-STATE.json
  scorecard [run_id] [--loop loop_id] [--workspace P] [--state P] [--output-dir P] [--stdout]
                                 Generate Markdown + HTML evidence scorecards
  proof [run_id] [--loop loop_id] [--workspace P] [--state P] [--output-dir P] [--json]
                                 Generate a checksumed local proof pack
  proof view <run_id> --audience engineer|manager|auditor|customer
                                 Rearrange existing proof evidence for a target audience
  pr [run_id] [--workspace P] [--state P] [--events P] [--proof-dir P] [--dry-run]
                                 Write a GitHub-ready PR body from run evidence
  loop run [--workspace P] [--source S] [--execute CMD] [--verify CMD]
           [--reviewer ID] [--checker ID] [--goal CMD] [--max-iter N] [--cycles N] [--interval-ms N]
           [--state P] [--markdown P] [--worktree] [--knowledge off|local|cloud] [--govern [warn|strict]]
           [--report] [--scorecard] [--proof] [--json] [--daemon]
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
  govern check [path...] [--workspace P] [--changed] [--json]
                                 Run deterministic governance checks over workspace files
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
    if (args.includes("--install") || args.includes("--uninstall") || args.includes("--status")) {
      return await handleServeManagementCommand(args.slice(1));
    }
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

  if (cmd === "doctor") {
    return await handleProductDoctorCommand(args.slice(1));
  }

  if (cmd === "examples") {
    return await handleExamplesCommand(args.slice(1));
  }

  if (cmd === "guide") {
    return await handleGuideCommand(args.slice(1));
  }

  if (cmd === "release") {
    return await handleReleaseCommand(args.slice(1));
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

  if (cmd === "checkpoint") {
    return await handleCheckpointCommand(args.slice(1));
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

  if (cmd === "governance" || cmd === "govern") {
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
    if (!args.includes("--daemon")) {
      const agents = await listLocalAgentProfiles();
      if (args.includes("--json")) {
        console.log(JSON.stringify({ agents }, null, 2));
      } else {
        for (const agent of agents) {
          console.log(`${agent.id} — ${agent.display_name}`);
          console.log(`  roles=${agent.roles.join(",") || "(none)"}`);
          console.log(`  auth_mode=${agent.auth_mode} cost_tier=${agent.cost_tier} available=${agent.available.available}`);
          if (!agent.available.available && agent.available.reason !== undefined) {
            console.log(`  unavailable_reason=${agent.available.reason}`);
          }
          console.log(`  capabilities=${agent.capabilities.map((capability) => capability.kind).join(",")}`);
        }
      }
      return 0;
    }
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

async function handleProductDoctorCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`osstack doctor — product readiness check

  osstack doctor [--workspace P] [--daemon] [--json]

Checks:
  - workspace, tasks/, LOOP-STATE.json, git/worktree readiness
  - daemon socket when --daemon is set
  - local agent registry roles, auth modes, and availability
`);
    return 0;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const loop = await loopDoctor({
    workspacePath,
    stateFilePath: resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath),
    checkDaemon: args.includes("--daemon"),
  });
  const agents = await productAgentDoctor();
  const nextSteps = productDoctorNextSteps(loop, agents);
  const result = {
    ok: loop.ok && agents.total > 0,
    workspace: workspacePath,
    loop,
    agents,
    next_steps: nextSteps,
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printProductDoctor(result);
  }
  return result.ok ? 0 : 1;
}

async function productAgentDoctor(): Promise<{
  total: number;
  available: number;
  unavailable: number;
  by_role: Record<string, string[]>;
  profiles: Array<{
    id: string;
    display_name: string;
    auth_mode: string;
    cost_tier: string;
    roles: string[];
    available: boolean;
    reason?: string;
  }>;
}> {
  const profiles = await Promise.all(defaultAdapters().map(async (adapter) => {
    const availability = await adapter.isAvailable();
    const roles = rolesForCapabilityKinds(adapter.capabilities().map((capability) => capability.kind));
    return {
      id: adapter.id,
      display_name: adapter.display_name,
      auth_mode: agentAuthMode(adapter.id),
      cost_tier: adapter.cost_tier,
      roles,
      available: availability.available,
      ...(availability.reason !== undefined ? { reason: availability.reason } : {}),
    };
  }));
  const byRole: Record<string, string[]> = {};
  for (const profile of profiles) {
    for (const role of profile.roles) {
      byRole[role] = [...(byRole[role] ?? []), profile.id];
    }
  }
  return {
    total: profiles.length,
    available: profiles.filter((profile) => profile.available).length,
    unavailable: profiles.filter((profile) => !profile.available).length,
    by_role: byRole,
    profiles,
  };
}

function productDoctorNextSteps(
  loop: LoopDoctorResult,
  agents: Awaited<ReturnType<typeof productAgentDoctor>>,
): string[] {
  const steps: string[] = [];
  const taskQueue = loop.checks.find((check) => check.id === "task_queue");
  if (taskQueue?.status === "ok") {
    steps.push("Run queued work: osstack loop run --source task_queue --report --scorecard --proof");
  } else {
    steps.push("Queue a task: osstack loop enqueue \"Run local checks\" --capability code.test");
  }
  if (agents.available > 0) {
    steps.push("Try routing: osstack loop run --source task_queue --auto-agent --verify \"pnpm test\"");
  } else {
    steps.push("Configure an available agent or use --execute for local shell execution.");
  }
  steps.push("Read examples: osstack examples");
  return steps;
}

function printProductDoctor(result: {
  ok: boolean;
  workspace: string;
  loop: LoopDoctorResult;
  agents: Awaited<ReturnType<typeof productAgentDoctor>>;
  next_steps: string[];
}): void {
  console.log(`Osstack doctor: ${result.ok ? "ok" : "attention needed"}`);
  console.log(`workspace=${result.workspace}`);
  console.log("");
  printLoopDoctor(result.loop);
  console.log("");
  console.log(`Agents: ${result.agents.available}/${result.agents.total} available`);
  for (const profile of result.agents.profiles) {
    console.log(`  [${profile.available ? "ok" : "warn"}] ${profile.id} auth=${profile.auth_mode} roles=${profile.roles.join(",") || "none"}`);
  }
  console.log("");
  console.log("Next steps:");
  for (const step of result.next_steps) console.log(`- ${step}`);
}

async function handleExamplesCommand(args: string[]): Promise<number> {
  const examples = osstackExamples();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ examples }, null, 2));
    return 0;
  }
  console.log("# Osstack Examples\n");
  for (const example of examples) {
    console.log(`## ${example.title}`);
    console.log(example.description);
    console.log("");
    console.log("```bash");
    for (const command of example.commands) console.log(command);
    console.log("```\n");
  }
  return 0;
}

async function handleGuideCommand(args: string[]): Promise<number> {
  const markdown = renderQuickstartGuide();
  const output = flagValue(args, "--output");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, markdown, "utf-8");
    if (args.includes("--json")) {
      console.log(JSON.stringify({ output }, null, 2));
    } else {
      console.log(`guide=${output}`);
    }
    return 0;
  }
  console.log(markdown);
  return 0;
}

type ReleaseDoctorStatus = "ok" | "warn" | "error";

interface ReleaseDoctorCheck {
  id: string;
  status: ReleaseDoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface ReleaseDoctorResult {
  ok: boolean;
  target: "all" | "npm" | "knowledge-cloud" | "single-binary";
  checks: ReleaseDoctorCheck[];
  readiness: {
    npm_publish: boolean;
    knowledge_cloud_deploy: boolean;
    single_binary_release: boolean;
  };
  next_steps: string[];
  output?: string;
}

interface ReleaseDoctorOptions {
  workspacePath?: string;
  proofDir?: string;
  cloudUrl?: string;
}

type ProofFileIntegrityIssueCode =
  | "manifest_malformed"
  | "manifest_invalid_kind"
  | "manifest_invalid_schema_version"
  | "manifest_missing_osstack_version"
  | "manifest_missing_run_id"
  | "manifest_missing_loop_id"
  | "manifest_missing_agent_id"
  | "manifest_missing_agent_ids"
  | "manifest_missing_generated_from"
  | "manifest_missing_created_at"
  | "manifest_missing_generated_at"
  | "artifact_malformed"
  | "duplicate_artifact_path"
  | "path_outside_proof_dir"
  | "missing_artifact"
  | "bytes_mismatch"
  | "sha256_mismatch"
  | "sha256sums_missing"
  | "sha256sums_malformed"
  | "sha256sums_missing_entry"
  | "sha256sums_extra_entry"
  | "sha256sums_mismatch";

interface ProofFileIntegrityIssue {
  path: string;
  code: ProofFileIntegrityIssueCode;
  expected?: string | number;
  actual?: string | number;
}

interface ProofFileIntegrityValidation {
  ok: boolean;
  issues: ProofFileIntegrityIssue[];
}

type ProofArchiveIntegrityIssueCode =
  | "proof_zip_unreadable"
  | "proof_zip_missing_entry"
  | "proof_zip_extra_entry"
  | "proof_zip_duplicate_entry";

interface ProofArchiveIntegrityIssue {
  path: string;
  code: ProofArchiveIntegrityIssueCode;
}

interface ProofArchiveIntegrityValidation {
  ok: boolean;
  checked: boolean;
  proof_zip: string;
  issues: ProofArchiveIntegrityIssue[];
}

const SINGLE_BINARY_RELEASE_SECRETS = [
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "DEVELOPER_ID_APPLICATION",
  "MACOS_CERTIFICATE_P12",
  "MACOS_CERTIFICATE_PASSWORD",
];

async function handleReleaseCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack release — publish/deploy readiness

  osstack release doctor [--target all|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--cloud-url URL] [--json]
  osstack release plan [--target all|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--cloud-url URL] [--output P] [--json]

Checks:
  - GitHub CLI authentication for repository operations
  - GitHub Actions runner availability for release/deploy workflows
  - repository secrets NPM_TOKEN and FLY_API_TOKEN
  - Apple notarization and Developer ID secrets for single-binary release
  - optional proof-core evidence validation with --proof-dir
  - optional deployed Knowledge Cloud /healthz validation with --cloud-url
  - local npm login for manual publishing
  - local flyctl login for manual Knowledge Cloud deploy debugging
`);
    return 0;
  }
  if (sub === "doctor") return await handleReleaseDoctorCommand(args.slice(1));
  if (sub === "plan") return await handleReleasePlanCommand(args.slice(1));
  console.error(`osstack: unknown release subcommand "${sub}"`);
  return 1;
}

interface ReleaseActionPlan {
  target: ReleaseDoctorResult["target"];
  ready: boolean;
  safe_to_execute: boolean;
  blockers: string[];
  operator_commands: string[];
  validation_commands: string[];
  publish_commands: string[];
  deploy_commands: string[];
  post_release_validation_commands: string[];
  output?: string;
}

async function handleReleasePlanCommand(args: string[]): Promise<number> {
  const target = parseReleaseDoctorTarget(flagValue(args, "--target") ?? "all");
  if (target === undefined) {
    console.error("osstack: release plan --target must be all, npm, knowledge-cloud, or single-binary");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const proofDir = flagValue(args, "--proof-dir");
  const cloudUrl = flagValue(args, "--cloud-url");
  const doctor = await releaseDoctor(target, {
    workspacePath,
    ...(proofDir === undefined ? {} : { proofDir }),
    ...(cloudUrl === undefined ? {} : { cloudUrl }),
  });
  const plan = releaseActionPlan(doctor, {
    ...(proofDir === undefined ? {} : { proofDir }),
    ...(cloudUrl === undefined ? {} : { cloudUrl }),
  });
  const output = flagValue(args, "--output");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderReleaseActionPlan(plan), "utf-8");
    plan.output = output;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(renderReleaseActionPlan(plan));
  }
  return 0;
}

async function handleReleaseDoctorCommand(args: string[]): Promise<number> {
  const target = parseReleaseDoctorTarget(flagValue(args, "--target") ?? "all");
  if (target === undefined) {
    console.error("osstack: release doctor --target must be all, npm, knowledge-cloud, or single-binary");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const proofDir = flagValue(args, "--proof-dir");
  const cloudUrl = flagValue(args, "--cloud-url");
  const result = await releaseDoctor(target, {
    workspacePath,
    ...(proofDir === undefined ? {} : { proofDir }),
    ...(cloudUrl === undefined ? {} : { cloudUrl }),
  });
  const output = flagValue(args, "--output");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderReleaseReadinessReport(result), "utf-8");
    result.output = output;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReleaseDoctor(result);
    if (output !== undefined) console.log(`release_readiness=${output}`);
  }
  return result.ok ? 0 : 1;
}

function parseReleaseDoctorTarget(value: string): ReleaseDoctorResult["target"] | undefined {
  if (value === "all" || value === "npm" || value === "knowledge-cloud" || value === "single-binary") return value;
  return undefined;
}

async function releaseDoctor(
  target: ReleaseDoctorResult["target"],
  options: ReleaseDoctorOptions = {},
): Promise<ReleaseDoctorResult> {
  const checks: ReleaseDoctorCheck[] = [];
  const githubAuth = await releaseCommandCheck({
    id: "github_auth",
    command: "gh",
    args: ["auth", "status", "-h", "github.com"],
    envOverride: "OSSTACK_TEST_RELEASE_GITHUB_AUTH",
    okMessage: "GitHub CLI is authenticated for github.com.",
    errorMessage: "GitHub CLI is not authenticated; run gh auth login or gh auth refresh -h github.com -s workflow.",
  });
  checks.push(githubAuth);
  const githubActions = await releaseGitHubActionsCheck();
  checks.push(githubActions);

  const requiredSecrets = target === "npm" ? ["NPM_TOKEN"]
    : target === "knowledge-cloud" ? ["FLY_API_TOKEN"]
      : target === "single-binary" ? SINGLE_BINARY_RELEASE_SECRETS
      : ["NPM_TOKEN", "FLY_API_TOKEN", ...SINGLE_BINARY_RELEASE_SECRETS];
  const secrets = await releaseSecretsCheck(requiredSecrets);
  checks.push(secrets);

  if (target === "all" || target === "npm") {
    checks.push(await releaseNpmPublishAssetsCheck(process.cwd()));
    checks.push(await releaseVersionPackagesPrCheck());
    checks.push(await releaseCommandCheck({
      id: "npm_auth",
      command: "npm",
      args: ["whoami"],
      envOverride: "OSSTACK_TEST_RELEASE_NPM_AUTH",
      okMessage: "Local npm login is available for manual publish checks.",
      errorMessage: "Local npm login is missing; run npm login or rely on the NPM_TOKEN repository secret in CI.",
      missingSeverity: "warn",
    }));
  }

  if (target === "all" || target === "knowledge-cloud") {
    checks.push(await releaseKnowledgeCloudDeployAssetsCheck(process.cwd()));
    checks.push(await releaseKnowledgeCloudWorkflowCheck());
    if (options.cloudUrl !== undefined) {
      checks.push(await releaseKnowledgeCloudHealthCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudSearchCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudSyncCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudAuditCheck(options.cloudUrl));
    }
    checks.push(await releaseCommandCheck({
      id: "fly_auth",
      command: "flyctl",
      args: ["auth", "whoami"],
      envOverride: "OSSTACK_TEST_RELEASE_FLY_AUTH",
      okMessage: "Local flyctl login is available for manual deploy checks.",
      errorMessage: "Local flyctl login is missing; run flyctl auth login or rely on the FLY_API_TOKEN repository secret in CI.",
      missingSeverity: "warn",
    }));
  }
  if (target === "all" || target === "single-binary") {
    checks.push(await releaseSingleBinaryReleaseAssetsCheck(process.cwd()));
    checks.push(await releaseSingleBinaryWorkflowCheck());
  }

  const proofDir = options.proofDir ?? await discoverLatestProofDir(options.workspacePath ?? process.cwd());
  if (proofDir !== undefined) {
    checks.push(await releaseProofValidationCheck(proofDir, { discovered: options.proofDir === undefined }));
  }

  const npmPublishAssetsReady = checks.find((check) => check.id === "npm_publish_assets")?.status !== "error";
  const versionPackagesPrReady = checks.find((check) => check.id === "version_packages_pr")?.status !== "warn";
  const knowledgeDeployAssetsReady = checks.find((check) => check.id === "knowledge_cloud_deploy_assets")?.status !== "error";
  const knowledgeWorkflowReady = checks.find((check) => check.id === "knowledge_cloud_workflow")?.status !== "error";
  const knowledgeHealthReady = checks.find((check) => check.id === "knowledge_cloud_health")?.status !== "error";
  const knowledgeSearchReady = checks.find((check) => check.id === "knowledge_cloud_search")?.status !== "error";
  const knowledgeSyncReady = checks.find((check) => check.id === "knowledge_cloud_sync")?.status !== "error";
  const knowledgeAuditReady = checks.find((check) => check.id === "knowledge_cloud_audit")?.status !== "error";
  const singleBinaryAssetsReady = checks.find((check) => check.id === "single_binary_release_assets")?.status !== "error";
  const singleBinaryWorkflowReady = checks.find((check) => check.id === "single_binary_workflow")?.status !== "error";
  const actionsReady = githubActions.status !== "error";
  const npmPublish = actionsReady && hasSecret(secrets, "NPM_TOKEN") && npmPublishAssetsReady && versionPackagesPrReady;
  const knowledgeCloudDeploy = actionsReady
    && hasSecret(secrets, "FLY_API_TOKEN")
    && knowledgeDeployAssetsReady
    && knowledgeWorkflowReady
    && knowledgeHealthReady
    && knowledgeSearchReady
    && knowledgeSyncReady
    && knowledgeAuditReady;
  const singleBinaryRelease = actionsReady
    && SINGLE_BINARY_RELEASE_SECRETS.every((secret) => hasSecret(secrets, secret))
    && singleBinaryAssetsReady
    && singleBinaryWorkflowReady;
  const ok = target === "npm" ? npmPublish
    : target === "knowledge-cloud" ? knowledgeCloudDeploy
      : target === "single-binary" ? singleBinaryRelease
      : npmPublish && knowledgeCloudDeploy && singleBinaryRelease;
  const hardFailures = checks.some((check) =>
    check.status === "error"
    && check.id !== "repository_secrets"
    && !(target === "npm" && check.id === "knowledge_cloud_workflow")
    && !(target === "knowledge-cloud" && check.id === "version_packages_pr")
  );
  return {
    ok: ok && !hardFailures,
    target,
    checks,
    readiness: {
      npm_publish: npmPublish,
      knowledge_cloud_deploy: knowledgeCloudDeploy,
      single_binary_release: singleBinaryRelease,
    },
    next_steps: releaseDoctorNextSteps({ target, npmPublish, knowledgeCloudDeploy, singleBinaryRelease, githubAuth, secrets, checks }),
  };
}

async function releaseNpmPublishAssetsCheck(workspacePath: string): Promise<ReleaseDoctorCheck> {
  const assetRoot = await findReleaseAssetRoot(workspacePath);
  const requiredAssets = [
    "packages/cli/package.json",
    ".changeset/osstack-upgrade-knowledge-cloud.md",
    ".github/workflows/release.yml",
  ];
  const missing: string[] = [];
  const violations: string[] = [];
  const readAsset = async (path: string): Promise<string> => {
    try {
      return await readFile(join(assetRoot, path), "utf-8");
    } catch {
      missing.push(path);
      return "";
    }
  };
  const cliPackageRaw = await readAsset("packages/cli/package.json");
  const changeset = await readAsset(".changeset/osstack-upgrade-knowledge-cloud.md");
  const workflow = await readAsset(".github/workflows/release.yml");

  if (cliPackageRaw !== "") {
    try {
      const cliPackage = JSON.parse(cliPackageRaw) as {
        name?: string;
        bin?: Record<string, string>;
        files?: string[];
        publishConfig?: { access?: string };
        repository?: { directory?: string };
        engines?: { node?: string };
      };
      if (cliPackage.name !== "@osstack/cli") violations.push("CLI package name must be @osstack/cli.");
      if (cliPackage.bin?.["osstack"] !== "./dist/bin.js") violations.push("CLI package must expose bin.osstack=./dist/bin.js.");
      if (!Array.isArray(cliPackage.files) || !cliPackage.files.includes("dist")) violations.push("CLI package files must include dist.");
      if (cliPackage.publishConfig?.access !== "public") violations.push("CLI package publishConfig.access must be public.");
      if (cliPackage.repository?.directory !== "packages/cli") violations.push("CLI package repository.directory must be packages/cli.");
      if (cliPackage.engines?.node !== ">=20") violations.push("CLI package engines.node must be >=20.");
    } catch {
      violations.push("packages/cli/package.json must be valid JSON.");
    }
  }

  const expectAsset = (text: string, needle: string, message: string): void => {
    if (text !== "" && !text.includes(needle)) violations.push(message);
  };
  expectAsset(changeset, "\"@osstack/cli\": minor", "Changeset must version @osstack/cli.");
  expectAsset(workflow, "uses: changesets/action@v1", "Release workflow must use changesets/action.");
  expectAsset(workflow, "pnpm smoke:release-plan", "Release workflow must run release plan smoke.");
  expectAsset(workflow, "pnpm smoke:npm-install", "Release workflow must run npm install smoke.");
  expectAsset(workflow, "pnpm changeset publish --provenance", "Release workflow must publish with npm provenance.");
  expectAsset(workflow, "secrets.NPM_TOKEN", "Release workflow must gate publishing on NPM_TOKEN.");
  expectAsset(workflow, "NODE_AUTH_TOKEN", "Release workflow must set NODE_AUTH_TOKEN for npm publish.");

  const ok = missing.length === 0 && violations.length === 0;
  return {
    id: "npm_publish_assets",
    status: ok ? "ok" : "error",
    message: ok
      ? "NPM publish assets are present and internally consistent."
      : "NPM publish assets are missing or inconsistent.",
    details: {
      checked: requiredAssets,
      missing,
      violations,
      root: assetRoot,
    },
  };
}

async function releaseKnowledgeCloudDeployAssetsCheck(workspacePath: string): Promise<ReleaseDoctorCheck> {
  const assetRoot = await findReleaseAssetRoot(workspacePath);
  const requiredAssets = [
    "Dockerfile.knowledge-cloud",
    "deploy/knowledge-cloud/fly.toml",
    "deploy/knowledge-cloud/render.yaml",
    ".github/workflows/knowledge-cloud-deploy.yml",
  ];
  const missing: string[] = [];
  const violations: string[] = [];
  const readAsset = async (path: string): Promise<string> => {
    try {
      return await readFile(join(assetRoot, path), "utf-8");
    } catch {
      missing.push(path);
      return "";
    }
  };
  const dockerfile = await readAsset("Dockerfile.knowledge-cloud");
  const fly = await readAsset("deploy/knowledge-cloud/fly.toml");
  const render = await readAsset("deploy/knowledge-cloud/render.yaml");
  const workflow = await readAsset(".github/workflows/knowledge-cloud-deploy.yml");
  const expectAsset = (text: string, needle: string, message: string): void => {
    if (text !== "" && !text.includes(needle)) violations.push(message);
  };

  expectAsset(dockerfile, "EXPOSE 8787", "Dockerfile must expose port 8787.");
  expectAsset(dockerfile, "packages/knowledge-cloud/dist/bin.js", "Dockerfile must start the Knowledge Cloud executable.");
  expectAsset(fly, 'dockerfile = "Dockerfile.knowledge-cloud"', "Fly config must use Dockerfile.knowledge-cloud.");
  expectAsset(fly, "internal_port = 8787", "Fly config must route to port 8787.");
  expectAsset(fly, 'path = "/healthz"', "Fly config must healthcheck /healthz.");
  expectAsset(fly, 'OSSTACK_KNOWLEDGE_AUDIT_LOG = "/data/audit/knowledge-cloud-audit.jsonl"', "Fly config must persist audit JSONL.");
  expectAsset(fly, 'OSSTACK_KNOWLEDGE_FEEDBACK_LOG = "/data/feedback/feedback.jsonl"', "Fly config must persist feedback JSONL.");
  expectAsset(fly, 'OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR = "/data/published-packs"', "Fly config must persist published knowledge packs.");
  expectAsset(render, "dockerfilePath: ./Dockerfile.knowledge-cloud", "Render config must use Dockerfile.knowledge-cloud.");
  expectAsset(render, "healthCheckPath: /healthz", "Render config must healthcheck /healthz.");
  expectAsset(render, "OSSTACK_KNOWLEDGE_AUDIT_LOG", "Render config must persist audit JSONL.");
  expectAsset(render, "OSSTACK_KNOWLEDGE_FEEDBACK_LOG", "Render config must persist feedback JSONL.");
  expectAsset(render, "OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR", "Render config must persist published knowledge packs.");
  expectAsset(workflow, "workflow_dispatch:", "Knowledge Cloud deploy workflow must be manually triggerable.");
  expectAsset(workflow, "pnpm smoke:knowledge-cloud", "Knowledge Cloud deploy workflow must run service smoke.");
  expectAsset(workflow, "pnpm smoke:knowledge-cloud:deploy", "Knowledge Cloud deploy workflow must run deploy asset smoke.");
  expectAsset(workflow, "docker build -f Dockerfile.knowledge-cloud", "Knowledge Cloud deploy workflow must build the Docker image.");
  expectAsset(workflow, "secrets.FLY_API_TOKEN", "Knowledge Cloud deploy workflow must gate deploy on FLY_API_TOKEN.");
  expectAsset(workflow, "flyctl deploy --config deploy/knowledge-cloud/fly.toml", "Knowledge Cloud deploy workflow must deploy with the Fly config.");

  const ok = missing.length === 0 && violations.length === 0;
  return {
    id: "knowledge_cloud_deploy_assets",
    status: ok ? "ok" : "error",
    message: ok
      ? "Knowledge Cloud deploy assets are present and internally consistent."
      : "Knowledge Cloud deploy assets are missing or inconsistent.",
    details: {
      checked: requiredAssets,
      missing,
      violations,
      root: assetRoot,
      audit_log: "/data/audit/knowledge-cloud-audit.jsonl",
      published_pack_dir: "/data/published-packs",
    },
  };
}

async function releaseKnowledgeCloudHealthCheck(cloudUrl: string): Promise<ReleaseDoctorCheck> {
  const normalized = normalizeCloudUrl(cloudUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let healthUrl: URL | undefined;
  try {
    healthUrl = new URL("/healthz", normalized);
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await response.text();
    const body = parseJsonObject(raw);
    const service = typeof body?.["service"] === "string" ? body["service"] : undefined;
    const packs = typeof body?.["packs"] === "number" ? body["packs"] : undefined;
    const privatePacks = typeof body?.["private_packs"] === "number" ? body["private_packs"] : undefined;
    const bodyOk = body?.["ok"] === true;
    const ok = response.ok && bodyOk && service === "osstack-knowledge-cloud";
    return {
      id: "knowledge_cloud_health",
      status: ok ? "ok" : "error",
      message: ok
        ? `Deployed Knowledge Cloud health check passed at ${healthUrl.toString()}.`
        : `Deployed Knowledge Cloud health check failed at ${healthUrl.toString()}.`,
      details: {
        cloud_url: normalized,
        health_url: healthUrl.toString(),
        http_status: response.status,
        ok: bodyOk,
        service,
        ...(packs === undefined ? {} : { packs }),
        ...(privatePacks === undefined ? {} : { private_packs: privatePacks }),
      },
    };
  } catch (error) {
    const healthUrlString = healthUrl === undefined ? `${normalized.replace(/\/+$/, "")}/healthz` : healthUrl.toString();
    return {
      id: "knowledge_cloud_health",
      status: "error",
      message: `Could not reach deployed Knowledge Cloud health check at ${healthUrlString}.`,
      details: {
        cloud_url: normalized,
        health_url: healthUrlString,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function releaseKnowledgeCloudSearchCheck(cloudUrl: string): Promise<ReleaseDoctorCheck> {
  const normalized = normalizeCloudUrl(cloudUrl);
  const query = "proof pack checksum";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let searchUrl: URL | undefined;
  try {
    searchUrl = new URL("/v1/search", normalized);
    const response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, limit: 1 }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const body = parseJsonObject(raw);
    const packs = Array.isArray(body?.["packs"]) ? body["packs"] : [];
    const results = Array.isArray(body?.["results"]) ? body["results"] : [];
    const firstResult = isRecord(results[0]) ? results[0] : undefined;
    const firstChunkId = typeof firstResult?.["chunk_id"] === "string" ? firstResult["chunk_id"] : undefined;
    const firstPackId = typeof firstResult?.["pack_id"] === "string" ? firstResult["pack_id"] : undefined;
    const ok = response.ok && results.length > 0;
    return {
      id: "knowledge_cloud_search",
      status: ok ? "ok" : "error",
      message: ok
        ? `Deployed Knowledge Cloud search smoke passed at ${searchUrl.toString()}.`
        : `Deployed Knowledge Cloud search smoke failed at ${searchUrl.toString()}.`,
      details: {
        cloud_url: normalized,
        search_url: searchUrl.toString(),
        http_status: response.status,
        query,
        pack_count: packs.length,
        result_count: results.length,
        ...(firstChunkId === undefined ? {} : { first_chunk_id: firstChunkId }),
        ...(firstPackId === undefined ? {} : { first_pack_id: firstPackId }),
      },
    };
  } catch (error) {
    const searchUrlString = searchUrl === undefined ? `${normalized.replace(/\/+$/, "")}/v1/search` : searchUrl.toString();
    return {
      id: "knowledge_cloud_search",
      status: "error",
      message: `Could not run deployed Knowledge Cloud search smoke at ${searchUrlString}.`,
      details: {
        cloud_url: normalized,
        search_url: searchUrlString,
        query,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function releaseKnowledgeCloudSyncCheck(cloudUrl: string): Promise<ReleaseDoctorCheck> {
  const normalized = normalizeCloudUrl(cloudUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let syncUrl: URL | undefined;
  try {
    syncUrl = new URL("/v1/sync", normalized);
    const response = await fetch(syncUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ private: false }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const body = parseJsonObject(raw);
    const packs = Array.isArray(body?.["packs"]) ? body["packs"] : [];
    const firstPack = isRecord(packs[0]) ? packs[0] : undefined;
    const firstPackId = typeof firstPack?.["id"] === "string" ? firstPack["id"] : undefined;
    const ok = response.ok && packs.length > 0;
    return {
      id: "knowledge_cloud_sync",
      status: ok ? "ok" : "error",
      message: ok
        ? `Deployed Knowledge Cloud sync smoke passed at ${syncUrl.toString()}.`
        : `Deployed Knowledge Cloud sync smoke failed at ${syncUrl.toString()}.`,
      details: {
        cloud_url: normalized,
        sync_url: syncUrl.toString(),
        http_status: response.status,
        pack_count: packs.length,
        ...(firstPackId === undefined ? {} : { first_pack_id: firstPackId }),
      },
    };
  } catch (error) {
    const syncUrlString = syncUrl === undefined ? `${normalized.replace(/\/+$/, "")}/v1/sync` : syncUrl.toString();
    return {
      id: "knowledge_cloud_sync",
      status: "error",
      message: `Could not run deployed Knowledge Cloud sync smoke at ${syncUrlString}.`,
      details: {
        cloud_url: normalized,
        sync_url: syncUrlString,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function releaseKnowledgeCloudAuditCheck(cloudUrl: string): Promise<ReleaseDoctorCheck> {
  const normalized = normalizeCloudUrl(cloudUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let auditUrl: URL | undefined;
  try {
    auditUrl = new URL("/v1/audit", normalized);
    const response = await fetch(auditUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "search", status: "ok", limit: 1 }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const body = parseJsonObject(raw);
    const events = Array.isArray(body?.["events"]) ? body["events"] : undefined;
    const tenantEventLeak = (events ?? []).some((event) => isRecord(event) && typeof event["tenant_id"] === "string");
    const ok = response.ok && events !== undefined && !tenantEventLeak;
    return {
      id: "knowledge_cloud_audit",
      status: ok ? "ok" : "error",
      message: ok
        ? `Deployed Knowledge Cloud audit smoke passed at ${auditUrl.toString()}.`
        : `Deployed Knowledge Cloud audit smoke failed at ${auditUrl.toString()}.`,
      details: {
        cloud_url: normalized,
        audit_url: auditUrl.toString(),
        http_status: response.status,
        audit_event_count: events?.length ?? 0,
        tenant_event_leak: tenantEventLeak,
      },
    };
  } catch (error) {
    const auditUrlString = auditUrl === undefined ? `${normalized.replace(/\/+$/, "")}/v1/audit` : auditUrl.toString();
    return {
      id: "knowledge_cloud_audit",
      status: "error",
      message: `Could not run deployed Knowledge Cloud audit smoke at ${auditUrlString}.`,
      details: {
        cloud_url: normalized,
        audit_url: auditUrlString,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCloudUrl(value: string): string {
  return value.trim();
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function releaseSingleBinaryReleaseAssetsCheck(workspacePath: string): Promise<ReleaseDoctorCheck> {
  const assetRoot = await findReleaseAssetRoot(workspacePath);
  const requiredAssets = [
    "scripts/build-single-binary.mjs",
    "scripts/sign-single-binary.mjs",
    "scripts/notarize-single-binary.mjs",
    "scripts/generate-single-binary-sbom.mjs",
    "scripts/package-single-binary.mjs",
    "scripts/publish-single-binary-release.mjs",
    "scripts/smoke-single-binary-release-pack.mjs",
    "scripts/smoke-single-binary-release-publish.mjs",
    ".github/workflows/single-binary-release.yml",
  ];
  const missing: string[] = [];
  const violations: string[] = [];
  const readAsset = async (path: string): Promise<string> => {
    try {
      return await readFile(join(assetRoot, path), "utf-8");
    } catch {
      missing.push(path);
      return "";
    }
  };
  const publishScript = await readAsset("scripts/publish-single-binary-release.mjs");
  const notarizeScript = await readAsset("scripts/notarize-single-binary.mjs");
  const publishSmoke = await readAsset("scripts/smoke-single-binary-release-publish.mjs");
  const workflow = await readAsset(".github/workflows/single-binary-release.yml");
  for (const asset of requiredAssets.slice(0, 7)) await readAsset(asset);
  const expectAsset = (text: string, needle: string, message: string): void => {
    if (text !== "" && !text.includes(needle)) violations.push(message);
  };

  expectAsset(publishScript, "archive sha256 mismatch", "Single-binary publish script must verify archive SHA-256.");
  expectAsset(publishScript, "public single-binary upload requires a Developer ID signed and notarized archive", "Single-binary publish script must reject public upload of non-notarized archives.");
  expectAsset(publishScript, "archiveManifest.binary?.notarized !== true", "Single-binary publish script must inspect archive notarization metadata.");
  expectAsset(publishScript, "gh\", [\"release\", \"upload\"", "Single-binary publish script must upload assets through gh release upload.");
  expectAsset(publishScript, "github_release_uploaded: true", "Single-binary publish script must mark successful GitHub upload.");
  expectAsset(notarizeScript, "xcrun\", [", "Single-binary notarization script must use xcrun for notarytool.");
  expectAsset(notarizeScript, "notarytool", "Single-binary notarization script must submit assets to Apple notarytool.");
  expectAsset(notarizeScript, "ditto", "Single-binary notarization script must submit a zipped command-line tool payload.");
  expectAsset(notarizeScript, "spctl", "Single-binary notarization script must assess the notarized executable.");
  expectAsset(publishSmoke, "--dry-run", "Single-binary release publish smoke must exercise dry-run upload.");
  expectAsset(publishSmoke, "publish.assets.length !== 4", "Single-binary release publish smoke must require four release assets.");
  expectAsset(workflow, "push:", "Single-binary release workflow must run for release tags.");
  expectAsset(workflow, "tags:", "Single-binary release workflow must declare tag triggers.");
  expectAsset(workflow, "workflow_dispatch:", "Single-binary release workflow must be manually triggerable.");
  expectAsset(workflow, "pnpm smoke:single-binary-release-pack", "Single-binary release workflow must smoke release archives.");
  expectAsset(workflow, "pnpm publish:single-binary", "Single-binary release workflow must call the publish script.");
  expectAsset(workflow, "pnpm notarize:single-binary", "Single-binary release workflow must notarize public release assets.");
  expectAsset(workflow, "APPLE_APP_SPECIFIC_PASSWORD", "Single-binary release workflow must gate notarization on Apple notary credentials.");
  expectAsset(workflow, "DEVELOPER_ID_APPLICATION", "Single-binary release workflow must use a Developer ID identity for public release assets.");
  expectAsset(workflow, "MACOS_CERTIFICATE_P12", "Single-binary release workflow must import a Developer ID certificate.");
  expectAsset(workflow, "security import", "Single-binary release workflow must install the Developer ID certificate in a temporary keychain.");
  expectAsset(workflow, "GH_TOKEN:", "Single-binary release workflow must pass GH_TOKEN for upload.");
  expectAsset(workflow, "github.token", "Single-binary release workflow must use the workflow GitHub token.");
  expectAsset(workflow, "actions/upload-artifact@v4", "Single-binary release workflow must retain workflow artifact copies.");

  const ok = missing.length === 0 && violations.length === 0;
  return {
    id: "single_binary_release_assets",
    status: ok ? "ok" : "error",
    message: ok
      ? "Single-binary release assets are present and internally consistent."
      : "Single-binary release assets are missing or inconsistent.",
    details: {
      checked: requiredAssets,
      missing,
      violations,
      root: assetRoot,
    },
  };
}

async function findReleaseAssetRoot(startPath: string): Promise<string> {
  let current = startPath;
  while (true) {
    try {
      await stat(join(current, "Dockerfile.knowledge-cloud"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return startPath;
      current = parent;
    }
  }
}

async function discoverLatestProofDir(workspacePath: string): Promise<string | undefined> {
  try {
    const releaseDir = join(workspacePath, "release");
    const entries = await readdir(releaseDir, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("osstack-proof-"))
      .map(async (entry) => {
        const path = join(releaseDir, entry.name);
        const info = await stat(path);
        return { path, mtimeMs: info.mtimeMs };
      }));
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))[0]?.path;
  } catch {
    return undefined;
  }
}

async function releaseProofValidationCheck(
  proofDir: string,
  options: { discovered?: boolean } = {},
): Promise<ReleaseDoctorCheck> {
  try {
    const evidence = await loadProofEvidence(proofDir);
    const validation = validateProofEvidence({ evidence });
    const fileIntegrity = await validateProofFileIntegrity(proofDir, evidence.manifest);
    const archiveIntegrity = await validateProofArchiveIntegrity(proofDir, evidence.manifest);
    const ok = validation.ok && fileIntegrity.ok && archiveIntegrity.ok;
    return {
      id: "proof_validation",
      status: ok ? "ok" : "error",
      message: ok
        ? "Proof-core evidence validation passed, including artifact file and archive integrity."
        : fileIntegrity.ok && archiveIntegrity.ok
          ? "Proof-core evidence validation found missing or malformed evidence."
          : "Proof-core artifact integrity validation found missing, moved, or modified files.",
      details: {
        proof_dir: proofDir,
        discovered: options.discovered === true,
        scope: validation.scope,
        present: validation.present,
        missing: validation.missing,
        file_integrity: fileIntegrity,
        archive_integrity: archiveIntegrity,
      },
    };
  } catch (error) {
    return {
      id: "proof_validation",
      status: "error",
      message: `Proof-core evidence validation failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { proof_dir: proofDir, discovered: options.discovered === true },
    };
  }
}

async function validateProofFileIntegrity(
  proofDir: string,
  manifestRaw: unknown,
): Promise<ProofFileIntegrityValidation> {
  const issues: ProofFileIntegrityIssue[] = [];
  if (!isRecord(manifestRaw) || !Array.isArray(manifestRaw["artifacts"])) {
    return {
      ok: false,
      issues: [{ path: "manifest.json", code: "manifest_malformed" }],
    };
  }
  if (manifestRaw["kind"] !== "osstack.proof_pack") {
    issues.push({ path: "manifest.json", code: "manifest_invalid_kind" });
  }
  if (typeof manifestRaw["schema_version"] !== "number" || !Number.isInteger(manifestRaw["schema_version"]) || manifestRaw["schema_version"] < 1) {
    issues.push({ path: "manifest.json", code: "manifest_invalid_schema_version" });
  }
  if (missingManifestString(manifestRaw, "osstack_version")) {
    issues.push({ path: "manifest.json", code: "manifest_missing_osstack_version" });
  }
  if (missingManifestString(manifestRaw, "run_id")) {
    issues.push({ path: "manifest.json", code: "manifest_missing_run_id" });
  }
  if (missingManifestString(manifestRaw, "loop_id")) {
    issues.push({ path: "manifest.json", code: "manifest_missing_loop_id" });
  }
  if (missingManifestString(manifestRaw, "agent_id")) {
    issues.push({ path: "manifest.json", code: "manifest_missing_agent_id" });
  }
  if (!Array.isArray(manifestRaw["agent_ids"]) || !manifestRaw["agent_ids"].some((agentId) => typeof agentId === "string" && agentId.trim().length > 0)) {
    issues.push({ path: "manifest.json", code: "manifest_missing_agent_ids" });
  }
  if (missingManifestString(manifestRaw, "generated_from")) {
    issues.push({ path: "manifest.json", code: "manifest_missing_generated_from" });
  }
  if (missingManifestString(manifestRaw, "created_at")) {
    issues.push({ path: "manifest.json", code: "manifest_missing_created_at" });
  }
  if (missingManifestString(manifestRaw, "generated_at")) {
    issues.push({ path: "manifest.json", code: "manifest_missing_generated_at" });
  }

  const proofRoot = resolve(proofDir);
  const manifestShaByPath = new Map<string, string>();
  let sha256sumsContent: string | undefined;
  for (const artifact of manifestRaw["artifacts"]) {
    if (!isRecord(artifact)) {
      issues.push({ path: "<unknown>", code: "artifact_malformed" });
      continue;
    }
    const artifactPath = artifact["path"];
    const expectedSha256 = artifact["sha256"];
    const expectedBytes = artifact["bytes"];
    if (
      typeof artifactPath !== "string"
      || artifactPath.length === 0
      || typeof expectedSha256 !== "string"
      || typeof expectedBytes !== "number"
      || !Number.isInteger(expectedBytes)
    ) {
      issues.push({
        path: typeof artifactPath === "string" && artifactPath.length > 0 ? artifactPath : "<unknown>",
        code: "artifact_malformed",
      });
      continue;
    }
    if (manifestShaByPath.has(artifactPath)) {
      issues.push({ path: artifactPath, code: "duplicate_artifact_path" });
      continue;
    }
    manifestShaByPath.set(artifactPath, expectedSha256);

    const artifactFile = resolve(proofRoot, artifactPath);
    const artifactRelativePath = relative(proofRoot, artifactFile);
    if (artifactRelativePath.startsWith("..") || isAbsolute(artifactRelativePath)) {
      issues.push({ path: artifactPath, code: "path_outside_proof_dir" });
      continue;
    }

    let content: Buffer;
    try {
      content = await readFile(artifactFile);
    } catch {
      issues.push({ path: artifactPath, code: "missing_artifact" });
      continue;
    }

    if (content.length !== expectedBytes) {
      issues.push({
        path: artifactPath,
        code: "bytes_mismatch",
        expected: expectedBytes,
        actual: content.length,
      });
    }
    const actualSha256 = sha256Buffer(content);
    if (actualSha256 !== expectedSha256) {
      issues.push({
        path: artifactPath,
        code: "sha256_mismatch",
        expected: expectedSha256,
        actual: actualSha256,
      });
    }
    if (artifactPath === "sha256sums.txt") {
      sha256sumsContent = content.toString("utf-8");
    }
  }

  issues.push(...validateProofSha256Sums(manifestShaByPath, sha256sumsContent));
  return { ok: issues.length === 0, issues };
}

function missingManifestString(manifestRaw: Record<string, unknown>, key: string): boolean {
  const value = manifestRaw[key];
  return typeof value !== "string" || value.trim().length === 0;
}

function validateProofSha256Sums(
  manifestShaByPath: Map<string, string>,
  content: string | undefined,
): ProofFileIntegrityIssue[] {
  if (!manifestShaByPath.has("sha256sums.txt") || content === undefined) {
    return [{ path: "sha256sums.txt", code: "sha256sums_missing" }];
  }
  const issues: ProofFileIntegrityIssue[] = [];
  const sums = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (match === null || sums.has(match[2])) {
      issues.push({ path: "sha256sums.txt", code: "sha256sums_malformed" });
      continue;
    }
    sums.set(match[2], match[1]);
  }

  for (const [path, manifestSha] of manifestShaByPath.entries()) {
    if (path === "sha256sums.txt") continue;
    const checksumSha = sums.get(path);
    if (checksumSha === undefined) {
      issues.push({ path, code: "sha256sums_missing_entry" });
      continue;
    }
    if (checksumSha !== manifestSha) {
      issues.push({
        path,
        code: "sha256sums_mismatch",
        expected: manifestSha,
        actual: checksumSha,
      });
    }
  }

  for (const path of sums.keys()) {
    if (!manifestShaByPath.has(path)) {
      issues.push({ path, code: "sha256sums_extra_entry" });
    }
  }
  return issues;
}

async function validateProofArchiveIntegrity(
  proofDir: string,
  manifestRaw: unknown,
): Promise<ProofArchiveIntegrityValidation> {
  const proofZip = `${proofDir}.zip`;
  try {
    await stat(proofZip);
  } catch {
    return { ok: true, checked: false, proof_zip: proofZip, issues: [] };
  }
  const expectedPaths = proofArchiveExpectedPaths(manifestRaw);
  if (expectedPaths === undefined) {
    return { ok: true, checked: false, proof_zip: proofZip, issues: [] };
  }
  let archivePaths: string[];
  try {
    archivePaths = readZipEntryNames(await readFile(proofZip));
  } catch {
    return {
      ok: false,
      checked: true,
      proof_zip: proofZip,
      issues: [{ path: proofZip, code: "proof_zip_unreadable" }],
    };
  }

  const issues: ProofArchiveIntegrityIssue[] = [];
  const actualPaths = new Set<string>();
  for (const path of archivePaths) {
    if (actualPaths.has(path)) {
      issues.push({ path, code: "proof_zip_duplicate_entry" });
      continue;
    }
    actualPaths.add(path);
  }
  for (const path of expectedPaths) {
    if (!actualPaths.has(path)) issues.push({ path, code: "proof_zip_missing_entry" });
  }
  for (const path of actualPaths) {
    if (!expectedPaths.has(path)) issues.push({ path, code: "proof_zip_extra_entry" });
  }
  return { ok: issues.length === 0, checked: true, proof_zip: proofZip, issues };
}

function readZipEntryNames(data: Buffer): string[] {
  const eocdOffset = findZipEndOfCentralDirectory(data);
  if (eocdOffset < 0 || eocdOffset + 22 > data.length) throw new Error("zip end of central directory not found");
  const entryCount = data.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = data.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = data.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > data.length) throw new Error("zip central directory is outside archive");

  const names: string[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("zip central directory entry is malformed");
    }
    const fileNameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > data.length) throw new Error("zip entry name is outside archive");
    names.push(data.subarray(nameStart, nameEnd).toString("utf-8"));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

function findZipEndOfCentralDirectory(data: Buffer): number {
  if (data.length < 22) return -1;
  const minOffset = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minOffset; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function proofArchiveExpectedPaths(manifestRaw: unknown): Set<string> | undefined {
  if (!isRecord(manifestRaw) || !Array.isArray(manifestRaw["artifacts"])) return undefined;
  const paths = new Set<string>(["manifest.json"]);
  for (const artifact of manifestRaw["artifacts"]) {
    if (!isRecord(artifact) || typeof artifact["path"] !== "string" || artifact["path"].length === 0) return undefined;
    paths.add(artifact["path"]);
  }
  return paths;
}

async function releaseVersionPackagesPrCheck(): Promise<ReleaseDoctorCheck> {
  const override = process.env["OSSTACK_TEST_RELEASE_VERSION_PR"];
  if (override !== undefined) return releaseVersionPackagesPrOverride(override);
  try {
    const { stdout } = await execFileAsync("gh", [
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      "changeset-release/main",
      "--json",
      "number,title,url,mergeStateStatus,mergeable,isDraft,statusCheckRollup",
    ], { timeout: 10_000 });
    const prs = JSON.parse(stdout) as Array<{
      number?: number;
      title?: string;
      url?: string;
      mergeStateStatus?: string;
      mergeable?: string;
      isDraft?: boolean;
      statusCheckRollup?: unknown[];
    }>;
    if (prs.length === 0) {
      return {
        id: "version_packages_pr",
        status: "ok",
        message: "No open Version Packages PR is waiting for npm publish.",
      };
    }
    const pr = prs[0];
    const mergeState = pr?.mergeStateStatus ?? "UNKNOWN";
    const checkCount = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup.length : undefined;
    const latestCi = await latestVersionPrCiRun();
    const ready = pr?.isDraft !== true && (mergeState === "CLEAN" || mergeState === "HAS_HOOKS");
    return {
      id: "version_packages_pr",
      status: ready ? "ok" : "warn",
      message: ready
        ? `Version Packages PR #${pr?.number ?? "unknown"} is open and mergeable.`
        : `Version Packages PR #${pr?.number ?? "unknown"} needs attention before npm publish.`,
      details: {
        number: pr?.number,
        title: pr?.title,
        url: pr?.url,
        draft: pr?.isDraft,
        merge_state: mergeState,
        mergeable: pr?.mergeable,
        check_count: checkCount,
        latest_ci_status: latestCi?.status,
        latest_ci_conclusion: latestCi?.conclusion,
        latest_ci_url: latestCi?.url,
      },
    };
  } catch (error) {
    return {
      id: "version_packages_pr",
      status: "warn",
      message: "Could not inspect the Version Packages PR with gh pr list.",
      details: { error: releaseErrorMessage(error) },
    };
  }
}

async function latestVersionPrCiRun(): Promise<{ status?: string; conclusion?: string; url?: string } | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", [
      "run",
      "list",
      "--workflow",
      "CI",
      "--branch",
      "changeset-release/main",
      "--limit",
      "1",
      "--json",
      "status,conclusion,url",
    ], { timeout: 10_000 });
    const runs = JSON.parse(stdout) as Array<{ status?: string; conclusion?: string; url?: string }>;
    return runs[0];
  } catch {
    return undefined;
  }
}

function releaseVersionPackagesPrOverride(value: string): ReleaseDoctorCheck {
  if (value === "none") {
    return {
      id: "version_packages_pr",
      status: "ok",
      message: "No open Version Packages PR is waiting for npm publish.",
    };
  }
  const match = /^open:(\d+):([A-Z_]+)(?::([A-Z_]+))?(?::(\d+))?(?::CI:([a-z_]+))?$/.exec(value);
  if (match !== null) {
    const number = Number(match[1]);
    const mergeState = match[2] ?? "UNKNOWN";
    const mergeable = match[3];
    const checkCount = match[4] === undefined ? undefined : Number(match[4]);
    const latestCiConclusion = match[5];
    const ready = mergeState === "CLEAN" || mergeState === "HAS_HOOKS";
    return {
      id: "version_packages_pr",
      status: ready ? "ok" : "warn",
      message: ready
        ? `Version Packages PR #${number} is open and mergeable.`
        : `Version Packages PR #${number} needs attention before npm publish.`,
      details: {
        number,
        merge_state: mergeState,
        mergeable,
        check_count: checkCount,
        latest_ci_conclusion: latestCiConclusion,
        draft: false,
      },
    };
  }
  return {
    id: "version_packages_pr",
    status: "warn",
    message: "Could not parse OSSTACK_TEST_RELEASE_VERSION_PR.",
    details: { value },
  };
}

async function releaseKnowledgeCloudWorkflowCheck(): Promise<ReleaseDoctorCheck> {
  const override = process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"];
  if (override !== undefined) return releaseKnowledgeCloudWorkflowOverride(override);
  try {
    const { stdout: workflows } = await execFileAsync("gh", ["workflow", "list", "--all"], { timeout: 10_000 });
    const workflowLine = workflows.split(/\r?\n/).find((line) => line.startsWith("Knowledge Cloud Deploy\t"));
    if (workflowLine === undefined) {
      return {
        id: "knowledge_cloud_workflow",
        status: "error",
        message: "Knowledge Cloud Deploy workflow is missing.",
      };
    }
    const active = workflowLine.split(/\t/)[1] === "active";
    if (!active) {
      return {
        id: "knowledge_cloud_workflow",
        status: "error",
        message: "Knowledge Cloud Deploy workflow is not active.",
        details: { workflow: workflowLine },
      };
    }
    const { stdout: runs } = await execFileAsync("gh", [
      "run",
      "list",
      "--workflow",
      "Knowledge Cloud Deploy",
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,displayTitle,url,headBranch",
    ], { timeout: 10_000 });
    const parsed = JSON.parse(runs) as Array<{
      databaseId?: number;
      status?: string;
      conclusion?: string;
      displayTitle?: string;
      url?: string;
      headBranch?: string;
    }>;
    const latest = parsed[0];
    if (latest === undefined) {
      return {
        id: "knowledge_cloud_workflow",
        status: "warn",
        message: "Knowledge Cloud Deploy workflow is active but has no recorded validation runs.",
      };
    }
    const success = latest.status === "completed" && latest.conclusion === "success";
    return {
      id: "knowledge_cloud_workflow",
      status: success ? "ok" : "warn",
      message: success
        ? `Latest Knowledge Cloud deploy validation succeeded: run ${latest.databaseId ?? "unknown"}.`
        : `Latest Knowledge Cloud deploy validation is not successful: run ${latest.databaseId ?? "unknown"}.`,
      details: {
        run_id: latest.databaseId,
        status: latest.status,
        conclusion: latest.conclusion,
        title: latest.displayTitle,
        branch: latest.headBranch,
        url: latest.url,
      },
    };
  } catch (error) {
    return {
      id: "knowledge_cloud_workflow",
      status: "warn",
      message: "Could not inspect Knowledge Cloud Deploy workflow with gh.",
      details: { error: releaseErrorMessage(error) },
    };
  }
}

function releaseKnowledgeCloudWorkflowOverride(value: string): ReleaseDoctorCheck {
  if (value === "ok") {
    return {
      id: "knowledge_cloud_workflow",
      status: "ok",
      message: "Latest Knowledge Cloud deploy validation succeeded.",
      details: { status: "completed", conclusion: "success" },
    };
  }
  if (value === "missing") {
    return {
      id: "knowledge_cloud_workflow",
      status: "error",
      message: "Knowledge Cloud Deploy workflow is missing.",
    };
  }
  if (value === "warn" || value === "error") {
    return {
      id: "knowledge_cloud_workflow",
      status: value,
      message: "Knowledge Cloud Deploy workflow needs attention.",
    };
  }
  return {
    id: "knowledge_cloud_workflow",
    status: "warn",
    message: "Could not parse OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW.",
    details: { value },
  };
}

async function releaseSingleBinaryWorkflowCheck(): Promise<ReleaseDoctorCheck> {
  const override = process.env["OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW"];
  if (override !== undefined) return releaseSingleBinaryWorkflowOverride(override);
  try {
    const { stdout: workflows } = await execFileAsync("gh", ["workflow", "list", "--all"], { timeout: 10_000 });
    const workflowLine = workflows.split(/\r?\n/).find((line) => line.startsWith("Single Binary Release\t"));
    if (workflowLine === undefined) {
      return {
        id: "single_binary_workflow",
        status: "error",
        message: "Single Binary Release workflow is missing.",
      };
    }
    const active = workflowLine.split(/\t/)[1] === "active";
    if (!active) {
      return {
        id: "single_binary_workflow",
        status: "error",
        message: "Single Binary Release workflow is not active.",
        details: { workflow: workflowLine },
      };
    }
    const { stdout: runs } = await execFileAsync("gh", [
      "run",
      "list",
      "--workflow",
      "Single Binary Release",
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,displayTitle,url,headBranch",
    ], { timeout: 10_000 });
    const parsed = JSON.parse(runs) as Array<{
      databaseId?: number;
      status?: string;
      conclusion?: string;
      displayTitle?: string;
      url?: string;
      headBranch?: string;
    }>;
    const latest = parsed[0];
    if (latest === undefined) {
      return {
        id: "single_binary_workflow",
        status: "warn",
        message: "Single Binary Release workflow is active but has no recorded validation runs.",
      };
    }
    const success = latest.status === "completed" && latest.conclusion === "success";
    return {
      id: "single_binary_workflow",
      status: success ? "ok" : "warn",
      message: success
        ? `Latest Single Binary Release validation succeeded: run ${latest.databaseId ?? "unknown"}.`
        : `Latest Single Binary Release validation is not successful: run ${latest.databaseId ?? "unknown"}.`,
      details: {
        run_id: latest.databaseId,
        status: latest.status,
        conclusion: latest.conclusion,
        title: latest.displayTitle,
        branch: latest.headBranch,
        url: latest.url,
      },
    };
  } catch (error) {
    return {
      id: "single_binary_workflow",
      status: "warn",
      message: "Could not inspect Single Binary Release workflow with gh.",
      details: { error: releaseErrorMessage(error) },
    };
  }
}

function releaseSingleBinaryWorkflowOverride(value: string): ReleaseDoctorCheck {
  if (value === "ok") {
    return {
      id: "single_binary_workflow",
      status: "ok",
      message: "Latest Single Binary Release validation succeeded.",
      details: { status: "completed", conclusion: "success" },
    };
  }
  if (value === "missing") {
    return {
      id: "single_binary_workflow",
      status: "error",
      message: "Single Binary Release workflow is missing.",
    };
  }
  if (value === "warn" || value === "error") {
    return {
      id: "single_binary_workflow",
      status: value,
      message: "Single Binary Release workflow needs attention.",
    };
  }
  return {
    id: "single_binary_workflow",
    status: "warn",
    message: "Could not parse OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW.",
    details: { value },
  };
}

async function releaseGitHubActionsCheck(): Promise<ReleaseDoctorCheck> {
  const override = process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"];
  if (override !== undefined) return releaseGitHubActionsOverride(override);
  try {
    const { stdout } = await execFileAsync("gh", [
      "run",
      "list",
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,workflowName,displayTitle,url",
    ], { timeout: 10_000 });
    const runs = JSON.parse(stdout) as Array<{
      databaseId?: number;
      status?: string;
      conclusion?: string;
      workflowName?: string;
      displayTitle?: string;
      url?: string;
    }>;
    const latest = runs[0];
    if (latest === undefined) {
      return {
        id: "github_actions",
        status: "warn",
        message: "No recent GitHub Actions runs were found; trigger CI before publishing or deploying.",
      };
    }
    const billingFailure = latest.databaseId === undefined
      ? undefined
      : await releaseGitHubActionsBillingFailure(latest.databaseId);
    if (billingFailure !== undefined) {
      return {
        id: "github_actions",
        status: "error",
        message: "GitHub Actions runner is blocked by account billing or spending limits.",
        details: {
          run_id: latest.databaseId,
          status: latest.status,
          conclusion: latest.conclusion,
          workflow: latest.workflowName,
          title: latest.displayTitle,
          url: latest.url,
          annotation: billingFailure,
        },
      };
    }
    return {
      id: "github_actions",
      status: "ok",
      message: `GitHub Actions is reachable; latest run ${latest.databaseId ?? "unknown"} is inspectable.`,
      details: {
        run_id: latest.databaseId,
        status: latest.status,
        conclusion: latest.conclusion,
        workflow: latest.workflowName,
        title: latest.displayTitle,
        url: latest.url,
      },
    };
  } catch (error) {
    return {
      id: "github_actions",
      status: "warn",
      message: "Could not inspect GitHub Actions runs with gh.",
      details: { error: releaseErrorMessage(error) },
    };
  }
}

async function releaseGitHubActionsBillingFailure(runId: number): Promise<string | undefined> {
  try {
    const { stdout: jobsOutput } = await execFileAsync("gh", [
      "api",
      `repos/gilosbornhello/osstack/actions/runs/${runId}/jobs`,
    ], { timeout: 10_000 });
    const jobs = JSON.parse(jobsOutput) as {
      jobs?: Array<{
        id?: number;
        conclusion?: string;
        steps?: unknown[];
      }>;
    };
    const failedJob = jobs.jobs?.find((job) =>
      job.id !== undefined
      && job.conclusion === "failure"
      && Array.isArray(job.steps)
      && job.steps.length === 0
    );
    if (failedJob?.id === undefined) return undefined;
    const { stdout: annotationsOutput } = await execFileAsync("gh", [
      "api",
      `repos/gilosbornhello/osstack/check-runs/${failedJob.id}/annotations`,
    ], { timeout: 10_000 });
    const annotations = JSON.parse(annotationsOutput) as Array<{ message?: string }>;
    const annotation = annotations.find((item) =>
      typeof item.message === "string"
      && /payments have failed|spending limit/i.test(item.message)
    );
    return annotation?.message;
  } catch {
    return undefined;
  }
}

function releaseGitHubActionsOverride(value: string): ReleaseDoctorCheck {
  if (value === "ok") {
    return {
      id: "github_actions",
      status: "ok",
      message: "GitHub Actions is reachable.",
    };
  }
  if (value === "billing") {
    return {
      id: "github_actions",
      status: "error",
      message: "GitHub Actions runner is blocked by account billing or spending limits.",
      details: {
        annotation: "The job was not started because recent account payments have failed or your spending limit needs to be increased.",
      },
    };
  }
  if (value === "warn" || value === "error") {
    return {
      id: "github_actions",
      status: value,
      message: "GitHub Actions needs attention before publishing or deploying.",
    };
  }
  return {
    id: "github_actions",
    status: "warn",
    message: "Could not parse OSSTACK_TEST_RELEASE_GITHUB_ACTIONS.",
    details: { value },
  };
}

async function releaseSecretsCheck(requiredSecrets: string[]): Promise<ReleaseDoctorCheck> {
  const override = process.env["OSSTACK_TEST_RELEASE_SECRETS"];
  let present: string[];
  if (override !== undefined) {
    present = override.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  } else {
    try {
      const { stdout } = await execFileAsync("gh", ["secret", "list"], { timeout: 10_000 });
      present = parseSecretList(stdout);
    } catch (error) {
      return {
        id: "repository_secrets",
        status: "error",
        message: "Could not list GitHub repository secrets with gh secret list.",
        details: { required: requiredSecrets, error: releaseErrorMessage(error) },
      };
    }
  }
  const missing = requiredSecrets.filter((secret) => !present.includes(secret));
  return {
    id: "repository_secrets",
    status: missing.length === 0 ? "ok" : "error",
    message: missing.length === 0
      ? `Required repository secrets are configured: ${requiredSecrets.join(", ")}.`
      : `Missing required repository secrets: ${missing.join(", ")}.`,
    details: { required: requiredSecrets, present, missing },
  };
}

function parseSecretList(stdout: string): string[] {
  const secrets: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const name = line.trim().split(/\s+/)[0];
    if (name !== undefined && name.length > 0) secrets.push(name);
  }
  return secrets;
}

async function releaseCommandCheck(options: {
  id: string;
  command: string;
  args: string[];
  envOverride: string;
  okMessage: string;
  errorMessage: string;
  missingSeverity?: ReleaseDoctorStatus;
}): Promise<ReleaseDoctorCheck> {
  const override = process.env[options.envOverride];
  if (override === "ok") return { id: options.id, status: "ok", message: options.okMessage };
  if (override === "warn" || override === "error") {
    return { id: options.id, status: override, message: options.errorMessage };
  }
  try {
    await execFileAsync(options.command, options.args, { timeout: 10_000 });
    return { id: options.id, status: "ok", message: options.okMessage };
  } catch (error) {
    return {
      id: options.id,
      status: options.missingSeverity ?? "error",
      message: options.errorMessage,
      details: { error: releaseErrorMessage(error) },
    };
  }
}

function hasSecret(check: ReleaseDoctorCheck, secret: string): boolean {
  const present = check.details?.["present"];
  return Array.isArray(present) && present.includes(secret);
}

function releaseDoctorNextSteps(options: {
  target: ReleaseDoctorResult["target"];
  npmPublish: boolean;
  knowledgeCloudDeploy: boolean;
  singleBinaryRelease: boolean;
  githubAuth: ReleaseDoctorCheck;
  secrets: ReleaseDoctorCheck;
  checks: ReleaseDoctorCheck[];
}): string[] {
  const steps: string[] = [];
  if (options.githubAuth.status === "error") {
    steps.push("Refresh GitHub auth: gh auth refresh -h github.com -s workflow");
  }
  const githubActions = options.checks.find((check) => check.id === "github_actions");
  if (githubActions?.status === "error") {
    steps.push("Fix GitHub Actions billing or spending limit before publishing or deploying.");
  } else if (githubActions?.status === "warn") {
    steps.push("Confirm GitHub Actions can start workflow jobs before publishing or deploying.");
  }
  const missing = options.secrets.details?.["missing"];
  if (Array.isArray(missing) && missing.includes("NPM_TOKEN")) {
    steps.push("Add repository secret NPM_TOKEN before merging the Version Packages PR.");
  }
  if (Array.isArray(missing) && missing.includes("FLY_API_TOKEN")) {
    steps.push("Add repository secret FLY_API_TOKEN before running Knowledge Cloud deploy=true.");
  }
  if (Array.isArray(missing) && SINGLE_BINARY_RELEASE_SECRETS.some((secret) => missing.includes(secret))) {
    steps.push("Add Apple notarization and Developer ID repository secrets before running Single Binary Release dry_run=false.");
  }
  const versionPr = options.checks.find((check) => check.id === "version_packages_pr");
  if ((options.target === "all" || options.target === "npm") && versionPr?.status === "warn") {
    const number = typeof versionPr.details?.["number"] === "number" ? ` #${versionPr.details["number"]}` : "";
    const mergeable = versionPr.details?.["mergeable"];
    const checkCount = versionPr.details?.["check_count"];
    const latestCiConclusion = versionPr.details?.["latest_ci_conclusion"];
    const checkContext = latestCiConclusion === "action_required"
      ? "approve or rerun its latest CI workflow"
      : mergeable === "MERGEABLE" && checkCount === 0
      ? "it is mergeable but has no reported checks"
      : "it is not currently clean";
    steps.push(`Review Version Packages PR${number}; ${checkContext} for npm publish.`);
  }
  const npmPublishAssets = options.checks.find((check) => check.id === "npm_publish_assets");
  if ((options.target === "all" || options.target === "npm") && npmPublishAssets?.status === "error") {
    steps.push("Restore NPM publish assets before merging the Version Packages PR.");
  }
  const knowledgeDeployAssets = options.checks.find((check) => check.id === "knowledge_cloud_deploy_assets");
  if ((options.target === "all" || options.target === "knowledge-cloud") && knowledgeDeployAssets?.status === "error") {
    steps.push("Restore Knowledge Cloud deploy assets before running deploy=true.");
  }
  const knowledgeWorkflow = options.checks.find((check) => check.id === "knowledge_cloud_workflow");
  if ((options.target === "all" || options.target === "knowledge-cloud") && knowledgeWorkflow?.status === "error") {
    steps.push("Restore the Knowledge Cloud Deploy workflow before running deploy=true.");
  } else if ((options.target === "all" || options.target === "knowledge-cloud") && knowledgeWorkflow?.status === "warn") {
    steps.push("Review the latest Knowledge Cloud Deploy workflow run before running deploy=true.");
  }
  const knowledgeHealth = options.checks.find((check) => check.id === "knowledge_cloud_health");
  if ((options.target === "all" || options.target === "knowledge-cloud") && knowledgeHealth?.status === "error") {
    steps.push("Fix the deployed Knowledge Cloud /healthz endpoint before handoff.");
  }
  const knowledgeSearch = options.checks.find((check) => check.id === "knowledge_cloud_search");
  if ((options.target === "all" || options.target === "knowledge-cloud") && knowledgeSearch?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud search before handoff.");
  }
  const knowledgeSync = options.checks.find((check) => check.id === "knowledge_cloud_sync");
  if ((options.target === "all" || options.target === "knowledge-cloud") && knowledgeSync?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud sync before handoff.");
  }
  const knowledgeAudit = options.checks.find((check) => check.id === "knowledge_cloud_audit");
  if ((options.target === "all" || options.target === "knowledge-cloud") && knowledgeAudit?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud audit endpoint before handoff.");
  }
  const singleBinaryAssets = options.checks.find((check) => check.id === "single_binary_release_assets");
  if ((options.target === "all" || options.target === "single-binary") && singleBinaryAssets?.status === "error") {
    steps.push("Restore single-binary release assets before publishing release archives.");
  }
  const singleBinaryWorkflow = options.checks.find((check) => check.id === "single_binary_workflow");
  if ((options.target === "all" || options.target === "single-binary") && singleBinaryWorkflow?.status === "error") {
    steps.push("Restore the Single Binary Release workflow before uploading release archives.");
  } else if ((options.target === "all" || options.target === "single-binary") && singleBinaryWorkflow?.status === "warn") {
    steps.push("Review the latest Single Binary Release workflow run before uploading release archives.");
  }
  const proofValidation = options.checks.find((check) => check.id === "proof_validation");
  if (proofValidation?.status === "error") {
    steps.push(releaseProofValidationNextStep(proofValidation));
  }
  if ((options.target === "all" || options.target === "npm") && options.npmPublish) {
    steps.push("NPM publish path is ready for the release workflow.");
  }
  if ((options.target === "all" || options.target === "knowledge-cloud") && options.knowledgeCloudDeploy) {
    steps.push("Knowledge Cloud deploy=true is ready in GitHub Actions.");
  }
  if ((options.target === "all" || options.target === "single-binary") && options.singleBinaryRelease) {
    steps.push("Single-binary GitHub Release asset path is ready.");
  }
  if (steps.length === 0) steps.push("Review failed checks above before publishing.");
  return steps;
}

function releaseProofValidationNextStep(check: ReleaseDoctorCheck): string {
  const fileIntegrity = check.details?.["file_integrity"];
  const archiveIntegrity = check.details?.["archive_integrity"];
  if (
    (isRecord(fileIntegrity) && fileIntegrity["ok"] === false)
    || (isRecord(archiveIntegrity) && archiveIntegrity["ok"] === false)
  ) {
    return "Regenerate or repair proof pack artifacts before publishing or deploying.";
  }
  return "Fix missing or malformed proof evidence before publishing or deploying.";
}

function printReleaseDoctor(result: ReleaseDoctorResult): void {
  console.log(`Osstack release doctor: ${result.ok ? "ready" : "attention needed"}`);
  console.log(`target=${result.target}`);
  console.log("");
  for (const check of result.checks) {
    console.log(`[${check.status}] ${check.id}: ${check.message}`);
  }
  console.log("");
  console.log(`npm_publish=${result.readiness.npm_publish ? "ready" : "not_ready"}`);
  console.log(`knowledge_cloud_deploy=${result.readiness.knowledge_cloud_deploy ? "ready" : "not_ready"}`);
  console.log(`single_binary_release=${result.readiness.single_binary_release ? "ready" : "not_ready"}`);
  console.log("");
  console.log("Next steps:");
  for (const step of result.next_steps) console.log(`- ${step}`);
}

function renderReleaseReadinessReport(result: ReleaseDoctorResult): string {
  return [
    "# Osstack Release Readiness",
    "",
    `Target: \`${result.target}\``,
    `Overall: \`${result.ok ? "ready" : "attention_needed"}\``,
    "",
    "## Readiness",
    "",
    "| Area | Status |",
    "|---|---|",
    `| npm_publish | ${result.readiness.npm_publish ? "ready" : "not_ready"} |`,
    `| knowledge_cloud_deploy | ${result.readiness.knowledge_cloud_deploy ? "ready" : "not_ready"} |`,
    `| single_binary_release | ${result.readiness.single_binary_release ? "ready" : "not_ready"} |`,
    "",
    "## Checks",
    "",
    "| Check | Status | Message |",
    "|---|---|---|",
    ...result.checks.map((check) =>
      `| ${markdownCell(check.id)} | ${check.status} | ${markdownCell(check.message)} |`
    ),
    "",
    "## Details",
    "",
    ...result.checks.flatMap((check) => {
      if (check.details === undefined) return [];
      return [
        `### ${check.id}`,
        "",
        "```json",
        JSON.stringify(check.details, null, 2),
        "```",
        "",
      ];
    }),
    "## Next Steps",
    "",
    ...result.next_steps.map((step) => `- ${step}`),
    "",
  ].join("\n");
}

function releaseActionPlan(result: ReleaseDoctorResult, options: { proofDir?: string; cloudUrl?: string } = {}): ReleaseActionPlan {
  const versionPr = result.checks.find((check) => check.id === "version_packages_pr");
  const versionPrNumber = typeof versionPr?.details?.["number"] === "number"
    ? versionPr.details["number"]
    : undefined;
  const blockers = result.next_steps.filter((step) =>
    step.startsWith("Add repository secret")
    || step.startsWith("Refresh GitHub auth")
    || step.startsWith("Fix GitHub Actions")
    || step.startsWith("Add Apple notarization")
    || step.startsWith("Fix missing or malformed proof evidence")
    || step.startsWith("Regenerate or repair proof pack artifacts")
    || step.startsWith("Restore NPM publish assets")
    || step.startsWith("Restore Knowledge Cloud deploy assets")
    || step.startsWith("Restore the Knowledge Cloud Deploy workflow")
    || step.startsWith("Fix the deployed Knowledge Cloud")
    || step.startsWith("Fix deployed Knowledge Cloud")
    || step.startsWith("Restore single-binary release assets")
    || step.startsWith("Restore the Single Binary Release workflow")
    || step.startsWith("Review Version Packages PR")
  );
  const repositorySecrets = result.checks.find((check) => check.id === "repository_secrets");
  const missingSecrets = repositorySecrets?.details?.["missing"];
  const latestVersionPrCiUrl = typeof versionPr?.details?.["latest_ci_url"] === "string"
    ? versionPr.details["latest_ci_url"]
    : undefined;
  const latestVersionPrCiConclusion = versionPr?.details?.["latest_ci_conclusion"];
  const operatorCommands = [
    ...(Array.isArray(missingSecrets) && missingSecrets.includes("NPM_TOKEN")
      ? ["gh secret set NPM_TOKEN --repo gilosbornhello/osstack --body \"$NPM_TOKEN\""]
      : []),
    ...(Array.isArray(missingSecrets) && missingSecrets.includes("FLY_API_TOKEN")
      ? ["gh secret set FLY_API_TOKEN --repo gilosbornhello/osstack --body \"$FLY_API_TOKEN\""]
      : []),
    ...(Array.isArray(missingSecrets)
      ? SINGLE_BINARY_RELEASE_SECRETS
        .filter((secret) => missingSecrets.includes(secret))
        .map((secret) => `gh secret set ${secret} --repo gilosbornhello/osstack --body "$${secret}"`)
      : []),
    ...(latestVersionPrCiConclusion === "action_required"
      ? [
        "Open the latest Version Packages PR CI run and approve or rerun it if GitHub requires manual action.",
        ...(latestVersionPrCiUrl === undefined ? [] : [latestVersionPrCiUrl]),
      ]
      : []),
    ...(result.checks.find((check) => check.id === "github_actions")?.status === "error"
      ? ["Open GitHub Billing & plans and fix failed payments or increase the Actions spending limit."]
      : []),
  ];
  const validationCommands = [
    `osstack release doctor --target ${result.target}${options.proofDir === undefined ? "" : ` --proof-dir ${options.proofDir}`}${options.cloudUrl === undefined ? "" : ` --cloud-url ${options.cloudUrl}`} --output release-readiness.md --json`,
    `osstack proof validate <run_id> --proof-dir ${options.proofDir ?? "release/osstack-proof-<run_id>"} --json`,
    ...(result.target === "all" ? ["pnpm smoke:release-plan"] : []),
    ...(result.target === "all" || result.target === "npm"
      ? [
        "pnpm smoke:npm-install",
        versionPrNumber === undefined
          ? "gh pr list --state open --head changeset-release/main --json number,mergeable,mergeStateStatus,statusCheckRollup,url"
          : `gh pr view ${versionPrNumber} --json mergeable,mergeStateStatus,statusCheckRollup,url`,
        "gh run list --branch changeset-release/main --limit 5",
      ]
      : []),
    ...(result.target === "all" || result.target === "knowledge-cloud"
      ? [
        "pnpm smoke:knowledge-cloud:deploy",
        "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false",
      ]
      : []),
    ...(result.target === "all" || result.target === "single-binary"
      ? [
        "pnpm smoke:single-binary-release-pack",
        "pnpm smoke:single-binary-release-publish",
        "gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=true",
      ]
      : []),
  ];
  const publishCommands = [
    ...(result.target === "knowledge-cloud" || result.target === "single-binary" ? [] : [
      ...(versionPrNumber === undefined ? [] : [`gh pr merge ${versionPrNumber} --squash --delete-branch`]),
      "npm install -g @osstack/cli",
      "osstack --version",
      "osstack loop doctor --workspace .",
    ]),
    ...(result.target === "all" || result.target === "single-binary"
      ? ["gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=false"]
      : []),
  ];
  const knowledgeCloudUrl = options.cloudUrl ?? "https://knowledge.osstack.ai";
  const deployCommands = result.target === "npm" || result.target === "single-binary" ? [] : [
    "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true",
    `osstack knowledge login --cloud-url ${knowledgeCloudUrl}`,
    `osstack knowledge sync --cloud-url ${knowledgeCloudUrl} --json`,
    `osstack knowledge search "proof pack checksum" --cloud-url ${knowledgeCloudUrl} --json`,
  ];
  const postReleaseValidationCommands = [
    ...(result.target === "knowledge-cloud" || result.target === "single-binary" ? [] : [
      "npm view @osstack/cli version --json",
      "npm install -g @osstack/cli",
      "osstack --version",
      "osstack release doctor --target npm --json",
      "osstack doctor --workspace . --json",
    ]),
    ...(result.target === "npm" || result.target === "single-binary" ? [] : [
      `osstack release doctor --target knowledge-cloud --cloud-url ${knowledgeCloudUrl} --json`,
      `osstack knowledge sync --cloud-url ${knowledgeCloudUrl} --json`,
      `osstack knowledge search "proof pack checksum" --cloud-url ${knowledgeCloudUrl} --json`,
    ]),
    ...(result.target === "all" || result.target === "single-binary"
      ? ["osstack release doctor --target single-binary --json"]
      : []),
    ...(result.target === "npm" || result.target === "knowledge-cloud" ? [] : [
      "gh release view v<version> --repo gilosbornhello/osstack",
      "gh release download v<version> --repo gilosbornhello/osstack --pattern 'osstack-*.tar.gz' --pattern 'osstack-*.archive.json' --pattern 'osstack-*.sbom.spdx.json' --pattern 'sha256sums.txt'",
      "test -s osstack-*.archive.json && test -s osstack-*.sbom.spdx.json",
      "tar -xzf osstack-*.tar.gz",
      "shasum -a 256 -c sha256sums.txt",
    ]),
  ];
  return {
    target: result.target,
    ready: result.ok,
    safe_to_execute: result.ok && blockers.length === 0,
    blockers,
    operator_commands: operatorCommands,
    validation_commands: validationCommands,
    publish_commands: publishCommands,
    deploy_commands: deployCommands,
    post_release_validation_commands: postReleaseValidationCommands,
  };
}

function renderReleaseActionPlan(plan: ReleaseActionPlan): string {
  return [
    "# Osstack Release Action Plan",
    "",
    `Target: \`${plan.target}\``,
    `Ready: \`${plan.ready ? "yes" : "no"}\``,
    `Safe to execute publish/deploy commands: \`${plan.safe_to_execute ? "yes" : "no"}\``,
    ...(plan.safe_to_execute ? [] : [
      "",
      "> Do not run publish or deploy commands until blockers are resolved.",
    ]),
    "",
    "## Blockers",
    "",
    ...(plan.blockers.length === 0 ? ["No blocking release prerequisites detected."] : plan.blockers.map((step) => `- ${step}`)),
    "",
    "## Operator Commands",
    "",
    ...(plan.operator_commands.length === 0 ? ["No manual operator commands required."] : plan.operator_commands.map((command) =>
      command.startsWith("http") ? `- ${command}` : `- \`${command}\``
    )),
    "",
    "## Validation Commands",
    "",
    ...plan.validation_commands.map((command) => `- \`${command}\``),
    "",
    "## Publish Commands",
    "",
    ...(plan.publish_commands.length === 0 ? ["No npm publish commands for this target."] : plan.publish_commands.map((command) => `- \`${command}\``)),
    "",
    "## Deploy Commands",
    "",
    ...(plan.deploy_commands.length === 0 ? ["No Knowledge Cloud deploy commands for this target."] : plan.deploy_commands.map((command) => `- \`${command}\``)),
    "",
    "## Post-Release Validation Commands",
    "",
    ...plan.post_release_validation_commands.map((command) => `- \`${command}\``),
    "",
  ].join("\n");
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function releaseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function handleCheckpointCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "help";
  if (sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack checkpoint — shadow recovery points for non-worktree runs

  osstack checkpoint create [--workspace P] [--json]

Checkpoints are written under $OSSTACK_HOME/checkpoints and never inside .git.
`);
    return 0;
  }
  if (sub !== "create") {
    console.error(`osstack: unknown checkpoint subcommand "${sub}"`);
    return 1;
  }

  const workspacePath = realpathSync(flagValue(args, "--workspace") ?? process.cwd());
  const checkpoint = await createShadowCheckpoint(workspacePath);
  if (args.includes("--json")) {
    console.log(JSON.stringify(checkpoint, null, 2));
  } else {
    console.log(`checkpoint=${checkpoint.checkpoint_id}`);
    console.log(`dir=${checkpoint.checkpoint_dir}`);
    console.log(`files=${checkpoint.files} bytes=${checkpoint.bytes}`);
  }
  return 0;
}

interface ShadowCheckpointSummary {
  checkpoint_id: string;
  checkpoint_dir: string;
  metadata_path: string;
  workspace: string;
  files: number;
  bytes: number;
}

async function createShadowCheckpoint(workspacePath: string): Promise<ShadowCheckpointSummary> {
  const workspaceStat = await stat(workspacePath);
  if (!workspaceStat.isDirectory()) throw new Error(`workspace is not a directory: ${workspacePath}`);
  const checkpointId = `chk_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const checkpointDir = join(osstackHome(), "checkpoints", checkpointId);
  const filesDir = join(checkpointDir, "files");
  const exclusions = [".git", "node_modules", ".osstack"];
  const entries = await collectCheckpointFiles(workspacePath, workspacePath, new Set(exclusions));
  let totalBytes = 0;
  const metadataFiles: Array<{ path: string; sha256: string; bytes: number }> = [];
  await mkdir(filesDir, { recursive: true });
  for (const entry of entries) {
    const target = join(filesDir, entry.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(entry.sourcePath, target);
    totalBytes += entry.bytes;
    metadataFiles.push({
      path: entry.relativePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
    });
  }
  const metadata = {
    kind: "osstack.shadow_checkpoint",
    version: 1,
    checkpoint_id: checkpointId,
    created_at: new Date().toISOString(),
    workspace: workspacePath,
    files_root: filesDir,
    files: metadataFiles,
    exclusions,
    notes: [
      "Shadow checkpoints are stored outside the workspace and do not write to .git.",
      "Restore/rewind commands can be layered on this metadata in a later release.",
    ],
  };
  const metadataPath = join(checkpointDir, "metadata.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return {
    checkpoint_id: checkpointId,
    checkpoint_dir: checkpointDir,
    metadata_path: metadataPath,
    workspace: workspacePath,
    files: metadataFiles.length,
    bytes: totalBytes,
  };
}

async function collectCheckpointFiles(
  root: string,
  current: string,
  excludedNames: Set<string>,
): Promise<Array<{ sourcePath: string; relativePath: string; sha256: string; bytes: number }>> {
  const dirents = await readdir(current, { withFileTypes: true });
  const files: Array<{ sourcePath: string; relativePath: string; sha256: string; bytes: number }> = [];
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (excludedNames.has(dirent.name)) continue;
    const sourcePath = join(current, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...await collectCheckpointFiles(root, sourcePath, excludedNames));
      continue;
    }
    if (!dirent.isFile()) continue;
    const content = await readFile(sourcePath);
    files.push({
      sourcePath,
      relativePath: relative(root, sourcePath),
      sha256: sha256Buffer(content),
      bytes: content.byteLength,
    });
  }
  return files;
}

function osstackExamples(): Array<{ title: string; description: string; commands: string[] }> {
  return [
    {
      title: "Fix a bug",
      description: "Queue a failing behavior, run the loop, and produce evidence.",
      commands: [
        "osstack loop enqueue \"Fix the failing unit test\" --capability code.test",
        "osstack loop run --source task_queue --verify \"pnpm test\" --report --scorecard --proof",
      ],
    },
    {
      title: "Implement a feature",
      description: "Use the product entry command to create a task, execute, verify, and package proof.",
      commands: [
        "osstack deliver \"Add billing dashboard\" --verify \"pnpm test\" --auto-agent --worktree --json",
      ],
    },
    {
      title: "Review git diff",
      description: "Turn local changes into a review/checker workflow.",
      commands: [
        "osstack loop run --source git_diff --reviewer ds-review --verify \"pnpm test\" --report",
      ],
    },
    {
      title: "Auto-agent routing",
      description: "Let router and policy choose the maker based on capability and local availability.",
      commands: [
        "osstack agent list",
        "osstack loop run --source task_queue --auto-agent --verify \"pnpm test\"",
      ],
    },
    {
      title: "Worktree isolation",
      description: "Run each task in an isolated worktree, then merge only successful changes.",
      commands: [
        "osstack loop run --source task_queue --worktree --worktree-root ../osstack-worktrees --verify \"pnpm test\"",
      ],
    },
    {
      title: "Proof pack",
      description: "Generate report, scorecard, proof pack, and PR evidence body.",
      commands: [
        "osstack loop run --source task_queue --report --scorecard --proof",
        "osstack pr --dry-run",
      ],
    },
  ];
}

function renderQuickstartGuide(): string {
  return `# Osstack 5-minute quickstart

## 1. Install and check readiness

\`\`\`bash
npm install -g @osstack/cli
osstack --version
osstack doctor --workspace .
\`\`\`

## 2. Queue one task

\`\`\`bash
osstack loop enqueue "Run local checks and fix the first failure" --capability code.test
\`\`\`

## 3. Run the loop and generate evidence

\`\`\`bash
osstack loop run --source task_queue --verify "pnpm test" --report --scorecard --proof
\`\`\`

## 4. Inspect the result

\`\`\`bash
osstack loop status
osstack report
osstack proof view "$(node -e 'const s=require("./LOOP-STATE.json"); process.stdout.write(s.loop_id)')" --audience engineer
\`\`\`

## 5. Try the product entry path

\`\`\`bash
osstack deliver "Add billing dashboard" --verify "pnpm test" --auto-agent --worktree
\`\`\`

More workflows:

\`\`\`bash
osstack examples
\`\`\`
`;
}

async function listLocalAgentProfiles(): Promise<Array<{
  id: string;
  display_name: string;
  cost_tier: string;
  auth_mode: string;
  roles: string[];
  capabilities: Array<{ id: string; kind: string; description: string; cost_tier: string }>;
  available: { available: boolean; reason?: string; last_checked_at: number };
}>> {
  return await Promise.all(defaultAdapters().map(async (adapter) => {
    const capabilities = adapter.capabilities();
    return {
      id: adapter.id,
      display_name: adapter.display_name,
      cost_tier: adapter.cost_tier,
      auth_mode: agentAuthMode(adapter.id),
      roles: rolesForCapabilityKinds(capabilities.map((capability) => capability.kind)),
      capabilities: capabilities.map((capability) => ({
        id: capability.id,
        kind: capability.kind,
        description: capability.description,
        cost_tier: capability.cost_tier,
      })),
      available: await adapter.isAvailable(),
    };
  }));
}

function printAgentScorecard(scorecard: ReturnType<typeof getAgentScorecard>): void {
  console.log(`${scorecard.agent_id}`);
  console.log(`  runs=${scorecard.total_runs} completed=${scorecard.completed_runs} failed=${scorecard.failed_runs} success=${Math.round(scorecard.success_rate * 100)}%`);
  console.log(`  avg_duration_ms=${scorecard.avg_duration_ms ?? "unknown"} cost_tier=${scorecard.cost_tier} fit=${scorecard.capability_fit}`);
  const adapter = defaultAdapters().find((candidate) => candidate.id === scorecard.agent_id);
  const scorecardKinds = scorecard.best_task_kinds.map((kind) => kind.kind);
  const roles = rolesForCapabilityKinds(adapter?.capabilities().map((capability) => capability.kind) ?? scorecardKinds);
  if (roles.length > 0) console.log(`  roles=${roles.join(",")}`);
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

  osstack govern check [path...] [--workspace P] [--changed] [--json]
  osstack governance scan <path...> [--json]
`);
    return 0;
  }

  if (sub !== "scan" && sub !== "check") {
    console.error(`osstack: unknown governance subcommand "${sub}"`);
    return 1;
  }

  const paths = positionalValues(args.slice(1), new Set(["--workspace"])).filter((value) => value !== sub);
  if (paths.length === 0) {
    if (sub === "scan") {
      console.error("osstack: governance scan requires at least one path");
      return 1;
    }
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const resolvedPaths = args.includes("--changed") || args.includes("--diff")
      ? await collectChangedGovernanceScanFiles(workspacePath)
      : await collectGovernanceScanFiles(workspacePath);
    if (resolvedPaths instanceof Error) {
      console.error(`osstack: ${resolvedPaths.message}`);
      return 1;
    }
    return await runGovernanceScan(resolvedPaths, args);
  }

  return await runGovernanceScan(paths, args);
}

async function runGovernanceScan(paths: string[], args: string[]): Promise<number> {
  const result = await scanFiles(paths);
  const output = { ...result, scanned_files: paths };
  if (args.includes("--json")) {
    console.log(JSON.stringify(output, null, 2));
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
  osstack compliance render <run_id> --pack engineering-readiness [--proof-dir P] [--workspace P] [--output P] [--lang en|zh-CN] [--json]

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
    const runId = firstPositionalValue(args.slice(1), new Set(["--pack", "--proof-dir", "--workspace", "--output", "--lang"]));
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
    const language = resolveLanguage(flagValue(args, "--lang"));
    const markdown = await renderComplianceReportFromProofDir({ packId, runId, proofDir, language });
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

  osstack knowledge list --pack P|--official [--json]
  osstack knowledge login --cloud-url URL [--token T] [--cache-dir P] [--json]
  osstack knowledge sync [--cloud-url URL] [--cache-dir P] [--private] [--tenant T] [--json]
  osstack knowledge search <query> [--pack P] [--official] [--cloud-url URL] [--tenant T] [--cache-dir P] [--limit N] [--json]
  osstack knowledge inspect <chunk_id> [--pack P] [--official] [--cache-dir P] [--json]
  osstack knowledge import P --scope team|project --id ID --name NAME --license L --output P [--taxonomy T] [--json]
  osstack knowledge ingest P --scope official|team|project --id ID --name NAME --license L --output P [--taxonomy T] [--source-kind K] [--reviewer ID] [--review-status approved|changes_requested] [--review-note TEXT] [--json]
  osstack knowledge validate --pack P|--official [--json]
  osstack knowledge pin <pack_id>@<version> [--cache-dir P] [--json]
  osstack knowledge feedback <chunk_id> --useful|--bad [--tenant ID] [--cloud-url URL] [--cache-dir P] [--json]
  osstack knowledge eval --pack P|--official --fixtures P [--top-k N] [--json]
  osstack knowledge sources --internal --pack P|--official [--json]

Env:
  OSSTACK_KNOWLEDGE_URL  Default Knowledge Cloud base URL
  OSSTACK_KNOWLEDGE_TOKEN
                         Default Knowledge Cloud bearer token for login/sync/search/feedback
  OSSTACK_KNOWLEDGE_CACHE_DIR
                         Default local Knowledge Cloud cache directory
`);
    return 0;
  }

  if (sub === "list") {
    const packPaths = flagValues(args, "--pack");
    if (packPaths.length === 0 && !args.includes("--official")) {
      console.error("osstack: knowledge list requires at least one --pack path or --official");
      return 1;
    }
    const packs = [
      ...await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath))),
      ...await officialKnowledgePacksIfRequested(args),
    ];
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

  if (sub === "login") {
    const cloudUrl = flagValue(args, "--cloud-url") ?? process.env["OSSTACK_KNOWLEDGE_URL"];
    if (cloudUrl === undefined || cloudUrl.trim().length === 0) {
      console.error("osstack: knowledge login requires --cloud-url or OSSTACK_KNOWLEDGE_URL");
      return 1;
    }
    const token = flagValue(args, "--token") ?? process.env["OSSTACK_KNOWLEDGE_TOKEN"];
    const config = {
      cloud_url: cloudUrl.trim(),
      ...(token === undefined || token.trim().length === 0 ? {} : { token: token.trim() }),
      saved_at: new Date().toISOString(),
    };
    const cacheDir = knowledgeCacheDir(args);
    await mkdir(cacheDir, { recursive: true });
    const configPath = knowledgeConfigPath(cacheDir);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    await chmod(configPath, 0o600);
    const result = {
      login: {
        cloud_url: config.cloud_url,
        cache_dir: cacheDir,
        config_path: configPath,
        authenticated: "token" in config,
      },
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`knowledge_cloud=${result.login.cloud_url}`);
      console.log(`cache=${result.login.cache_dir}`);
      console.log(`authenticated=${result.login.authenticated ? "yes" : "no"}`);
    }
    return 0;
  }

  if (sub === "sync") {
    const config = await readKnowledgeCloudConfig(knowledgeCacheDir(args));
    const cloudUrl = resolveKnowledgeCloudUrl(args, config);
    if (cloudUrl === undefined) {
      console.error("osstack: knowledge sync requires --cloud-url, OSSTACK_KNOWLEDGE_URL, or `osstack knowledge login`");
      return 1;
    }
    const authToken = resolveKnowledgeAuthToken(args, config);
    const privatePacks = args.includes("--private");
    const tenantId = flagValue(args, "--tenant");
    const evidence = await syncKnowledgeCache({
      cacheDir: knowledgeCacheDir(args),
      cloudUrl,
      ...(authToken === undefined ? {} : { authToken }),
      ...(privatePacks ? { privatePacks: true } : {}),
      ...(tenantId === undefined ? {} : { tenantId }),
    });
    const summary = {
      ...evidence,
      private: privatePacks,
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else if (evidence.status === "synced") {
      console.log(`synced=${evidence.packs.length}`);
      console.log(`cache=${evidence.cache_dir}`);
      if (privatePacks) console.log(`private=yes${tenantId === undefined ? "" : ` tenant=${tenantId}`}`);
    } else {
      console.error(`osstack: knowledge sync failed: ${evidence.reason ?? "unknown"}`);
      return 1;
    }
    return evidence.status === "synced" ? 0 : 1;
  }

  if (sub === "search") {
    const packPaths = flagValues(args, "--pack");
    const config = await readKnowledgeCloudConfig(knowledgeCacheDir(args));
    const cloudUrl = resolveKnowledgeCloudUrl(args, config);
    const mode = parseKnowledgeMode(flagValue(args, "--mode"));
    if (mode === undefined && flagValue(args, "--mode") !== undefined) {
      console.error("osstack: --mode must be one of off, local, cloud");
      return 1;
    }
    const query = positionalValues(args.slice(1), new Set(["--pack", "--limit", "--cloud-url", "--mode", "--cache-dir", "--tenant", "--token"])).join(" ");
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
      ...await officialKnowledgePacksIfRequested(args),
      ...await listCachedKnowledgePacks(knowledgeCacheDir(args)),
    ];
    if (packs.length === 0 && cloudUrl === undefined && mode !== "off") {
      console.error("osstack: knowledge search requires at least one --pack path, --official, cached pack, or --cloud-url");
      return 1;
    }
    const authToken = resolveKnowledgeAuthToken(args, config);
    const tenantId = flagValue(args, "--tenant");
    const evidence = await resolveKnowledgeSearch(knowledgeSearchOptions({
      mode,
      query,
      packs,
      limit,
      cloudUrl,
      ...(authToken === undefined ? {} : { authToken }),
      ...(tenantId === undefined ? {} : { tenantId }),
    }));
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

  if (sub === "inspect") {
    const chunkId = firstPositionalValue(args.slice(1), new Set(["--pack", "--cache-dir"]));
    if (chunkId === undefined) {
      console.error("osstack: knowledge inspect requires <chunk_id>");
      return 1;
    }
    const packPaths = flagValues(args, "--pack");
    const packs = [
      ...await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath))),
      ...await officialKnowledgePacksIfRequested(args),
      ...await listCachedKnowledgePacks(knowledgeCacheDir(args)),
    ];
    for (const pack of packs) {
      const chunk = pack.manifest.chunks.find((item) => item.chunk_id === chunkId);
      if (chunk === undefined) continue;
      const sourceRefs = new Set(chunk.source_refs ?? []);
      const sources = (pack.manifest.source_provenance ?? []).filter((source) => sourceRefs.has(source.source_id));
      const result = {
        pack: {
          id: pack.manifest.id,
          version: pack.manifest.version,
          name: pack.manifest.name,
          license: pack.manifest.license,
          source_kind: pack.manifest.source_kind,
          quality_score: pack.manifest.quality_score,
          path: pack.path,
        },
        chunk,
        sources,
      };
      if (args.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${pack.manifest.id}@${pack.manifest.version}:${chunk.chunk_id}`);
        console.log(chunk.title);
        console.log(chunk.body);
        if ((chunk.tags ?? []).length > 0) console.log(`tags=${chunk.tags?.join(",")}`);
        if (sources.length > 0) {
          console.log("sources:");
          for (const source of sources) {
            console.log(`  ${source.source_id} ${source.path} scope=${source.scope} license=${source.license}`);
          }
        }
      }
      return 0;
    }
    console.error(`osstack: knowledge chunk not found: ${chunkId}`);
    return 1;
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
    if (qualityScoreRaw !== undefined && (
      qualityScore === undefined
      || !Number.isInteger(qualityScore)
      || qualityScore < 0
      || qualityScore > 100
    )) {
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

  if (sub === "ingest") {
    const sourcePath = firstPositionalValue(args.slice(1), new Set([
      "--scope",
      "--id",
      "--name",
      "--license",
      "--output",
      "--taxonomy",
      "--quality-score",
      "--source-kind",
      "--reviewer",
      "--review-status",
      "--review-note",
    ]));
    if (sourcePath === undefined) {
      console.error("osstack: knowledge ingest requires a source path");
      return 1;
    }
    const scope = parseKnowledgeScope(flagValue(args, "--scope"));
    if (scope === undefined) {
      console.error("osstack: --scope must be one of official, team, project");
      return 1;
    }
    const sourceKind = parseKnowledgeSourceKind(flagValue(args, "--source-kind"));
    if (sourceKind === undefined && flagValue(args, "--source-kind") !== undefined) {
      console.error("osstack: --source-kind must be one of osstack_native, processed_mit, curated_external, internal");
      return 1;
    }
    const id = flagValue(args, "--id");
    const name = flagValue(args, "--name");
    const license = flagValue(args, "--license");
    const output = flagValue(args, "--output");
    if (id === undefined || name === undefined || license === undefined || output === undefined) {
      console.error("osstack: knowledge ingest requires --id, --name, --license, and --output");
      return 1;
    }
    const qualityScoreRaw = flagValue(args, "--quality-score");
    const qualityScore = qualityScoreRaw === undefined ? undefined : Number.parseInt(qualityScoreRaw, 10);
    if (qualityScoreRaw !== undefined && (
      qualityScore === undefined
      || !Number.isInteger(qualityScore)
      || qualityScore < 0
      || qualityScore > 100
    )) {
      console.error("osstack: --quality-score must be an integer from 0 to 100");
      return 1;
    }
    const reviewStatus = parseKnowledgeReviewStatus(flagValue(args, "--review-status"));
    if (reviewStatus === undefined && flagValue(args, "--review-status") !== undefined) {
      console.error("osstack: --review-status must be approved or changes_requested");
      return 1;
    }
    const reviewerId = flagValue(args, "--reviewer");
    const reviewNote = flagValue(args, "--review-note");
    if ((reviewerId === undefined) !== (reviewStatus === undefined)) {
      console.error("osstack: knowledge ingest review metadata requires both --reviewer and --review-status");
      return 1;
    }
    const manifest = await ingestKnowledgeSource({
      path: sourcePath,
      id,
      name,
      license,
      scope,
      taxonomy: flagValues(args, "--taxonomy"),
      ...(qualityScore === undefined ? {} : { qualityScore }),
      ...(sourceKind === undefined ? {} : { sourceKind }),
      ...(reviewerId === undefined || reviewStatus === undefined
        ? {}
        : {
          review: {
            status: reviewStatus,
            reviewer_id: reviewerId,
            reviewed_at: new Date().toISOString(),
            summary: reviewNote ?? "Knowledge source reviewed for Osstack publication.",
          },
        }),
    });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        pack_id: manifest.id,
        output,
        source_kind: manifest.source_kind,
        taxonomy: manifest.taxonomy ?? [],
        review_status: manifest.review?.status ?? "unknown",
        chunks: manifest.chunks.length,
        sources: manifest.source_provenance?.length ?? 0,
      }, null, 2));
    } else {
      console.log(`Ingested ${manifest.chunks.length} osstack-native chunk(s) into ${output}`);
    }
    return 0;
  }

  if (sub === "validate") {
    const packPaths = flagValues(args, "--pack");
    if (packPaths.length === 0 && !args.includes("--official")) {
      console.error("osstack: knowledge validate requires at least one --pack path or --official");
      return 1;
    }
    const packs = [
      ...await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath))),
      ...await officialKnowledgePacksIfRequested(args),
    ];
    const reports = packs.map((pack) => ({
      pack_id: pack.manifest.id,
      version: pack.manifest.version,
      path: pack.path,
      ...validateKnowledgePublishGate(pack.manifest),
    }));
    const ok = reports.every((report) => report.ok);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ok, packs: reports }, null, 2));
    } else {
      for (const report of reports) {
        console.log(`${report.ok ? "OK" : "FAIL"} ${report.pack_id}@${report.version}`);
        for (const issue of report.issues) {
          console.log(`  ${issue.code}: ${issue.message}`);
        }
      }
    }
    return ok ? 0 : 1;
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
    const chunkId = firstPositionalValue(args.slice(1), new Set(["--cloud-url", "--cache-dir", "--tenant"]));
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
    const config = await readKnowledgeCloudConfig(knowledgeCacheDir(args));
    const cloudUrl = resolveKnowledgeCloudUrl(args, config);
    const authToken = resolveKnowledgeAuthToken(args, config);
    const tenantId = flagValue(args, "--tenant");
    const feedback = await cacheKnowledgeFeedback({
      cacheDir: knowledgeCacheDir(args),
      chunkId,
      rating: useful ? "useful" : "bad",
      ...(cloudUrl !== undefined ? { cloudUrl } : {}),
      ...(authToken === undefined ? {} : { authToken }),
      ...(tenantId === undefined ? {} : { tenantId }),
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
    if ((packPaths.length === 0 && !args.includes("--official")) || fixturesPath === undefined) {
      console.error("osstack: knowledge eval requires --pack or --official, plus --fixtures");
      return 1;
    }
    const topKRaw = flagValue(args, "--top-k");
    const topK = topKRaw === undefined ? 3 : Number.parseInt(topKRaw, 10);
    if (!Number.isInteger(topK) || topK <= 0) {
      console.error("osstack: --top-k must be a positive integer");
      return 1;
    }
    const packs = [
      ...await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath))),
      ...await officialKnowledgePacksIfRequested(args),
    ];
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
    if (packPath === undefined && !args.includes("--official")) {
      console.error("osstack: knowledge sources requires --pack or --official");
      return 1;
    }
    if (!args.includes("--internal")) {
      console.error("osstack: knowledge sources requires --internal to show provenance");
      return 1;
    }
    const packs = [
      ...(packPath === undefined ? [] : [await loadKnowledgePack(packPath)]),
      ...await officialKnowledgePacksIfRequested(args),
    ];
    const packSources = packs.map((pack) => ({
      pack_id: pack.manifest.id,
      version: pack.manifest.version,
      sources: pack.manifest.source_provenance ?? [],
    }));
    if (args.includes("--json")) {
      console.log(JSON.stringify({ packs: packSources }, null, 2));
    } else {
      for (const pack of packSources) {
        console.log(`${pack.pack_id}@${pack.version}`);
        if (pack.sources.length === 0) {
          console.log("  no internal provenance recorded");
          continue;
        }
        for (const source of pack.sources) {
          console.log(`  ${source.source_id} ${source.path} scope=${source.scope} license=${source.license}`);
        }
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

function parseKnowledgeSourceKind(
  value: string | undefined,
): "osstack_native" | "processed_mit" | "curated_external" | "internal" | undefined {
  if (value === undefined) return undefined;
  if (
    value === "osstack_native"
    || value === "processed_mit"
    || value === "curated_external"
    || value === "internal"
  ) return value;
  return undefined;
}

function parseKnowledgeReviewStatus(value: string | undefined): "approved" | "changes_requested" | undefined {
  if (value === undefined) return undefined;
  if (value === "approved" || value === "changes_requested") return value;
  return undefined;
}

function knowledgeCacheDir(args: string[]): string {
  return flagValue(args, "--cache-dir")
    ?? process.env["OSSTACK_KNOWLEDGE_CACHE_DIR"]
    ?? join(osstackHome(), "knowledge-cache");
}

async function officialKnowledgePacksIfRequested(args: string[]): Promise<KnowledgePack[]> {
  if (!args.includes("--official")) return [];
  return loadOfficialKnowledgePacks();
}

async function loadOfficialKnowledgePacks(): Promise<KnowledgePack[]> {
  const configuredIndex = process.env["OSSTACK_OFFICIAL_KNOWLEDGE_INDEX"];
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(configuredIndex === undefined || configuredIndex.trim().length === 0 ? [] : [configuredIndex.trim()]),
    join(process.cwd(), "knowledge-packs", "official", "index.json"),
    join(here, "..", "..", "..", "knowledge-packs", "official", "index.json"),
  ];
  const failures: string[] = [];
  for (const indexPath of candidates) {
    try {
      const index = await loadKnowledgePackIndex(indexPath);
      const indexDir = dirname(indexPath);
      return Promise.all(index.packs.map((pack) => loadKnowledgePack(join(indexDir, pack.path))));
    } catch (error) {
      failures.push(`${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`official knowledge packs unavailable; tried ${failures.join("; ")}`);
}

interface KnowledgeCloudConfig {
  cloud_url?: string;
  token?: string;
}

function knowledgeConfigPath(cacheDir: string): string {
  return join(cacheDir, "config.json");
}

async function readKnowledgeCloudConfig(cacheDir: string): Promise<KnowledgeCloudConfig> {
  try {
    const parsed = JSON.parse(await readFile(knowledgeConfigPath(cacheDir), "utf-8")) as unknown;
    if (!isRecord(parsed)) return {};
    return {
      ...(typeof parsed["cloud_url"] === "string" && parsed["cloud_url"].trim().length > 0
        ? { cloud_url: parsed["cloud_url"].trim() }
        : {}),
      ...(typeof parsed["token"] === "string" && parsed["token"].trim().length > 0
        ? { token: parsed["token"].trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

function resolveKnowledgeCloudUrl(args: string[], config: KnowledgeCloudConfig): string | undefined {
  return flagValue(args, "--cloud-url")
    ?? process.env["OSSTACK_KNOWLEDGE_URL"]
    ?? config.cloud_url;
}

function resolveKnowledgeAuthToken(args: string[], config: KnowledgeCloudConfig): string | undefined {
  return flagValue(args, "--token")
    ?? process.env["OSSTACK_KNOWLEDGE_TOKEN"]
    ?? config.token;
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
      const family = flagValue(args, "--family");
      const lessons = listPitfallLessons(db, {
        ...(family !== undefined ? { family } : {}),
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

type LoopGovernanceMode = "warn" | "strict";

type LoopGovernanceEvidence = GovernanceProofEvidence & {
  mode: LoopGovernanceMode;
  blocking: boolean;
  error_findings: number;
};

type KnowledgeProofEvidence = KnowledgeSearchEvidence;

function knowledgeSearchOptions(options: {
  mode: KnowledgeMode | undefined;
  query: string;
  packs: Parameters<typeof resolveKnowledgeSearch>[0]["packs"];
  limit: number;
  cloudUrl: string | undefined;
  authToken?: string;
  tenantId?: string;
}): Parameters<typeof resolveKnowledgeSearch>[0] {
  return {
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    query: options.query,
    ...(options.packs !== undefined ? { packs: options.packs } : {}),
    limit: options.limit,
    ...(options.cloudUrl !== undefined ? { cloudUrl: options.cloudUrl } : {}),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  };
}

function knowledgeErrorMode(mode: KnowledgeMode | undefined): "local" | "cloud" {
  return mode === "cloud" ? "cloud" : "local";
}

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

  osstack report [run_id] [--loop loop_id] [--workspace P] [--state P] [--events P] [--lang en|zh-CN]

Options:
  --loop ID           State-file loop id / artifact id when no persisted run_id is used
  --workspace P       Workspace containing LOOP-STATE.json (default: cwd)
  --state P           JSON state path (default: LOOP-STATE.json)
  --events P          Optional loop events JSONL path for timeline evidence
  --lang L            Report language: en or zh-CN (default: OSSTACK_LANG or en)
`);
    return 0;
  }

  const runId = firstPositionalValue(args, new Set(["--loop", "--workspace", "--state", "--events", "--lang"]));
  const loopId = flagValue(args, "--loop");
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const language = resolveLanguage(flagValue(args, "--lang"));
  const evidenceResult = runId === undefined
    ? undefined
    : await readPersistedLoopRunEvidence(runId);
  if (evidenceResult instanceof Error) {
    console.error(`osstack: ${evidenceResult.message}`);
    return 1;
  }
  const stateFilePath = evidenceResult?.state_json
    ?? resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  let state: LoopState | null;
  try {
    state = await readLoopState(stateFilePath);
  } catch (error) {
    console.error(`osstack: invalid loop state at ${stateFilePath}: ${errorMessage(error)}`);
    return 1;
  }
  if (state === null) {
    console.error(`osstack: no loop state found at ${stateFilePath}`);
    return 1;
  }
  if (loopId !== undefined && state.loop_id !== loopId) {
    console.error(`osstack: --loop ${loopId} does not match state loop_id=${state.loop_id}`);
    return 1;
  }
  const events = evidenceResult?.events ?? await readLoopEventsJsonlFlag(args, workspacePath);
  console.log(renderReportMarkdownForArtifacts(state, events, language));
  return 0;
}

async function handleScorecardCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack scorecard — loop evidence scorecard

  osstack scorecard [run_id] [--loop loop_id] [--workspace P] [--state P] [--output-dir P] [--stdout] [--lang en|zh-CN]

Options:
  --loop ID           State-file loop id / artifact id when no persisted run_id is used
  --workspace P       Workspace containing LOOP-STATE.json (default: cwd)
  --state P           JSON state path (default: LOOP-STATE.json)
  --output-dir P      Directory for scorecard files (default: <workspace>/release)
  --stdout            Print Markdown instead of writing files
  --lang L            Scorecard language: en or zh-CN (default: OSSTACK_LANG or en)
`);
    return 0;
  }

  const runId = firstPositionalValue(args, new Set(["--loop", "--workspace", "--state", "--output-dir", "--lang"]));
  const loopId = flagValue(args, "--loop");
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const language = resolveLanguage(flagValue(args, "--lang"));
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
  if (loopId !== undefined && state.loop_id !== loopId) {
    console.error(`osstack: --loop ${loopId} does not match state loop_id=${state.loop_id}`);
    return 1;
  }

  const scorecard = createLoopStateScorecardFromState(state);
  const markdown = renderLoopStateScorecardMarkdown(scorecard, { language });
  if (args.includes("--stdout")) {
    console.log(markdown);
    return 0;
  }

  const outputDir = resolveLoopPath(flagValue(args, "--output-dir") ?? "release", workspacePath);
  const baseName = `osstack-scorecard-${safeFileSegment(runId ?? loopId ?? scorecard.loop_id)}`;
  const markdownPath = join(outputDir, `${baseName}.md`);
  const htmlPath = join(outputDir, `${baseName}.html`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(markdownPath, markdown, "utf-8");
  await writeFile(htmlPath, renderLoopStateScorecardHtml(scorecard, { language }), "utf-8");
  console.log(`markdown=${markdownPath}`);
  console.log(`html=${htmlPath}`);
  console.log(`score=${scorecard.total_score}/${scorecard.max_score}`);
  return 0;
}

async function handleProofCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack proof — local evidence proof pack

  osstack proof [run_id] [--loop loop_id] [--workspace P] [--state P] [--events P] [--knowledge-pack P] [--knowledge-mode M] [--knowledge-cloud-url URL] [--knowledge-query Q] [--compliance-pack P] [--output-dir P] [--json]
  osstack proof validate <run_id> [--proof-dir P] [--workspace P] [--pack P] [--audience engineer|manager|auditor|customer] [--json]
  osstack proof view <run_id> --audience engineer|manager|auditor|customer [--proof-dir P] [--workspace P] [--output P] [--lang en|zh-CN] [--json]

Options:
  --loop ID           State-file loop id / artifact id when no persisted run_id is used
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
  --pack P            Validate against a compliance mapping pack
  --lang L            Proof view language: en or zh-CN (default: OSSTACK_LANG or en)
  --json              Print machine-readable summary
`);
    return 0;
  }

  if (args[0] === "view") {
    return await handleProofViewCommand(args.slice(1));
  }
  if (args[0] === "validate") {
    return await handleProofValidateCommand(args.slice(1));
  }

  const runId = firstPositionalValue(args, new Set([
    "--loop",
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
  const loopId = flagValue(args, "--loop");
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
  if (loopId !== undefined && state.loop_id !== loopId) {
    console.error(`osstack: --loop ${loopId} does not match state loop_id=${state.loop_id}`);
    return 1;
  }

  const outputDir = resolveLoopPath(flagValue(args, "--output-dir") ?? "release", workspacePath);
  let events: LoopEvent[];
  try {
    events = evidenceResult?.events ?? await readLoopEventsJsonlFlag(args, workspacePath);
  } catch (error) {
    console.error(`osstack: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const governanceRoot = dirname(stateFilePath);
  const governance = await scanWorkspaceGovernance(governanceRoot);
  const knowledge = await createKnowledgeProofEvidence(args, state.loop_id);
  let proof: Awaited<ReturnType<typeof writeProofPack>>;
  try {
    proof = await writeProofPack(state, outputDir, events, runId ?? loopId, governance, knowledge, flagValues(args, "--compliance-pack"), workspacePath);
  } catch (error) {
    console.error(`osstack: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const summary = {
    loop_id: state.loop_id,
    proof_dir: proof.proof_dir,
    proof_zip: proof.proof_zip,
    manifest: proof.proof_manifest,
    artifact_count: proof.artifact_count,
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`proof=${summary.proof_dir}`);
    console.log(`proof_zip=${summary.proof_zip}`);
    console.log(`manifest=${summary.manifest}`);
    console.log(`artifacts=${summary.artifact_count}`);
  }
  return 0;
}

async function handleProofValidateCommand(args: string[]): Promise<number> {
  const runId = firstPositionalValue(args, new Set(["--proof-dir", "--workspace", "--pack", "--audience", "--lang"]));
  if (runId === undefined) {
    console.error("osstack: proof validate requires a run_id");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const proofDir = flagValue(args, "--proof-dir") ?? join(workspacePath, "release", `osstack-proof-${safeFileSegment(runId)}`);
  const audience = parseProofAudience(flagValue(args, "--audience"));
  if (flagValue(args, "--audience") !== undefined && audience === undefined) {
    console.error("osstack: proof validate requires --audience engineer|manager|auditor|customer");
    return 1;
  }
  const packId = flagValue(args, "--pack");
  const language = resolveLanguage(flagValue(args, "--lang"));
  try {
    const evidence = await loadProofEvidence(proofDir);
    const validation = validateProofEvidence({
      evidence,
      ...(packId === undefined ? {} : { packId }),
      ...(audience === undefined ? {} : { audience }),
      language,
    });
    const fileIntegrity = await validateProofFileIntegrity(proofDir, evidence.manifest);
    const archiveIntegrity = await validateProofArchiveIntegrity(proofDir, evidence.manifest);
    const ok = validation.ok && fileIntegrity.ok && archiveIntegrity.ok;
    const summary = {
      run_id: runId,
      proof_dir: proofDir,
      ...validation,
      file_integrity: fileIntegrity,
      archive_integrity: archiveIntegrity,
      ok,
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`proof_validation=${ok ? "pass" : "fail"}`);
      console.log(`scope=${validation.scope}`);
      console.log(`present=${validation.present.length}`);
      console.log(`missing=${validation.missing.length}`);
      console.log(`file_integrity=${fileIntegrity.ok ? "pass" : "fail"}`);
      console.log(`archive_integrity=${archiveIntegrity.ok ? "pass" : "fail"}`);
      for (const missing of validation.missing) {
        console.log(`missing ${missing.control_id} ${missing.evidence_path}`);
      }
      for (const issue of fileIntegrity.issues) {
        console.log(`integrity ${issue.code} ${issue.path}`);
      }
      for (const issue of archiveIntegrity.issues) {
        console.log(`archive ${issue.code} ${issue.path}`);
      }
    }
    return ok ? 0 : 1;
  } catch (error) {
    console.error(`osstack: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function handleProofViewCommand(args: string[]): Promise<number> {
  const runId = firstPositionalValue(args, new Set(["--audience", "--proof-dir", "--workspace", "--output", "--lang"]));
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
  const language = resolveLanguage(flagValue(args, "--lang"));
  const markdown = await renderProofViewFromProofDir({ audience, runId, proofDir, language });
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

async function handleServeManagementCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`osstack serve — daemon foreground runner and launchd installer

Usage:
  osstack serve
  osstack serve --install [--bin PATH] [--no-load] [--json]
  osstack serve --status [--json]
  osstack serve --uninstall [--no-load] [--json]

Options:
  --install       Write ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist and load it with launchctl
  --uninstall     Boot out the LaunchAgent and remove its plist
  --status        Show plist/launchd status
  --bin PATH      osstack binary path to put in the plist
  --no-load       Only write/remove plist; skip launchctl calls
  --json          Print machine-readable output
`);
    return 0;
  }

  const json = args.includes("--json");
  const noLoad = args.includes("--no-load");
  const binPath = flagValue(args, "--bin") ?? defaultOsstackBinPath();
  try {
    if (args.includes("--install")) {
      const result = await installLaunchAgent({ binPath, noLoad });
      printServeLaunchdResult(result, json);
      return 0;
    }
    if (args.includes("--uninstall")) {
      const result = await uninstallLaunchAgent({ noLoad });
      printServeLaunchdResult(result, json);
      return 0;
    }
    if (args.includes("--status")) {
      const result = await readLaunchAgentStatus({ noLoad });
      printServeLaunchdResult(result, json);
      return 0;
    }
  } catch (error) {
    console.error(`osstack: ${errorMessage(error)}`);
    return 1;
  }

  console.error("osstack: serve management requires --install, --uninstall, or --status");
  return 1;
}

async function installLaunchAgent(options: { binPath: string; noLoad: boolean }): Promise<ServeLaunchdInstallResult> {
  const plistPath = launchAgentPlistPath();
  const logDir = logsDir();
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(osstackHome(), { recursive: true });
  const plist = renderLaunchAgentPlist({
    binPath: options.binPath,
    home: osstackHome(),
    socketPath: resolveSocketPath(),
    stdoutPath: join(logDir, "daemon.log"),
    stderrPath: join(logDir, "daemon.error.log"),
  });
  await writeFile(plistPath, plist, "utf-8");

  let loaded = false;
  if (!options.noLoad) {
    ensureLaunchdSupported();
    await launchctl(["bootstrap", launchdDomain(), plistPath]);
    await launchctl(["kickstart", "-k", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
    loaded = await isLaunchAgentLoaded();
  }

  return {
    label: LAUNCHD_LABEL,
    plist_path: plistPath,
    installed: true,
    loaded,
    load_skipped: options.noLoad,
    socket_path: resolveSocketPath(),
    home: osstackHome(),
    logs_dir: logDir,
  };
}

async function uninstallLaunchAgent(options: { noLoad: boolean }): Promise<ServeLaunchdUninstallResult> {
  const plistPath = launchAgentPlistPath();
  const wasInstalled = await fileExists(plistPath);
  let unloaded = false;
  if (!options.noLoad && process.platform === "darwin") {
    const bootout = await launchctl(["bootout", launchdDomain(), plistPath], { allowFailure: true });
    unloaded = bootout.ok;
  }
  if (wasInstalled) await rm(plistPath, { force: true });
  return {
    label: LAUNCHD_LABEL,
    plist_path: plistPath,
    installed: false,
    loaded: false,
    unloaded,
    socket_path: resolveSocketPath(),
  };
}

async function readLaunchAgentStatus(options: { noLoad: boolean } = { noLoad: false }): Promise<ServeLaunchdStatus> {
  const plistPath = launchAgentPlistPath();
  return {
    label: LAUNCHD_LABEL,
    plist_path: plistPath,
    installed: await fileExists(plistPath),
    loaded: options.noLoad ? false : await isLaunchAgentLoaded(),
    socket_path: resolveSocketPath(),
  };
}

function printServeLaunchdResult(result: ServeLaunchdStatus | ServeLaunchdInstallResult | ServeLaunchdUninstallResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`label=${result.label}`);
  console.log(`plist=${result.plist_path}`);
  console.log(`installed=${result.installed}`);
  console.log(`loaded=${result.loaded}`);
  console.log(`socket=${result.socket_path}`);
  if ("load_skipped" in result) console.log(`load_skipped=${result.load_skipped}`);
  if ("unloaded" in result) console.log(`unloaded=${result.unloaded}`);
}

function renderLaunchAgentPlist(options: {
  binPath: string;
  home: string;
  socketPath: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const args = [
    "/usr/bin/env",
    `OSSTACK_HOME=${options.home}`,
    `OSSTACK_SOCKET=${options.socketPath}`,
    options.binPath,
    "serve",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.stderrPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(process.cwd())}</string>
</dict>
</plist>
`;
}

function launchAgentPlistPath(): string {
  const dir = process.env["OSSTACK_LAUNCH_AGENTS_DIR"]
    ?? join(process.env["HOME"] ?? "", "Library", "LaunchAgents");
  return join(dir, `${LAUNCHD_LABEL}.plist`);
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function ensureLaunchdSupported(): void {
  if (process.platform !== "darwin") {
    throw new Error("launchd install is only supported on macOS; use `osstack serve` directly on this platform.");
  }
}

async function launchctl(args: string[], options: { allowFailure?: boolean } = {}): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, { timeout: 15_000 });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    if (options.allowFailure === true) return { ok: false, output: errorMessage(error) };
    throw new Error(`launchctl ${args.join(" ")} failed: ${errorMessage(error)}`);
  }
}

async function isLaunchAgentLoaded(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const result = await launchctl(["print", `${launchdDomain()}/${LAUNCHD_LABEL}`], { allowFailure: true });
  return result.ok;
}

function defaultOsstackBinPath(): string {
  return process.env["OSSTACK_CLI"] ?? process.argv[1] ?? "osstack";
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
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
  governance?: GovernanceProofEvidence;
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
    options.governance,
  );
}

async function writeRequestedLoopArtifacts(
  state: LoopState,
  workspacePath: string,
  args: string[],
  events: LoopEvent[] = [],
  governanceOverride?: GovernanceProofEvidence,
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
    const language = resolveLanguage(flagValue(args, "--lang"));
    await writeFile(markdownPath, renderLoopStateScorecardMarkdown(scorecard, { language }), "utf-8");
    await writeFile(htmlPath, renderLoopStateScorecardHtml(scorecard, { language }), "utf-8");
    artifacts.scorecard_markdown = markdownPath;
    artifacts.scorecard_html = htmlPath;
  }

  if (args.includes("--proof")) {
    const governance = governanceOverride ?? await scanWorkspaceGovernance(workspacePath);
    const knowledge = await createKnowledgeProofEvidence(args, state.loop_id, state.knowledge);
    const proof = await writeProofPack(state, join(workspacePath, "release"), events, state.loop_id, governance, knowledge, [], workspacePath);
    artifacts.proof_dir = proof.proof_dir;
    artifacts.proof_zip = proof.proof_zip;
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
  workspacePath?: string,
): Promise<{
  proof_dir: string;
  proof_zip: string;
  proof_manifest: string;
  artifact_count: number;
}> {
  const proofDir = join(outputDir, `osstack-proof-${safeFileSegment(artifactId)}`);
  const scorecard = createLoopStateScorecardFromState(state);
  const policyDecision = createPolicyDecisionEvidence(events);
  const agentRuntime = createAgentRuntimeEvidence(events);
  const verifyResults = createVerifyResultsEvidence(scorecard, events);
  const worktreeStatus = createWorktreeStatusEvidence(events);
  validateProofEvidenceArtifacts({ policyDecision, agentRuntime, verifyResults, worktreeStatus });
  const artifacts = [
    { path: "report.md", content: renderReportMarkdownForArtifacts(state, events) },
    { path: "scorecard.md", content: renderLoopStateScorecardMarkdown(scorecard, { language: resolveLanguage() }) },
    { path: "scorecard.html", content: renderLoopStateScorecardHtml(scorecard, { language: resolveLanguage() }) },
    { path: "loop-state.json", content: `${JSON.stringify(state, null, 2)}\n` },
    { path: "events.jsonl", content: events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "") },
    { path: "policy-decision.json", content: `${JSON.stringify(policyDecision, null, 2)}\n` },
    { path: "agent-runtime.json", content: `${JSON.stringify(agentRuntime, null, 2)}\n` },
    { path: "verify-results.json", content: `${JSON.stringify(verifyResults, null, 2)}\n` },
    { path: "worktree-status.json", content: `${JSON.stringify(worktreeStatus, null, 2)}\n` },
    { path: "governance-results.json", content: `${JSON.stringify(governance, null, 2)}\n` },
    { path: "knowledge-results.json", content: `${JSON.stringify(knowledge, null, 2)}\n` },
    { path: "logs/events.log", content: renderProofEventsLog(events) },
  ];
  artifacts.push(...createVerifierOutputArtifacts(verifyResults));
  if (workspacePath !== undefined) {
    artifacts.push(await createGitDiffProofArtifact(workspacePath));
  }
  const complianceReports: Array<{ pack_id: string; path: string; certification_claim: "none" }> = [];
  for (const packId of compliancePackIds) {
    const path = `compliance-${safeFileSegment(packId)}.md`;
    complianceReports.push({ pack_id: packId, path, certification_claim: "none" });
    artifacts.push({
      path,
      content: renderComplianceReport({
        packId,
        runId: artifactId,
        evidence: {
          manifest: { artifacts: artifacts.map((artifact) => ({ path: artifact.path, sha256: sha256(artifact.content) })) },
          verify: verifyResults,
          policy: policyDecision,
          agent_runtime: agentRuntime,
          governance,
          worktree: worktreeStatus,
          knowledge,
        },
      }),
    });
  }

  await mkdir(proofDir, { recursive: true });
  const manifestArtifacts: Array<{ path: string; sha256: string; bytes: number }> = [];
  const redactor = new PIIRedactor();
  for (const artifact of artifacts) {
    const artifactPath = join(proofDir, artifact.path);
    const content = redactor.redact(artifact.content).text;
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, content, "utf-8");
    manifestArtifacts.push({
      path: artifact.path,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf-8"),
    });
  }
  const sha256sumsContent = renderSha256Sums(manifestArtifacts);
  await writeFile(join(proofDir, "sha256sums.txt"), sha256sumsContent, "utf-8");
  manifestArtifacts.push({
    path: "sha256sums.txt",
    sha256: sha256(sha256sumsContent),
    bytes: Buffer.byteLength(sha256sumsContent, "utf-8"),
  });

  const createdAt = new Date().toISOString();
  const manifest = {
    schema_version: 1,
    kind: "osstack.proof_pack",
    osstack_version: VERSION,
    run_id: artifactId,
    loop_id: state.loop_id,
    agent_id: primaryAgentId(state),
    agent_ids: proofAgentIds(state),
    ...(workspacePath !== undefined ? { workspace: workspacePath } : {}),
    generated_from: "LOOP-STATE.json",
    created_at: createdAt,
    generated_at: createdAt,
    ...(complianceReports.length === 0 ? {} : { compliance_reports: complianceReports }),
    artifacts: manifestArtifacts,
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const proofManifest = join(proofDir, "manifest.json");
  await writeFile(proofManifest, manifestContent, "utf-8");
  const proofZip = `${proofDir}.zip`;
  await writeProofZip(proofDir, proofZip, [...manifestArtifacts.map((artifact) => artifact.path), "manifest.json"]);
  return {
    proof_dir: proofDir,
    proof_zip: proofZip,
    proof_manifest: proofManifest,
    artifact_count: manifestArtifacts.length + 1,
  };
}

function primaryAgentId(state: LoopState): string {
  return proofAgentIds(state)[0] ?? "unknown";
}

function proofAgentIds(state: LoopState): string[] {
  return [...new Set(state.completed_tasks.map((task) => task.agent_id).filter((agentId) => agentId.length > 0))];
}

function renderSha256Sums(artifacts: Array<{ path: string; sha256: string }>): string {
  return artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n";
}

async function writeProofZip(proofDir: string, zipPath: string, paths: string[]): Promise<void> {
  const entries: Array<{ path: string; data: Buffer; crc32: number; offset: number }> = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const path of paths) {
    const data = await readFile(join(proofDir, path));
    const name = Buffer.from(path.replaceAll("\\", "/"), "utf-8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, data);
    entries.push({ path, data, crc32: crc, offset });
    offset += header.length + name.length + data.length;
  }

  const centralDirectoryOffset = offset;
  for (const entry of entries) {
    const name = Buffer.from(entry.path.replaceAll("\\", "/"), "utf-8");
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, name);
    offset += header.length + name.length;
  }
  const centralDirectorySize = offset - centralDirectoryOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);
  await writeFile(zipPath, Buffer.concat(chunks));
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

async function createGitDiffProofArtifact(workspacePath: string): Promise<{ path: string; content: string }> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "diff",
      "--no-ext-diff",
      "--binary",
      "HEAD",
      "--",
    ], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 });
    const redacted = new PIIRedactor().redact(stdout).text;
    return {
      path: "git-diff.patch",
      content: redacted.length === 0
        ? "# Git Diff Evidence\n\nNo tracked git diff was present when this proof pack was generated.\n"
        : redacted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: "git-diff.patch",
      content: `# Git Diff Evidence\n\nGit diff evidence unavailable: ${message}\n`,
    };
  }
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

function parseLoopGovernanceMode(args: string[]): LoopGovernanceMode | undefined | Error {
  const index = args.indexOf("--govern");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return "warn";
  if (value === "warn" || value === "strict") return value;
  return new Error("--govern must be warn or strict");
}

async function createLoopGovernanceEvidence(
  mode: LoopGovernanceMode,
  workspacePath: string,
): Promise<LoopGovernanceEvidence> {
  const evidence = await scanWorkspaceGovernance(workspacePath);
  const errorFindings = evidence.findings.filter((finding) => finding.severity === "error").length;
  return {
    ...evidence,
    mode,
    blocking: mode === "strict" && errorFindings > 0,
    error_findings: errorFindings,
  };
}

function appendGovernanceVerifyEvent(
  events: LoopEvent[],
  loopId: string,
  governance: LoopGovernanceEvidence,
): LoopEvent[] {
  const seq = nextLoopEventSeq(events);
  const pass = !governance.blocking;
  const summary = governance.status === "unknown"
    ? "governance scan unknown; fail-open"
    : `${governance.status}; findings=${governance.findings.length}; errors=${governance.error_findings}; mode=${governance.mode}`;
  return [
    ...events,
    {
      event_id: `evt_governance_${seq}`,
      loop_id: loopId,
      type: "loop.verify.done",
      seq,
      created_at: Date.now(),
      payload: {
        task_id: "governance",
        pass,
        score: pass ? 1 : 0,
        issue_count: governance.findings.length,
        reviewer_agent_id: "governance-verifier",
        summary,
      },
    },
  ];
}

function nextLoopEventSeq(events: LoopEvent[]): number {
  return Math.max(0, ...events.map((event) => event.seq)) + 1;
}

async function collectGovernanceScanFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  await collectGovernanceScanFilesInto(workspacePath, files);
  return files;
}

async function collectChangedGovernanceScanFiles(workspacePath: string): Promise<string[] | Error> {
  try {
    const [workingTree, staged] = await Promise.all([
      execFileAsync("git", ["-C", workspacePath, "ls-files", "--modified", "--others", "--exclude-standard"], { timeout: 10_000 }),
      execFileAsync("git", ["-C", workspacePath, "diff", "--name-only", "--cached", "--diff-filter=ACMRT"], { timeout: 10_000 }),
    ]);
    const relativePaths = uniqueNonEmptyLines(`${workingTree.stdout}\n${staged.stdout}`);
    const files: string[] = [];
    for (const relativePath of relativePaths) {
      if (!isGovernanceScannableFile(relativePath)) continue;
      const absolutePath = join(workspacePath, relativePath);
      if (await isRegularFile(absolutePath)) files.push(absolutePath);
    }
    return files;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`could not collect changed files with git: ${message}`);
  }
}

function uniqueNonEmptyLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))];
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
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
    `- ${decision.task_id}: ${decision.agent_id} [${decision.auth_mode}; roles=${decision.roles.join(",") || "unknown"}] - ${decision.reason} (scorecard: \`osstack agent scorecard ${decision.agent_id}\`)`
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

async function createKnowledgeProofEvidence(
  args: string[],
  defaultQuery: string,
  fallback?: LoopKnowledgeTrace,
): Promise<KnowledgeProofEvidence> {
  const packPaths = flagValues(args, "--knowledge-pack");
  const modeValue = flagValue(args, "--knowledge-mode") ?? flagValue(args, "--knowledge");
  const mode = parseKnowledgeMode(modeValue);
  const knowledgeConfig = await readKnowledgeCloudConfig(knowledgeCacheDir(args));
  const cloudUrl = flagValue(args, "--knowledge-cloud-url") ?? resolveKnowledgeCloudUrl(args, knowledgeConfig);
  const authToken = resolveKnowledgeAuthToken(args, knowledgeConfig);
  if (modeValue !== undefined && mode === undefined) {
    return {
      mode: "off",
      status: "not_used",
      reason: "--knowledge-mode must be one of off, local, cloud",
      packs: [],
      results: [],
    };
  }
  if (!hasKnowledgeRequest(args) && fallback !== undefined) return knowledgeProofFromTrace(fallback);
  if (packPaths.length === 0 && cloudUrl === undefined && mode !== "cloud") return offKnowledgeEvidence();
  const query = flagValue(args, "--knowledge-query") ?? defaultQuery;
  try {
    const packs = await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath)));
    return await resolveKnowledgeSearch(knowledgeSearchOptions({
      mode,
      query,
      packs,
      limit: 5,
      cloudUrl,
      ...(authToken === undefined ? {} : { authToken }),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: knowledgeErrorMode(mode),
      status: "error",
      query,
      reason: message,
      packs: [],
      results: [],
    };
  }
}

function hasKnowledgeRequest(args: string[]): boolean {
  return args.includes("--knowledge")
    || args.includes("--knowledge-mode")
    || args.includes("--knowledge-pack")
    || args.includes("--knowledge-cloud-url")
    || args.includes("--knowledge-query");
}

function shouldRecordLoopKnowledge(args: string[], evidence: KnowledgeProofEvidence): boolean {
  return hasKnowledgeRequest(args) || evidence.mode !== "off" || evidence.status !== "not_used";
}

function offKnowledgeEvidence(): KnowledgeProofEvidence {
  return {
    mode: "off",
    status: "not_used",
    packs: [],
    results: [],
  };
}

function knowledgeProofFromTrace(trace: LoopKnowledgeTrace): KnowledgeProofEvidence {
  if (trace.status === "recorded" && trace.mode !== "off") {
    return {
      mode: trace.mode,
      status: "recorded",
      query: trace.query ?? "",
      packs: trace.packs,
      results: trace.results.map((result) => ({ ...result, matched_terms: result.matched_terms ?? [] })),
      ...(trace.reason !== undefined ? { reason: trace.reason } : {}),
      ...(trace.fallback_mode === "local" ? { fallback_mode: trace.fallback_mode } : {}),
    };
  }
  if (trace.status === "error" && trace.mode !== "off") {
    return {
      mode: trace.mode,
      status: "error",
      ...(trace.query !== undefined ? { query: trace.query } : {}),
      reason: trace.reason ?? "knowledge trace recorded an error",
      packs: trace.packs,
      results: [],
      ...(trace.fallback_mode !== undefined ? { fallback_mode: trace.fallback_mode } : {}),
    };
  }
  return {
    mode: "off",
    status: "not_used",
    packs: [],
    results: [],
    ...(trace.query !== undefined ? { query: trace.query } : {}),
    ...(trace.reason !== undefined ? { reason: trace.reason } : {}),
    ...(trace.fallback_mode === "off" ? { fallback_mode: trace.fallback_mode } : {}),
  };
}

function createPolicyDecisionEvidence(events: LoopEvent[]): {
  status: "recorded" | "unknown";
  decisions?: Array<{
    task_id: string;
    agent_id: string;
    auth_mode: string;
    roles: string[];
    reason: string;
    event_seq: number;
  }>;
  reason?: string;
} {
  const decisions = events
    .filter((event) => event.type === "loop.plan.done")
    .map((event) => ({
      task_id: stringEventPayload(event, "task_id"),
      agent_id: stringEventPayload(event, "agent_id"),
      auth_mode: agentAuthMode(stringEventPayload(event, "agent_id")),
      roles: rolesForAgentId(stringEventPayload(event, "agent_id")),
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

function createAgentRuntimeEvidence(events: LoopEvent[]): {
  status: "recorded" | "unknown";
  agents?: Array<{
    agent_id: string;
    auth_mode: string;
    roles: string[];
    plan_event_seqs: number[];
  }>;
  reason?: string;
} {
  const byAgent = new Map<string, number[]>();
  for (const event of events) {
    if (event.type !== "loop.plan.done") continue;
    const agentId = stringEventPayload(event, "agent_id");
    byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), event.seq]);
  }
  if (byAgent.size === 0) {
    return {
      status: "unknown",
      reason: "No loop.plan.done event evidence found.",
    };
  }
  return {
    status: "recorded",
    agents: [...byAgent.entries()].map(([agentId, seqs]) => ({
      agent_id: agentId,
      auth_mode: agentAuthMode(agentId),
      roles: rolesForAgentId(agentId),
      plan_event_seqs: seqs,
    })),
  };
}

function rolesForAgentId(agentId: string): string[] {
  if (agentId === "local-command") return ["coding", "test-verify", "release/proof"];
  const adapter = defaultAdapters().find((candidate) => candidate.id === agentId);
  return rolesForCapabilityKinds(adapter?.capabilities().map((capability) => capability.kind) ?? []);
}

function createVerifierOutputArtifacts(verifyResults: ReturnType<typeof createVerifyResultsEvidence>): Array<{ path: string; content: string }> {
  if (verifyResults.results === undefined) return [];
  return verifyResults.results.map((result) => {
    const agentId = result.reviewer_agent_id === "" ? "unknown-verifier" : result.reviewer_agent_id;
    const dir = verifierOutputDir(agentId);
    const path = `${dir}/${safeFileSegment(result.task_id)}-${safeFileSegment(agentId)}.txt`;
    const content = [
      `task_id: ${result.task_id}`,
      `reviewer_agent_id: ${agentId}`,
      `pass: ${result.pass ? "true" : "false"}`,
      `score: ${String(result.score)}`,
      `event_seq: ${result.event_seq}`,
      "",
      result.summary,
      "",
    ].join("\n");
    return { path, content: new PIIRedactor().redact(content).text };
  });
}

function verifierOutputDir(agentId: string): "checker-output" | "reviewer-output" {
  const normalized = agentId.toLowerCase();
  return normalized.includes("checker") || normalized.includes("verify") || normalized.includes("verifier")
    ? "checker-output"
    : "reviewer-output";
}

function renderProofEventsLog(events: LoopEvent[]): string {
  const lines = events.map((event) => `${event.seq} ${event.type} ${proofEventSummary(event)}`);
  const content = lines.length === 0
    ? "No loop events were provided for this proof pack.\n"
    : `${lines.join("\n")}\n`;
  return new PIIRedactor().redact(content).text;
}

function proofEventSummary(event: LoopEvent): string {
  if (event.type === "loop.verify.done") {
    const taskId = stringEventPayload(event, "task_id");
    const pass = booleanEventPayload(event, "pass") ? "passed" : "failed";
    return `${taskId} verify ${pass}: ${stringEventPayload(event, "summary")}`;
  }
  if (event.type === "loop.plan.done") {
    return `${stringEventPayload(event, "task_id")} planned for ${stringEventPayload(event, "agent_id")}: ${stringEventPayload(event, "routing_reason")}`;
  }
  if (event.type.startsWith("loop.worktree.")) {
    return `${stringEventPayload(event, "task_id")} ${event.type.replace("loop.worktree.", "worktree ")} ${stringEventPayload(event, "branch")}`;
  }
  return stringEventPayload(event, "summary");
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
  const results: Array<{
    task_id: string;
    pass: boolean;
    score: number | "unknown";
    reviewer_agent_id: string;
    summary: string;
    event_seq: number;
  }> = events
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
      path: firstStringEventPayload(event, ["path", "worktree_path"]),
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

function validateProofEvidenceArtifacts(evidence: {
  policyDecision: ReturnType<typeof createPolicyDecisionEvidence>;
  agentRuntime: ReturnType<typeof createAgentRuntimeEvidence>;
  verifyResults: ReturnType<typeof createVerifyResultsEvidence>;
  worktreeStatus: ReturnType<typeof createWorktreeStatusEvidence>;
}): void {
  const errors = [
    ...validatePolicyDecisionEvidence(evidence.policyDecision),
    ...validateAgentRuntimeEvidence(evidence.agentRuntime),
    ...validateVerifyResultsEvidence(evidence.verifyResults),
    ...validateWorktreeStatusEvidence(evidence.worktreeStatus),
  ];
  if (errors.length > 0) {
    throw new Error(`proof evidence validation failed: ${errors.join("; ")}`);
  }
}

function validatePolicyDecisionEvidence(value: ReturnType<typeof createPolicyDecisionEvidence>): string[] {
  const errors: string[] = [];
  if (value.status !== "recorded" && value.status !== "unknown") {
    errors.push("policy-decision.status must be recorded or unknown");
  }
  if (value.status === "recorded") {
    if (!Array.isArray(value.decisions) || value.decisions.length === 0) {
      errors.push("policy-decision.decisions must contain at least one decision when status is recorded");
    } else {
      value.decisions.forEach((decision, index) => {
        if (decision.task_id.length === 0 || decision.task_id === "unknown") {
          errors.push(`policy-decision.decisions[${index}].task_id is required`);
        }
        if (decision.agent_id.length === 0 || decision.agent_id === "unknown") {
          errors.push(`policy-decision.decisions[${index}].agent_id is required`);
        }
        if (decision.auth_mode.length === 0) {
          errors.push(`policy-decision.decisions[${index}].auth_mode is required`);
        }
        if (!Array.isArray(decision.roles)) {
          errors.push(`policy-decision.decisions[${index}].roles must be an array`);
        }
        if (decision.reason.length === 0 || decision.reason === "unknown") {
          errors.push(`policy-decision.decisions[${index}].reason is required`);
        }
        if (!Number.isInteger(decision.event_seq) || decision.event_seq < 0) {
          errors.push(`policy-decision.decisions[${index}].event_seq must be a non-negative integer`);
        }
      });
    }
  }
  if (value.status === "unknown" && (value.reason === undefined || value.reason.length === 0)) {
    errors.push("policy-decision.reason is required when status is unknown");
  }
  return errors;
}

function validateAgentRuntimeEvidence(value: ReturnType<typeof createAgentRuntimeEvidence>): string[] {
  const errors: string[] = [];
  if (value.status !== "recorded" && value.status !== "unknown") {
    errors.push("agent-runtime.status must be recorded or unknown");
  }
  if (value.status === "recorded") {
    if (!Array.isArray(value.agents) || value.agents.length === 0) {
      errors.push("agent-runtime.agents must contain at least one agent when status is recorded");
    } else {
      value.agents.forEach((agent, index) => {
        if (agent.agent_id.length === 0) errors.push(`agent-runtime.agents[${index}].agent_id is required`);
        if (agent.auth_mode.length === 0) errors.push(`agent-runtime.agents[${index}].auth_mode is required`);
        if (!Array.isArray(agent.roles)) errors.push(`agent-runtime.agents[${index}].roles must be an array`);
        if (!Array.isArray(agent.plan_event_seqs)) {
          errors.push(`agent-runtime.agents[${index}].plan_event_seqs must be an array`);
        } else if (agent.plan_event_seqs.some((seq) => !Number.isInteger(seq) || seq < 0)) {
          errors.push(`agent-runtime.agents[${index}].plan_event_seqs must contain non-negative integers`);
        }
      });
    }
  }
  if (value.status === "unknown" && (value.reason === undefined || value.reason.length === 0)) {
    errors.push("agent-runtime.reason is required when status is unknown");
  }
  return errors;
}

function validateVerifyResultsEvidence(value: ReturnType<typeof createVerifyResultsEvidence>): string[] {
  const errors: string[] = [];
  if (value.status !== "pass" && value.status !== "fail" && value.status !== "unknown") {
    errors.push("verify-results.status must be pass, fail, or unknown");
  }
  if (value.results !== undefined) {
    value.results.forEach((result, index) => {
      if (result.task_id.length === 0 || result.task_id === "unknown") {
        errors.push(`verify-results.results[${index}].task_id is required`);
      }
      if (typeof result.pass !== "boolean") errors.push(`verify-results.results[${index}].pass must be boolean`);
      if (result.score !== "unknown" && typeof result.score !== "number") {
        errors.push(`verify-results.results[${index}].score must be number or unknown`);
      }
      if (result.reviewer_agent_id.length === 0 || result.reviewer_agent_id === "unknown") {
        errors.push(`verify-results.results[${index}].reviewer_agent_id is required`);
      }
      if (result.summary.length === 0 || result.summary === "unknown") {
        errors.push(`verify-results.results[${index}].summary is required`);
      }
      if (!Number.isInteger(result.event_seq) || result.event_seq < 0) {
        errors.push(`verify-results.results[${index}].event_seq must be a non-negative integer`);
      }
    });
  }
  if (value.results === undefined && (value.reason === undefined || value.reason.length === 0)) {
    errors.push("verify-results.reason is required when no results are recorded");
  }
  return errors;
}

function validateWorktreeStatusEvidence(value: ReturnType<typeof createWorktreeStatusEvidence>): string[] {
  const errors: string[] = [];
  if (value.status !== "recorded" && value.status !== "unknown") {
    errors.push("worktree-status.status must be recorded or unknown");
  }
  if (value.status === "recorded") {
    if (!Array.isArray(value.entries) || value.entries.length === 0) {
      errors.push("worktree-status.entries must contain at least one entry when status is recorded");
    } else {
      value.entries.forEach((entry, index) => {
        if (entry.task_id.length === 0 || entry.task_id === "unknown") {
          errors.push(`worktree-status.entries[${index}].task_id is required`);
        }
        if (!["created", "merged", "cleaned"].includes(entry.status)) {
          errors.push(`worktree-status.entries[${index}].status is invalid`);
        }
        if (entry.branch.length === 0 || entry.branch === "unknown") {
          errors.push(`worktree-status.entries[${index}].branch is required`);
        }
        if (entry.status === "merged" && (entry.commit.length === 0 || entry.commit === "unknown")) {
          errors.push(`worktree-status.entries[${index}].commit is required for merged worktrees`);
        }
        if (entry.path.length === 0 || entry.path === "unknown") {
          errors.push(`worktree-status.entries[${index}].path is required`);
        }
        if (!Number.isInteger(entry.event_seq) || entry.event_seq < 0) {
          errors.push(`worktree-status.entries[${index}].event_seq must be a non-negative integer`);
        }
      });
    }
  }
  if (value.status === "unknown" && (value.reason === undefined || value.reason.length === 0)) {
    errors.push("worktree-status.reason is required when status is unknown");
  }
  return errors;
}

function stringEventPayload(event: LoopEvent, key: string): string {
  const value = event.payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function firstStringEventPayload(event: LoopEvent, keys: string[]): string {
  for (const key of keys) {
    const value = event.payload?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "unknown";
}

function booleanEventPayload(event: LoopEvent, key: string): boolean {
  const value = event.payload?.[key];
  return typeof value === "boolean" ? value : false;
}

function numberEventPayload(event: LoopEvent, key: string): number | undefined {
  const value = event.payload?.[key];
  return typeof value === "number" ? value : undefined;
}

function renderReportMarkdownForArtifacts(
  state: LoopState,
  events: LoopEvent[],
  language: LoopReportLanguage = resolveLanguage(),
): string {
  return events.length === 0
    ? renderLoopStateReportFromState(state, { language })
    : renderLoopStateReportFromStateAndEvents(state, events, { language });
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
  const errors = validateExternalLoopEvents(parsed);
  if (errors.length > 0) {
    throw new Error(`invalid events JSONL at ${path}: ${errors.join("; ")}`);
  }
  return parsed as LoopEvent[];
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

function validateExternalLoopEvents(events: unknown[]): string[] {
  const errors: string[] = [];
  const seenEventIds = new Set<string>();
  let previousSeq = -1;
  events.forEach((event, index) => {
    if (!isRecord(event)) {
      errors.push(`events[${index}] must be an object`);
      return;
    }
    const allowed = new Set(["event_id", "loop_id", "type", "seq", "created_at", "payload"]);
    for (const key of Object.keys(event)) {
      if (!allowed.has(key)) errors.push(`events[${index}].${key} is not allowed`);
    }
    const eventId = event["event_id"];
    if (typeof eventId !== "string" || eventId.length === 0) {
      errors.push(`events[${index}].event_id is required`);
    } else if (seenEventIds.has(eventId)) {
      errors.push(`events[${index}].event_id must be unique`);
    } else {
      seenEventIds.add(eventId);
    }
    if (typeof event["loop_id"] !== "string" || event["loop_id"].length === 0) {
      errors.push(`events[${index}].loop_id is required`);
    }
    if (typeof event["type"] !== "string" || event["type"].length === 0) {
      errors.push(`events[${index}].type is required`);
    }
    const seq = event["seq"];
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      errors.push(`events[${index}].seq must be a non-negative integer`);
    } else {
      if (seq <= previousSeq) {
        errors.push(`events[${index}].seq must be greater than previous event seq ${previousSeq}`);
      }
      previousSeq = seq;
    }
    if (typeof event["created_at"] !== "number" || !Number.isFinite(event["created_at"])) {
      errors.push(`events[${index}].created_at must be a finite number`);
    }
    const payload = event["payload"];
    if (payload !== undefined && !isRecord(payload)) {
      errors.push(`events[${index}].payload must be an object when present`);
    }
  });
  return errors;
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

  osstack deliver "Add billing dashboard" [--workspace P] [--execute CMD] [--verify CMD] [--auto-agent] [--worktree] [--checkpoint] [--govern [warn|strict]] [--json]

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
    "--govern",
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
  const governanceMode = parseLoopGovernanceMode(args);
  if (governanceMode instanceof Error) {
    console.error(`osstack: ${governanceMode.message}`);
    return 1;
  }
  const autoAgent = args.includes("--auto-agent");
  const useWorktree = args.includes("--worktree");
  const checkpoint = args.includes("--checkpoint") && !useWorktree
    ? await createShadowCheckpoint(realpathSync(workspacePath))
    : undefined;
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
  const worktreeRoot = flagValue(args, "--worktree-root");
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
    ...(useWorktree ? { useWorktree: true } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
  });
  const result = await engine.runOnce();
  const artifactArgs = ensureFlags(args, ["--report", "--scorecard", "--proof"]);
  const governance = governanceMode === undefined
    ? undefined
    : await createLoopGovernanceEvidence(governanceMode, workspacePath);
  const events = governance === undefined
    ? result.events
    : appendGovernanceVerifyEvent(result.events, result.loop_id, governance);
  const artifacts = await writeRequestedLoopArtifacts(result.state, workspacePath, artifactArgs, events, governance);
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
    events,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(governance !== undefined ? { governance } : {}),
    ...(learnedLessons !== undefined ? { learned_lessons: learnedLessons } : {}),
    ...(result.state.key_metrics !== undefined ? { metrics: result.state.key_metrics } : {}),
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`deliver=${result.loop_id}`);
    console.log(`task=${task.path}`);
    if (suggestedVerify !== undefined) console.log(`suggested_verify=${suggestedVerify}`);
    if (governance !== undefined) console.log(`governance=${governance.status} mode=${governance.mode} blocking=${governance.blocking ? "yes" : "no"}`);
    if (artifacts?.report !== undefined) console.log(`report=${artifacts.report}`);
    if (artifacts?.proof_dir !== undefined) console.log(`proof=${artifacts.proof_dir}`);
  }
  return result.state.completed_tasks.some((completed) => completed.outcome !== "success") || governance?.blocking === true ? 2 : 0;
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
    const useWorktree = args.includes("--worktree");
    const checkpoint = args.includes("--checkpoint") && !useWorktree
      ? await createShadowCheckpoint(realpathSync(workspacePath))
      : undefined;
    const knowledge = await createKnowledgeProofEvidence(args, "loop run");
    const governanceMode = parseLoopGovernanceMode(args);
    if (governanceMode instanceof Error) {
      console.error(`osstack: ${governanceMode.message}`);
      return 1;
    }
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
        ...(useWorktree ? { useWorktree: true } : {}),
        ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
        ...(shouldRecordLoopKnowledge(args, knowledge) ? { knowledge } : {}),
      }) as RpcResp;
      if (!resp.ok) {
        console.error("osstack:", resp.error?.message ?? "loop.run failed");
        return 1;
      }
      const result = resp.result as LoopRunSummary;
      const governance = governanceMode === undefined
        ? undefined
        : await createLoopGovernanceEvidence(governanceMode, workspacePath);
      const events = governance === undefined
        ? normalizeLoopEvents(result.events)
        : appendGovernanceVerifyEvent(normalizeLoopEvents(result.events), result.loop_id, governance);
      if (events.length > 0) result.events = events;
      if (governance !== undefined) result.governance = governance;
      const artifacts = await writeRequestedLoopArtifactsFromStateFile({
        args,
        workspacePath,
        stateFilePath,
        events,
        ...(governance !== undefined ? { governance } : {}),
      });
      if (artifacts instanceof Error) {
        console.error(`osstack: ${artifacts.message}`);
        return 1;
      }
      if (artifacts !== undefined) result.artifacts = artifacts;
      if (checkpoint !== undefined) result.checkpoint = checkpoint;
      const persistedState = await readLoopState(resolveLoopPath(stateFilePath, workspacePath));
      if (persistedState !== null) {
        const learnedLessons = await learnLessonsFromLoopState(persistedState);
        if (learnedLessons !== undefined) result.learned_lessons = learnedLessons;
      }
      printLoopRun(result, json);
      return result.completed_tasks.some((task) => task.outcome !== "success") || governance?.blocking === true ? 2 : 0;
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
      ...(useWorktree ? { useWorktree: true } : {}),
      ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
      ...(shouldRecordLoopKnowledge(args, knowledge) ? { knowledge } : {}),
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

    const governance = governanceMode === undefined
      ? undefined
      : await createLoopGovernanceEvidence(governanceMode, workspacePath);
    const events = governance === undefined
      ? result.events
      : appendGovernanceVerifyEvent(result.events, result.loop_id, governance);
    const artifacts = await writeRequestedLoopArtifacts(result.state, workspacePath, args, events, governance);
    const learnedLessons = await learnLessonsFromLoopState(result.state);
    printLoopRun({
      loop_id: result.loop_id,
      json_path: result.jsonPath,
      markdown_path: result.markdownPath,
      completed_tasks: result.state.completed_tasks,
      events,
      ...(artifacts !== undefined ? { artifacts } : {}),
      ...(learnedLessons !== undefined ? { learned_lessons: learnedLessons } : {}),
      ...(governance !== undefined ? { governance } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(result.state.key_metrics !== undefined ? { metrics: result.state.key_metrics } : {}),
      ...("cycles" in result ? { cycles: result.cycles.map((cycle) => ({
        discovered_task_count: cycle.discoveredTaskCount,
        executed_task_count: cycle.executedTaskCount,
        skipped_task_count: cycle.skippedTaskCount,
        ...(cycle.goal !== undefined ? { goal: cycle.goal } : {}),
      })) } : {}),
    }, json);
    return result.state.completed_tasks.some((task) => task.outcome !== "success") || governance?.blocking === true ? 2 : 0;
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

  if (sub === "help" || sub === "--help" || sub === "-h") {
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
  --checkpoint       Create a shadow checkpoint before non-worktree runs
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
  --knowledge M       Record knowledge mode: off, local, or cloud
  --knowledge-pack P  Local Osstack knowledge pack for loop trace/retrieval
  --knowledge-cloud-url URL
                      Knowledge Cloud URL; unavailable cloud fails open to local/off
  --knowledge-query Q Query used for knowledge trace search
  --govern [M]        Run governance checks after loop run; M=warn or strict
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

function sha256Buffer(content: Buffer): string {
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
  checkpoint?: ShadowCheckpointSummary;
  governance?: LoopGovernanceEvidence;
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
  proof_zip?: string;
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
  if (result.governance !== undefined) {
    console.log(`governance=${result.governance.status} mode=${result.governance.mode} blocking=${result.governance.blocking ? "yes" : "no"} findings=${result.governance.findings.length}`);
  }
  if (result.artifacts !== undefined) {
    if (result.artifacts.report !== undefined) console.log(`report=${result.artifacts.report}`);
    if (result.artifacts.scorecard_markdown !== undefined) console.log(`scorecard_markdown=${result.artifacts.scorecard_markdown}`);
    if (result.artifacts.scorecard_html !== undefined) console.log(`scorecard_html=${result.artifacts.scorecard_html}`);
    if (result.artifacts.proof_dir !== undefined) console.log(`proof=${result.artifacts.proof_dir}`);
    if (result.artifacts.proof_zip !== undefined) console.log(`proof_zip=${result.artifacts.proof_zip}`);
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
  const invalidDetails: Record<string, string> = {};
  for (const file of jsonFiles) {
    const path = join(taskDir, file);
    try {
      validTasks += countTaskQueueTasks(JSON.parse(await readFile(path, "utf-8")) as unknown);
    } catch (error) {
      invalidFiles.push(file);
      invalidDetails[file] = errorMessage(error);
    }
  }

  if (invalidFiles.length > 0) {
    add("task_queue", "error", "task queue contains invalid JSON task files", {
      path: taskDir,
      json_files: jsonFiles.length,
      valid_tasks: validTasks,
      invalid_files: invalidFiles,
      invalid_details: invalidDetails,
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
  const sub = args[0]?.startsWith("--") ? "summary" : (args[0] ?? "summary");

  if (sub === "summary") {
    const [healthResp, snapshotResp] = await Promise.all([
      rpc("health") as Promise<RpcResp>,
      rpc("dashboard.snapshot") as Promise<RpcResp>,
    ]);
    if (!healthResp.ok) {
      console.error("osstack:", healthResp.error?.message ?? "health failed");
      return 1;
    }
    if (!snapshotResp.ok) {
      console.error("osstack:", snapshotResp.error?.message ?? "dashboard.snapshot failed");
      return 1;
    }
    const summary = {
      daemon: healthResp.result,
      cockpit: snapshotResp.result,
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printCockpitSummary(summary);
    }
    return 0;
  }

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

  if (sub === "next") {
    return await handleCockpitNextCommand(args.slice(1));
  }

  if (sub === "report") {
    return await handleCockpitReportCommand(args.slice(1));
  }

  if (sub === "proof") {
    return await handleCockpitProofCommand(args.slice(1));
  }

  if (sub === "run") {
    return await handleCockpitRunCommand(args.slice(1));
  }

  if (sub === "retry") {
    return await handleCockpitRetryCommand(args.slice(1));
  }

  if (sub === "approve") {
    return await handleCockpitApproveCommand(args.slice(1));
  }

  if (sub === "help") {
    console.log(`osstack dashboard / cockpit — local development cockpit

  osstack cockpit           Show daemon, run, kanban, report, and proof summary
  osstack cockpit --json    Print daemon status + dashboard snapshot JSON
  osstack cockpit run [loop run options]
                            Run queued work with report, scorecard, and proof defaults
  osstack cockpit next [--status ready|running|blocked] [--json]
                            Print actionable next steps from the cockpit snapshot
  osstack cockpit retry [task_id] [--workspace P] [--state P] [--json]
                            Requeue a failed or escalated task from loop state
  osstack cockpit approve <card_id> [--comment TEXT] [--json]
                            Approve a kanban card by moving it to done
  osstack cockpit report [run_id] [--workspace P] [--state P] [--events P] [--output P] [--open]
                            Generate a cockpit report from loop evidence
  osstack cockpit proof [run_id] [--workspace P] [--state P] [--events P] [--output-dir P] [--open]
                            Generate a proof pack from loop evidence
  osstack dashboard url       Print the URL for chat bots to return
  osstack dashboard open      Open the dashboard locally
  osstack dashboard snapshot  Print the JSON backing the dashboard
  osstack dashboard summary   Show the same product cockpit summary
  osstack dashboard next [--status ready|running|blocked]
                            Show the same actionable next steps
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

async function handleCockpitNextCommand(args: string[]): Promise<number> {
  const statusRaw = flagValue(args, "--status");
  const statusFilter = parseCockpitNextStatus(statusRaw);
  if (statusRaw !== undefined && statusFilter === undefined) {
    console.error("osstack: cockpit next requires --status ready|running|blocked");
    return 1;
  }
  const resp = (await rpc("dashboard.snapshot")) as { ok: boolean; result?: unknown; error?: { message: string } };
  if (!resp.ok) {
    console.error("osstack:", resp.error?.message ?? "dashboard.snapshot failed");
    return 1;
  }
  const cockpit = isRecord(resp.result) ? resp.result : {};
  const rawNextSteps = Array.isArray(cockpit["next_steps"]) ? cockpit["next_steps"] : [];
  const nextSteps = statusFilter === undefined
    ? rawNextSteps
    : rawNextSteps.filter((step) => isRecord(step) && step["status"] === statusFilter);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ next_steps: nextSteps }, null, 2));
    return 0;
  }
  printCockpitNextSteps(nextSteps, cockpitSummaryText(resolveLanguage()));
  return 0;
}

type CockpitNextStatus = "ready" | "running" | "blocked";

function parseCockpitNextStatus(value: string | undefined): CockpitNextStatus | undefined {
  if (value === "ready" || value === "running" || value === "blocked") return value;
  return undefined;
}

async function handleCockpitReportCommand(args: string[]): Promise<number> {
  const runId = firstPositionalValue(args, new Set(["--workspace", "--state", "--events", "--output", "--lang"]));
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const language = resolveLanguage(flagValue(args, "--lang"));
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
  const output = resolveLoopPath(
    flagValue(args, "--output") ?? join("reports", `osstack-report-${safeFileSegment(artifactId)}.md`),
    workspacePath,
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderReportMarkdownForArtifacts(state, events, language), "utf-8");
  const opened = args.includes("--open");
  if (opened) {
    const { spawn } = await import("node:child_process");
    spawn("open", [output], { detached: true, stdio: "ignore" }).unref();
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({ loop_id: state.loop_id, run_id: artifactId, report: output, opened }, null, 2));
  } else {
    console.log(`report=${output}`);
    console.log(`opened=${opened ? "yes" : "no"}`);
  }
  return 0;
}

async function handleCockpitApproveCommand(args: string[]): Promise<number> {
  const cardId = firstPositionalValue(args, new Set(["--comment"]));
  if (cardId === undefined) {
    console.error("osstack: cockpit approve requires a card_id");
    return 1;
  }
  const comment = flagValue(args, "--comment");
  const moveResp = (await rpc("kanban.move", {
    card_id: cardId,
    status: "done",
    actor: "cockpit",
  })) as RpcResp;
  if (!moveResp.ok) {
    console.error("osstack:", moveResp.error?.message ?? "cockpit approve failed");
    return 1;
  }
  let commented = false;
  if (comment !== undefined && comment.trim() !== "") {
    const commentResp = (await rpc("kanban.comment", {
      card_id: cardId,
      body: comment,
      author: "cockpit",
    })) as RpcResp;
    if (!commentResp.ok) {
      console.error("osstack:", commentResp.error?.message ?? "cockpit approve comment failed");
      return 1;
    }
    commented = true;
  }
  const card = moveResp.result as { card_id: string; status: string; completed_at?: number | null };
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      card_id: card.card_id,
      status: card.status,
      approved: card.status === "done",
      commented,
      completed_at: card.completed_at ?? null,
    }, null, 2));
  } else {
    console.log(`${card.card_id} approved → ${card.status}`);
    console.log(`commented=${commented ? "yes" : "no"}`);
  }
  return 0;
}

async function handleCockpitRunCommand(args: string[]): Promise<number> {
  const runArgs = ["run", ...cockpitRunArgs(args)];
  return await handleLoopCommand(runArgs);
}

async function handleCockpitRetryCommand(args: string[]): Promise<number> {
  const taskId = firstPositionalValue(args, new Set(["--workspace", "--state"]));
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const stateFilePath = resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  const state = await readLoopState(stateFilePath);
  if (state === null) {
    console.error(`osstack: no loop state found at ${stateFilePath}`);
    return 1;
  }
  const retryableTasks = state.completed_tasks.filter((task) => task.outcome !== "success");
  const sourceTask = taskId === undefined
    ? retryableTasks.at(-1)
    : state.completed_tasks.find((task) => task.task_id === taskId);
  if (sourceTask === undefined) {
    console.error(taskId === undefined
      ? "osstack: no failed or escalated task found to retry"
      : `osstack: no completed task found for task_id=${taskId}`);
    return 1;
  }
  if (sourceTask.outcome === "success") {
    console.error(`osstack: task_id=${sourceTask.task_id} succeeded; retry only accepts failed or escalated tasks`);
    return 1;
  }
  const retry = await enqueueTask({
    workspacePath,
    taskId: `${sourceTask.task_id}-retry`,
    capability: sourceTask.capability ?? "code.write",
    priority: 70,
    prompt: retryPromptForCompletedTask(sourceTask),
    context: retryContextForCompletedTask(state.loop_id, sourceTask),
  });
  const summary = {
    loop_id: state.loop_id,
    retry_of_task_id: sourceTask.task_id,
    retry_task: retry.task,
    path: retry.path,
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`retry_of=${sourceTask.task_id}`);
    console.log(`task_id=${retry.task.task_id}`);
    console.log(`path=${retry.path}`);
  }
  return 0;
}

function retryPromptForCompletedTask(task: LoopState["completed_tasks"][number]): string {
  const summary = task.error_summary ?? task.verify_summary ?? task.execution_summary ?? "No failure summary was recorded.";
  return [
    `Retry failed osstack loop task ${task.task_id}.`,
    `Previous outcome: ${task.outcome}.`,
    `Previous agent: ${task.agent_id}.`,
    `Summary: ${summary}`,
  ].join("\n");
}

function retryContextForCompletedTask(loopId: string, task: LoopState["completed_tasks"][number]): Record<string, unknown> {
  return {
    retry_of_task_id: task.task_id,
    retry_from_loop_id: loopId,
    previous_outcome: task.outcome,
    previous_agent_id: task.agent_id,
    previous_iterations: task.iterations,
    ...(task.run_id !== undefined ? { previous_run_id: task.run_id } : {}),
    ...(task.error_summary !== undefined ? { previous_error_summary: task.error_summary } : {}),
    ...(task.verify_summary !== undefined ? { previous_verify_summary: task.verify_summary } : {}),
    ...(task.verify_issues !== undefined ? { previous_verify_issues: task.verify_issues } : {}),
  };
}

function cockpitRunArgs(args: string[]): string[] {
  const next = [...args];
  if (!next.includes("--source")) {
    next.push("--source", "task_queue");
  }
  return ensureFlags(next, ["--report", "--scorecard", "--proof"]);
}

async function handleCockpitProofCommand(args: string[]): Promise<number> {
  const runId = firstPositionalValue(args, new Set(["--workspace", "--state", "--events", "--output-dir"]));
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
  const outputDir = resolveLoopPath(flagValue(args, "--output-dir") ?? "release", workspacePath);
  const governance = await scanWorkspaceGovernance(dirname(stateFilePath));
  let proof: Awaited<ReturnType<typeof writeProofPack>>;
  try {
    proof = await writeProofPack(state, outputDir, events, runId ?? state.loop_id, governance, offKnowledgeEvidence(), [], workspacePath);
  } catch (error) {
    console.error(`osstack: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const opened = args.includes("--open");
  if (opened) {
    const { spawn } = await import("node:child_process");
    spawn("open", [proof.proof_dir], { detached: true, stdio: "ignore" }).unref();
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      loop_id: state.loop_id,
      run_id: runId ?? state.loop_id,
      proof_dir: proof.proof_dir,
      proof_zip: proof.proof_zip,
      manifest: proof.proof_manifest,
      artifact_count: proof.artifact_count,
      opened,
    }, null, 2));
  } else {
    console.log(`proof=${proof.proof_dir}`);
    console.log(`proof_zip=${proof.proof_zip}`);
    console.log(`manifest=${proof.proof_manifest}`);
    console.log(`opened=${opened ? "yes" : "no"}`);
  }
  return 0;
}

function printCockpitSummary(summary: { daemon?: unknown; cockpit?: unknown }): void {
  const text = cockpitSummaryText(resolveLanguage());
  const daemon = isRecord(summary.daemon) ? summary.daemon : {};
  const cockpit = isRecord(summary.cockpit) ? summary.cockpit : {};
  const dashboard = isRecord(cockpit["dashboard"]) ? cockpit["dashboard"] : {};
  const overview = isRecord(cockpit["overview"]) ? cockpit["overview"] : {};
  const board = isRecord(cockpit["board"]) ? cockpit["board"] : {};
  const evidence = isRecord(cockpit["evidence"]) ? cockpit["evidence"] : {};
  const quality = isRecord(cockpit["quality"]) ? cockpit["quality"] : {};
  const recentRuns = Array.isArray(cockpit["recent_runs"]) ? cockpit["recent_runs"] : [];
  const nextSteps = Array.isArray(cockpit["next_steps"]) ? cockpit["next_steps"] : [];
  const columns = Array.isArray(board["columns"]) ? board["columns"] : [];

  console.log(text.title);
  console.log(`daemon=${String(daemon["version"] ?? "unknown")} phase=${String(daemon["phase"] ?? "unknown")} draining=${String(daemon["draining"] ?? "unknown")}`);
  console.log(`url=${String(dashboard["url"] ?? daemon["dashboard_url"] ?? "unavailable")}`);
  console.log(`runs total=${String(overview["total_runs"] ?? 0)} active=${String(overview["active_runs"] ?? daemon["active_runs"] ?? 0)} queued=${String(overview["queued_tasks"] ?? 0)} loops=${String(overview["active_loops"] ?? daemon["active_loops"] ?? 0)}`);
  console.log(`quality=${String(quality["grade"] ?? "unknown")} success_rate=${String(quality["success_rate"] ?? "unknown")}`);
  console.log(`evidence reports=${String(evidence["reports"] ?? 0)} proof_packs=${String(evidence["proof_packs"] ?? 0)}`);
  console.log(`${text.kanban}:`);
  for (const column of columns) {
    if (!isRecord(column)) continue;
    const cards = Array.isArray(column["cards"]) ? column["cards"] : [];
    console.log(`  ${String(column["name"] ?? "unknown")}: ${cards.length}`);
  }
  console.log(`${text.recentRuns}:`);
  for (const run of recentRuns.slice(0, 5)) {
    if (!isRecord(run)) continue;
    console.log(`  ${String(run["run_id"] ?? "unknown")} ${String(run["phase"] ?? "unknown")} ${String(run["outcome"] ?? "running")} ${String(run["agent_id"] ?? "unknown")}`);
  }
  if (recentRuns.length === 0) console.log(`  ${text.none}`);
  printCockpitNextSteps(nextSteps, text);
}

function cockpitSummaryText(language: LoopReportLanguage): {
  title: string;
  kanban: string;
  recentRuns: string;
  nextSteps: string;
  none: string;
} {
  if (language === "zh-CN") {
    return {
      title: "Osstack 驾驶舱",
      kanban: "任务看板",
      recentRuns: "最近运行",
      nextSteps: "下一步",
      none: "无",
    };
  }
  return {
    title: "Osstack Cockpit",
    kanban: "kanban",
    recentRuns: "recent runs",
    nextSteps: "next steps",
    none: "none",
  };
}

function printCockpitNextSteps(nextSteps: unknown[], text: ReturnType<typeof cockpitSummaryText>): void {
  console.log(`${text.nextSteps}:`);
  for (const step of nextSteps.slice(0, 5)) {
    if (!isRecord(step)) continue;
    console.log(`  [${String(step["status"] ?? "unknown")}] ${String(step["label"] ?? "unknown")} - ${String(step["detail"] ?? "")}`);
    if (typeof step["command"] === "string" && step["command"].length > 0) {
      console.log(`    command: ${step["command"]}`);
    }
  }
  if (nextSteps.length === 0) console.log(`  ${text.none}`);
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
  let invokedPath = process.argv[1];
  try {
    invokedPath = realpathSync(process.argv[1]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const invoked = pathToFileURL(invokedPath).href;
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
