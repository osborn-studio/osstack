// osstack CLI entry. Talks to the running daemon via Unix socket when needed.
// (shebang is injected by tsup banner)

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync as fsExistsSync, readFileSync, realpathSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertDbAccessAllowed,
  assertServeAllowed,
  ControlPlaneGuardError,
  defaultOsstackHome,
  loadRoleFile,
} from "./control-plane-guard.js";
import type { ProofStageInput } from "./proof-pack.js";
type ProofPackModule = typeof import("./proof-pack.js");
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
// @osstack/agents (~65ms: 11 adapters, zod capability parsing at module
// scope) is loaded lazily at its single use site in handleLoopCommand.
import {
  loadProofEvidence,
  renderComplianceReport,
  renderProofViewFromProofDir,
  validateProofEvidence,
  type ProofAudience,
} from "@osstack/compliance";
import {
  validateWorkspaceContracts,
  type ContractValidationReport,
} from "@osstack/contracts";
import {
  getLatestSuccessfulRollbackDrill,
  getRun,
  listEventsForRun,
  listPitfallLessons,
  type loadRepoConfig,
  PolicyProfile as PolicyProfileSchema,
  PIIRedactor,
  RepoConfig as RepoConfigSchema,
  rollbackDrillEligibilityEvidence,
  type RecordRollbackDrillInput,
  upsertPitfallLesson,
} from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import type { LoopProfileSummary } from "./loop-profile-routing.js";
// @osstack/governance (~20ms) loads lazily at its three scan/doctor sites.
import type { GovernanceFinding } from "@osstack/governance";
// @osstack/loop costs ~150ms cold to import; it is needed only by the loop/
// cockpit/proof command families. Types stay static (erased at build); every
// VALUE is pulled through loadLoop() inside the functions that use it.
import type {
  DiscoveryPolicy,
  LoopBudget,
  LoopBudgetStatus,
  LoopEvent,
  LoopKnowledgeTrace,
  LoopReportLanguage,
  LoopState,
  ReviewArtifact,
} from "@osstack/loop";
import { evaluatePolicyGate, makePolicyGate, OBSERVE_POLICY_DENIED_REASON } from "./policy-gate.js";
import {
  cacheKnowledgeFeedback,
  evaluateKnowledgeRetrieval,
  ingestKnowledgeSource,
  importKnowledgeSource,
  listCachedKnowledgePacks,
  loadKnowledgePackIndex,
  loadKnowledgePack,
  pinKnowledgePack,
  pruneKnowledgeCache,
  resolveKnowledgeSearch,
  syncKnowledgeCache,
  validateKnowledgePublishGate,
  type KnowledgePack,
  type KnowledgePackManifest,
  type KnowledgeScope,
  type KnowledgeMode,
  type KnowledgeRetrievalEvalCase,
  type KnowledgeSearchEvidence,
} from "@osstack/knowledge";
import { initProject } from "@osstack/skills";
// Command modules that pull heavy dependency trees (@osstack/loop, agents,
// github, governance, supervisor, the 3.8k-line daemon) are imported lazily
// at their dispatch sites — see the Performance Budgets section in AGENTS.md.
// Static imports here are paid by EVERY osstack invocation.
import type { LoopDoctorCheck, LoopDoctorResult } from "./product-entry-command.js";
import type { DeliverCommandDeps } from "./deliver-command.js";
import {
  cockpitTuiModel,
  renderCockpitFullscreen,
  renderCockpitTui,
  renderCockpitTuiAction,
  runInteractiveCockpitFullscreen,
  runInteractiveCockpitTui,
  selectCockpitTuiAction,
  type CockpitKnowledgeSummary,
  type CockpitTuiActionSelection,
} from "./cockpit-tui.js";
import { applyDeployedEnvDefaults } from "./deployed-home.js";
import { logsDir, osstackHome, resolveSocketPath } from "./paths.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";
import { handleUpgradeCommand } from "./upgrade.js";
import { handlePolicyCommand } from "./policy-command.js";
import { resolveRegistryPath } from "./supervisor-cli-support.js";
import { renderUpdateCheckStatus, type UpdateCheckCache } from "./update-check.js";
import { handleHubCommand, buildRealHubCliDeps } from "./hub-cli.js";
import { handleHermesCommand } from "./hermes-command.js";
import { handleSessionCommand } from "./session-command.js";
import { handleTaskCommand } from "./task-command.js";
import type { LoopProbeObservationResultV1 } from "./loop-probe-observer.js";
import type { LoopNeatFinalizerResultV1 } from "./loop-neat-finalizer.js";
import { runAutonomyHealth } from "./autonomy-health.js";
import type { GuardedGitProofInput, GuardedGitRuntime } from "./guarded-git-runtime.js";
import {
  assertGuardedCandidateBase,
  computeDeployScriptAuthority,
  loadPrivateRepoOverlay,
  mergeRepoPolicy,
  runControlledRollbackDrill,
} from "@osstack/autonomy";
// @osstack/supervisor statically chains to loop/governance/agents/github
// (~177ms combined). Its two consumers load it lazily at their call sites.

const execFileAsync = promisify(execFile);

// Memoized loader for @osstack/loop (see the import-type note above).
type LoopModule = typeof import("@osstack/loop");
let loopModulePromise: Promise<LoopModule> | undefined;
function loadLoop(): Promise<LoopModule> {
  loopModulePromise ??= import("@osstack/loop");
  return loopModulePromise;
}

interface ArtifactVerificationOptions {
  requireGitDiff?: boolean;
  targetPaths?: string[];
  forbiddenPaths?: string[];
}

function socketPath(): string {
  return resolveSocketPath();
}

async function readAutonomyApprovalTrustStore(
  path: string,
): Promise<ReadonlyMap<string, string>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch (error) {
    if (
      isRecord(error)
      && error["code"] === "ENOENT"
    ) {
      return new Map();
    }
    throw new Error(
      `invalid autonomy approval trust store ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !isRecord(raw)
    || raw["schema_version"] !== 1
    || !Array.isArray(raw["keys"])
    || Object.keys(raw).some(
      (key) => key !== "schema_version" && key !== "keys",
    )
  ) {
    throw new Error(
      `invalid autonomy approval trust store ${path}: expected schema_version=1 and keys[]`,
    );
  }
  const keys = new Map<string, string>();
  for (const value of raw["keys"]) {
    if (
      !isRecord(value)
      || Object.keys(value).some(
        (key) => key !== "key_id" && key !== "public_key_pem",
      )
      || typeof value["key_id"] !== "string"
      || value["key_id"].length === 0
      || typeof value["public_key_pem"] !== "string"
      || value["public_key_pem"].length === 0
      || keys.has(value["key_id"])
    ) {
      throw new Error(
        `invalid autonomy approval trust store ${path}: keys must be unique key_id/public_key_pem objects`,
      );
    }
    keys.set(value["key_id"], value["public_key_pem"]);
  }
  return keys;
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
  release status      输出面向上线交接的发布状态摘要
  release edgeone     输出 EdgeOne Knowledge Cloud 上线清单
  deliver <需求>      从一句需求进入 task queue -> loop -> report/scorecard/proof
  autonomy            查看、批准或恢复 guarded Git autonomy 运行
  daily               只读组合简报：成熟度扫描 + GitHub PR/CI/release + 栈看板 + 增量对比
  daily schedule      通过 daemon 按间隔调度简报（只读，不受 observe 模式限制）
  daily sessions      列出 daemon 管理的每日简报会话
  daily unschedule    停止某个每日简报会话
  start               生成受合同约束的交付：写入 Execution Contract 并登记待审批
  control             驱动合同审批生命周期：status/approve/revise/stop（approve 输出 deliver 命令但不执行）

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
  probe start         对需求或规格逐题探询，并持久化四象限未知项台账
  policy check        校验 .osstack/repo.yaml 与 policy.yaml（只读；observe 模式拒绝执行）
  govern check        运行确定性治理检查
  neat check          只读检查项目指令、文档合同与知识面完整性
  neat semantic       显式运行证据受限的语义知识卫生审计（V2、默认关闭）
  neat memory         计划、批准、施行或恢复可审计的记忆毕业事务
  neat narrative      计划、批准、施行或恢复可审计的叙事手术
  neat dependencies   扫描、确认或撤销跨仓依赖义务
  contracts check     检查前端调用与后端 API 契约是否对齐

私有 Hub（可选；Hub 为发布权威，经 OSSTACK_HUB_ROOT 解析）：
  hub candidate <资产路径> --namespace organization/<id> [--allow-dirty] [--json]
                      只登记外部源引用（不复制源码、不发布）；脏工作区需 --allow-dirty
  hub publish <资产ID> --gate team [--json]
                      发布 Hub 托管资产；打印逻辑发布身份（release_id+digest+storage_key），绝不打印 dist 路径
  compliance list     列出合规映射包
  knowledge list       列出本地、官方或缓存的 Osstack 知识包
  knowledge login      保存 Knowledge Cloud URL/token 到本地缓存
  knowledge sync       从 Knowledge Cloud 同步官方或团队知识包
  knowledge search     搜索本地、缓存或云端 Osstack 知识库
  knowledge inspect    查看 chunk 内容、pack 元数据和来源引用
  knowledge pin        固定本地缓存中的 pack 版本
  knowledge publish    发布本地 pack 到 Knowledge Cloud
  knowledge feedback   记录或上报 chunk 有用/无用反馈
  knowledge feedback-summary
                       查看 Knowledge Cloud 反馈汇总
  knowledge review-queue
                       查看 Knowledge Cloud 审核队列
  knowledge sources    查看内部 provenance/license 来源
  knowledge import     将团队或项目文档加工为 Osstack-native pack
  lessons list        查看本地 pitfall 知识库

控制平面（recursive control plane）：
  supervise register  将仓库登记进组合控制平面
  supervise scan      扫描已登记仓库的闭环成熟度与风险
  supervise report    渲染组合闭环报告
  supervise init-loop-doc  为仓库生成 docs/LOOP.md 闭环契约
  feedback assets     列出失败运行沉淀的反馈资产
  improve propose     从反馈资产生成改进提案
  improve apply       检查当前仓库门禁（不实施提案，默认 dry-run）
  improve inspect     查看提案内容和用于批准的摘要
  improve approve     按摘要批准提案（需 --yes）
  improve execute     生成并验证低风险候选补丁（需 --yes，不合并发布）
  improve status      查看候选执行状态与证据
  evaluator list      列出评估器版本与当前冻结 epoch
  evaluator challenge 用锚点用例评分挑战者评估器（仅建议）
  evaluator promote   在 epoch 边界晋升挑战者（默认 dry-run，需 --yes）
  adversarial list    列出评估器判错生成的对抗锚点用例
  meta eval           评估评估器/路由/仓库健康趋势（只读建议）

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
  profile: string | null;
  write_concurrency: number | null;
  read_concurrency: number | null;
  power_policy: "none" | "process_assertion" | null;
  clock_monitor: "monotonic-v1" | null;
}

interface ServeLaunchdInstallResult extends ServeLaunchdStatus {
  loaded: boolean;
  load_skipped: boolean;
  home: string;
  logs_dir: string;
  power_policy_record: string;
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

  // Talk to the daemon that is actually deployed. Without this, a plain shell
  // (no OSSTACK_HOME/OSSTACK_SOCKET exported) resolves ~/.osstack/daemon.sock
  // and every daemon-touching command reports "not running" against a healthy
  // launchd daemon serving a different home. Runs before the help text so the
  // socket path it prints is the real one. An explicit env still wins, and
  // `serve` is excluded because it CREATES a daemon rather than addressing one.
  if (cmd !== "serve") applyDeployedEnvDefaults();

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
  collaborator inspect|draft|sign|install|status|revoke
                        Finite signed phase continuation for controlled sessions
  session list|status|snapshot|send
                      Inspect and resume governed agent conversations

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
  release doctor [--target all|primary|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--json]
                      Check publish/deploy prerequisites: GitHub auth, repo
                      secrets, npm auth, and EdgeOne deploy readiness
  release plan [--target all|primary|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--json]
                      Generate a blocker-aware publish/deploy runbook
  release status [--target all|primary|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--json]
                      Summarize completion, external blockers, and next actions
  release handoff [--target primary|all|npm|knowledge-cloud|single-binary] [--workspace P] [--cloud-url URL] [--output-dir P] [--json]
                      Generate a consolidated release handoff folder
  release npm [--workspace P] [--output P] [--json]
                      Generate the npm publish setup handoff
  release edgeone [--workspace P] [--cloud-url URL] [--output P] [--json]
                      Generate the EdgeOne Knowledge Cloud setup handoff
  init [dir]          Scaffold OSBORN project layout (V2 osb-init)
  deliver <prompt> [--verify CMD] [--auto-agent] [--worktree] [--autonomy legacy|guarded-local|guarded-git]
                      Product entry: task queue -> loop -> report/scorecard/proof;
                      guarded-git adds risk, signed approval, PR/CI/merge, final proof
  autonomy list|status|approve|reject|resume
                      Inspect and control guarded Git autonomy runs. High-risk
                      decisions require an externally signed decision file.
  daily [--registry P] [--workspace P] [--json]
                      Read-only portfolio brief: maturity scan + GitHub PR/CI/release
                      + stack board + delta since the last brief (golden path)
  daily schedule --interval-ms N [--registry P] [--workspace P] [--schedule EXPR] [--json]
                      Schedule the brief on an interval via the daemon (read-only;
                      not observe-gated). EXPR is recorded for humans; interval drives it
  daily sessions [--json]
                      List daemon-managed daily-brief sessions
  daily unschedule <daily_session_id> [--json]
                      Stop a daemon-managed daily-brief session
  start "<goal>" --repo-id <id> [--registry P] [--risk R] [--json]
                      Open a contract-gated delivery: writes an Execution Contract,
                      tracks it, and records a pending approval (needs_approval)
  control <contract-id> status|approve|revise|stop [--actor A] [--reason R] [--json]
                      Drive a contract's approval lifecycle; approve emits the
                      ready-to-run deliver command (does not spawn it)
  checkpoint create [--workspace P] [--json]
                      Create a shadow checkpoint outside .git for non-worktree recovery
  checkpoint restore <checkpoint_id|dir> [--workspace P] [--apply] [--json]
                      Restore tracked files from a shadow checkpoint (dry-run by default)

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
           [--self-improvement --repo-id ID [--propose-improvements]]
           [--report] [--scorecard] [--proof] [--json] [--daemon]
                                 Run one discover→execute→verify→iterate cycle
                                 (--self-improvement records traces/feedback assets from each
                                  completed task into the local control plane; local-only, opt-in)
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
  probe start --input P [--repo P] [--doc-type product|tech|test] [--json]
                                  Start a persistent four-quadrant elicitation session
  policy check [--repo-path P] [--json]
                                  Validate .osstack/repo.yaml + policy.yaml (read-only; observe mode refuses execution)
  govern check [path...] [--workspace P] [--changed] [--json]
                                  Run deterministic governance checks over workspace files
  neat check [--repo P] [--all|--base REF [--head REF]] [--json]
                                  Check repository knowledge contracts (read-only)
  neat semantic [--repo P] [--dimensions D] [--judge ID] [--json]
                                  Run an explicit evidence-bound V2 semantic audit
  neat memory <plan|approve|apply|recover> [options]
                                  Run an approved, recoverable memory transaction
  neat narrative <plan|approve|apply|recover> [options]
                                  Run an approved, recoverable narrative surgery
  neat dependencies <scan|inbox|confirm|revoke|recover> [options]
                                  Manage cross-repository dependency obligations
  governance scan <path...> [--json]
                                 Run deterministic governance checks over files
  compliance list [--json]
                                 List compliance mapping packs
  contracts check [--workspace P] [--manifest P] [--json]
                                 Validate frontend/backend API contract alignment

Private Hub (optional; Hub is the release authority via OSSTACK_HUB_ROOT):
  hub candidate <asset-path> --namespace organization/<id> [--reuse-scope team] [--allow-dirty] [--json]
                                 Register an EXTERNAL source reference (no source copy, no release);
                                 refuses a dirty source unless --allow-dirty
  hub publish <asset-id> --gate team [--surfaces api] [--json]
                                 Publish a Hub-managed asset; prints logical release identity
                                 (release_id + digest + storage_key), never a dist path
  compliance render <run_id> --pack P [--proof-dir P]
                                 Render a compliance evidence mapping report
  knowledge list [--pack P|--official|--cache-dir P] [--json]
                                 List local, official, or cached Osstack knowledge packs
  knowledge login --cloud-url URL [--token T] [--json]
                                 Save Knowledge Cloud connection settings locally
  knowledge sync [--cloud-url URL] [--private] [--tenant T] [--json]
                                 Sync official or tenant packs from Knowledge Cloud
  knowledge search <query> [--pack P] [--official] [--cloud-url URL] [--json]
                                 Search local, cached, or cloud Osstack knowledge packs
  knowledge inspect <chunk_id> [--pack P] [--official] [--json]
                                 Show chunk content, pack metadata, and source refs
  knowledge pin <pack_id>@<version> [--json]
                                 Pin a cached knowledge pack version
  knowledge publish --pack P [--cloud-url URL] [--tenant T] [--json]
                                 Publish a local pack to Knowledge Cloud
  knowledge feedback <chunk_id> --useful|--bad [--cloud-url URL] [--json]
                                 Record local/cloud feedback for retrieval quality
  knowledge sources --internal [--pack P|--official|--cache-dir P] [--json]
                                 Show internal provenance/license records
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
    // Control-plane boot guard (G1.2): an undeclared checkout must never serve
    // the default (stable) home; a declared checkout only its allowlisted homes.
    {
      // Start the role-file search at the running bin's own directory; the
      // guard walks a bounded number of ancestors (covers monorepo roots and
      // npm prefixes alike, and matches where serve --install provisions it).
      let checkoutRoot = dirname(fileURLToPath(import.meta.url));
      try { checkoutRoot = dirname(realpathSync(fileURLToPath(import.meta.url))); } catch { /* keep lexical */ }
      const guardHome = process.env.OSSTACK_HOME ?? defaultOsstackHome();
      try {
        const verdict = assertServeAllowed({ checkoutRoot, osstackHome: guardHome });
        console.log(`control-plane guard: role=${verdict.role} home=${verdict.homeCategory}${verdict.schema ? ` schema=[${verdict.schema.min},${verdict.schema.max}]` : ""}`);
      } catch (err) {
        if (err instanceof ControlPlaneGuardError) {
          console.error(`osstack: refusing to serve — ${err.message}`);
          return 78; // EX_CONFIG
        }
        throw err;
      }
    }
    let profile: string | undefined;
    let writeConcurrency: number | undefined;
    let readConcurrency: number | undefined;
    try {
      profile = optionalStringFlag(args, "--profile");
      writeConcurrency = positiveIntegerFlag(args, "--write-concurrency");
      readConcurrency = positiveIntegerFlag(args, "--read-concurrency");
    } catch (error) {
      console.error(`osstack: ${errorMessage(error)}`);
      return 1;
    }
    if (profile !== undefined) process.env["OSSTACK_AGENT_PROFILE"] = profile;
    const { startDaemon } = await import("./daemon.js");
    const handle = await startDaemon({
      ...(writeConcurrency === undefined
        ? {}
        : { writeConcurrency }),
      ...(readConcurrency === undefined
        ? {}
        : { readConcurrency }),
      guardedAutonomyFactory: async (db, dbPath) =>
        await createGuardedGitRuntimeForDb(
          db,
          dbPath,
          await readAutonomyApprovalTrustStore(
            join(osstackHome(), "approval-trust.json"),
          ),
        ),
    });
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
      const cache = (u.result as { cache?: UpdateCheckCache })?.cache ?? null;
      console.log(renderUpdateCheckStatus(cache, VERSION));
    } catch { /* older daemon without update.status */ }
    return 0;
  }

  if (cmd === "upgrade") {
    return await handleUpgradeCommand(args.slice(1), rpc);
  }

  if (cmd === "doctor") {
    if (args.includes("--control-plane")) {
      const { runControlPlaneChecks, renderControlPlaneFindings } = await import("./control-plane-doctor.js");
      const out = renderControlPlaneFindings(runControlPlaneChecks());
      console.log(out.text);
      return out.exitCode;
    }
    const { handleProductDoctorCommand } = await import("./product-entry-command.js");
    return await handleProductDoctorCommand(args.slice(1), {
      loopDoctor,
      printLoopDoctor,
      resolveLoopPath,
    });
  }

  if (cmd === "examples") {
    const { handleExamplesCommand } = await import("./product-entry-command.js");
    return await handleExamplesCommand(args.slice(1));
  }

  if (cmd === "guide") {
    const { handleGuideCommand } = await import("./product-entry-command.js");
    return await handleGuideCommand(args.slice(1));
  }

  if (cmd === "release") {
    return await handleReleaseCommand(args.slice(1));
  }

  if (cmd === "hub") {
    // Private Hub candidate/publish (Phase 2B). Prints the command's own JSON/
    // text result and returns its exit code. No dashboard routes.
    const result = await handleHubCommand(args.slice(1), buildRealHubCliDeps());
    if (result.stdout !== "") process.stdout.write(result.stdout + "\n");
    return result.exitCode;
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
    const { handleAgentCommand } = await import("./agent-command.js");
    return await handleAgentCommand(args.slice(1), {
      rpc,
      stateDbPath: ensureLocalStateDbPath,
    });
  }

  if (cmd === "config") {
    const { handleConfigCommand } = await import("./config.js");
    return await handleConfigCommand(args.slice(1));
  }

  if (cmd === "task") {
    return await handleTaskCommand(args.slice(1), {
      rpc,
      submit: streamTaskSubmit,
      observe: streamTaskObserve,
    });
  }

  if (cmd === "collaborator") {
    const { handleCollaboratorCommand } = await import("./collaborator-command.js");
    return await handleCollaboratorCommand(args.slice(1), { rpc });
  }

  if (cmd === "session") {
    return await handleSessionCommand(args.slice(1), { rpc });
  }

  if (cmd === "kanban") {
    return await handleKanbanCommand(args.slice(1));
  }

  if (cmd === "loop") {
    return await handleLoopCommand(args.slice(1));
  }

  if (cmd === "deliver") {
    const { handleDeliverCommand } = await import("./deliver-command.js");
    return await handleDeliverCommand(
      args.slice(1),
      createDeliverCommandDeps(),
    );
  }

  if (cmd === "autonomy") {
    const dbPath = await ensureLocalStateDbPath();
    const db = openDb({ path: dbPath });
    try {
      try {
        const trustedApprovalPublicKeys =
          await readAutonomyApprovalTrustStore(
            join(osstackHome(), "approval-trust.json"),
          );
        const runtime = await createGuardedGitRuntimeForDb(
          db,
          dbPath,
          trustedApprovalPublicKeys,
        );
        const { handleAutonomyCommand } = await import("./autonomy-command.js");
        return await handleAutonomyCommand(args.slice(1), {
          db,
          dbPath,
          trustedApprovalPublicKeys,
          health: () => runAutonomyHealth({
            db,
            db_path: dbPath,
            home: osstackHome(),
            socket_path: resolveSocketPath(),
            power_policy:
              process.env["OSSTACK_POWER_POLICY"] === "process_assertion"
                ? "process_assertion"
                : "none",
            clock_monitor:
              process.env["OSSTACK_CLOCK_MONITOR"] === "monotonic-v1",
            require_launchd:
              process.platform === "darwin"
              && process.env["OSSTACK_AGENT_PROFILE"] === "mac-mini",
          }),
          resume: (runId, decision) =>
            runtime.resume(runId, decision),
          drillRollback: executeControlledRollbackDrill,
        });
      } catch (error) {
        console.error(
          `osstack: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 1;
      }
    } finally {
      db.close();
    }
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
    const { handleStewardCommand } = await import("./steward-command.js");
    return await handleStewardCommand(args.slice(1));
  }

  if (cmd === "stack") {
    const dbPath = await ensureLocalStateDbPath();
    const { handleStackCommand } = await import("./stack-cli.js");
    const { createProbeKanbanTransitionGuard } = await import("./probe-kanban-guard.js");
    return handleStackCommand(args.slice(1), {
      dbPath,
      workspacePath: process.cwd(),
      transitionGuards: [createProbeKanbanTransitionGuard({ db_path: dbPath })],
    });
  }

  if (cmd === "governance" || cmd === "govern") {
    const { handleGovernanceCommand } = await import("./assurance-command.js");
    return await handleGovernanceCommand(args.slice(1));
  }

  if (cmd === "neat") {
    const { handleNeatCommand } = await import("./neat-command.js");
    return await handleNeatCommand(args.slice(1), {
      cwd: () => process.cwd(),
      stdout: (value) => console.log(value),
      stderr: (value) => console.error(value),
      authorize_write: evaluatePolicyGate,
    });
  }

  if (cmd === "probe") {
    const { handleProbeCommand } = await import("./probe-command.js");
    return await handleProbeCommand(args.slice(1), {
      cwd: () => process.cwd(),
      stdout: (value) => console.log(value),
      stderr: (value) => console.error(value),
    });
  }

  if (cmd === "contracts" || cmd === "contract") {
    const { handleContractsCommand } = await import("./assurance-command.js");
    return await handleContractsCommand(args.slice(1));
  }

  if (cmd === "compliance") {
    const { handleComplianceCommand } = await import("./assurance-command.js");
    return await handleComplianceCommand(args.slice(1));
  }

  if (cmd === "knowledge") {
    return await handleKnowledgeCommand(args.slice(1));
  }

  if (cmd === "lessons") {
    return await handleLessonsCommand(args.slice(1));
  }

  if (cmd === "supervise") {
    const { handleSuperviseCommand } = await import("./supervise-command.js");
    return await handleSuperviseCommand(args.slice(1));
  }

  if (cmd === "daily") {
    const sub = args[1];
    // Scheduling subcommands run through the daemon; bare `daily` (and its
    // flags like --json/--registry) stays the in-process manual brief.
    if (sub === "schedule" || sub === "sessions" || sub === "unschedule") {
      return await handleDailyScheduleCommand(args.slice(1));
    }
    const { handleDailyCommand } = await import("./daily-command.js");
    return await handleDailyCommand(args.slice(1));
  }

  if (cmd === "start") {
    const { handleStartCommand } = await import("./start-control-command.js");
    return await handleStartCommand(args.slice(1));
  }

  if (cmd === "control") {
    const { handleControlCommand } = await import("./start-control-command.js");
    return await handleControlCommand(args.slice(1));
  }

  if (cmd === "feedback") {
    const { handleFeedbackCommand } = await import("./supervise-command.js");
    return await handleFeedbackCommand(args.slice(1));
  }

  if (cmd === "improve") {
    const { handleImproveCommand } = await import("./improve-command.js");
    return await handleImproveCommand(args.slice(1));
  }

  if (cmd === "evaluator") {
    const { handleEvaluatorCommand } = await import("./evaluator-command.js");
    return await handleEvaluatorCommand(args.slice(1));
  }

  if (cmd === "policy") {
    return await handlePolicyCommand(args.slice(1));
  }

  if (cmd === "adversarial") {
    const { handleAdversarialCommand } = await import("./supervise-command.js");
    return await handleAdversarialCommand(args.slice(1));
  }

  if (cmd === "meta") {
    const { handleMetaCommand } = await import("./supervise-command.js");
    return await handleMetaCommand(args.slice(1));
  }

  if (cmd === "hermes") {
    return await handleHermesCommand(args.slice(1), { rpc });
  }

  if (cmd === "skills") {
    const { handleSkillsCommand } = await import("./skills-command.js");
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

type ReleaseDoctorStatus = "ok" | "warn" | "error";
type ReleaseDoctorTarget = "all" | "primary" | "npm" | "knowledge-cloud" | "single-binary";

interface ReleaseDoctorCheck {
  id: string;
  status: ReleaseDoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface ReleaseDoctorResult {
  ok: boolean;
  target: ReleaseDoctorTarget;
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
  | "manifest_unexpected_field"
  | "manifest_missing_osstack_version"
  | "manifest_missing_run_id"
  | "manifest_missing_loop_id"
  | "manifest_missing_agent_id"
  | "manifest_missing_agent_ids"
  | "manifest_missing_generated_from"
  | "manifest_missing_created_at"
  | "manifest_missing_generated_at"
  | "manifest_invalid_proof_stage"
  | "manifest_missing_supersedes"
  | "manifest_invalid_supersedes"
  | "supersedes_manifest_missing"
  | "supersedes_sha256_mismatch"
  | "supersedes_not_candidate"
  | "artifact_malformed"
  | "artifact_unexpected_field"
  | "artifact_invalid_sha256"
  | "artifact_invalid_bytes"
  | "compliance_report_malformed"
  | "compliance_report_unexpected_field"
  | "compliance_report_invalid_certification_claim"
  | "compliance_report_missing_artifact"
  | "duplicate_artifact_path"
  | "path_outside_proof_dir"
  | "missing_artifact"
  | "bytes_mismatch"
  | "sha256_mismatch"
  | "sha256sums_missing"
  | "sha256sums_malformed"
  | "sha256sums_duplicate_entry"
  | "sha256sums_unsafe_path"
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
  | "proof_zip_duplicate_entry"
  | "proof_zip_unsafe_entry"
  | "proof_zip_sha256_mismatch";

interface ProofArchiveIntegrityIssue {
  path: string;
  code: ProofArchiveIntegrityIssueCode;
  expected?: string;
  actual?: string;
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

  osstack release doctor [--target all|primary|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--cloud-url URL] [--json]
  osstack release plan [--target all|primary|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--cloud-url URL] [--output P] [--json]
  osstack release status [--target all|primary|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--cloud-url URL] [--output P] [--json]
  osstack release handoff [--target primary|all|npm|knowledge-cloud|single-binary] [--workspace P] [--proof-dir P] [--cloud-url URL] [--output-dir P] [--json]
  osstack release npm [--workspace P] [--output P] [--json]
  osstack release edgeone [--workspace P] [--cloud-url URL] [--output P] [--json]

Checks:
  - GitHub CLI authentication for repository operations
  - GitHub Actions runner availability for release/deploy workflows
  - npm Trusted Publishing (OIDC), package bootstrap, and EdgeOne secrets
  - Optional Apple notarization and Developer ID secrets for notarized single-binary release
  - optional proof-core evidence validation with --proof-dir
  - optional deployed Knowledge Cloud /healthz validation with --cloud-url
  - optional local npm login for first-package bootstrap/manual recovery
  - EdgeOne deploy credential readiness for Knowledge Cloud deploy
`);
    return 0;
  }
  if (sub === "doctor") return await handleReleaseDoctorCommand(args.slice(1));
  if (sub === "plan") return await handleReleasePlanCommand(args.slice(1));
  if (sub === "status") return await handleReleaseStatusCommand(args.slice(1));
  if (sub === "handoff") return await handleReleaseHandoffCommand(args.slice(1));
  if (sub === "npm") return await handleReleaseNpmCommand(args.slice(1));
  if (sub === "edgeone") return await handleReleaseEdgeOneCommand(args.slice(1));
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

interface ReleaseStatusSummary {
  target: ReleaseDoctorResult["target"];
  ready: boolean;
  completion: {
    code_verified: boolean;
    npm_publish: boolean;
    knowledge_cloud_deploy: boolean;
    single_binary_release: boolean;
  };
  external_blockers: string[];
  checks: Array<{
    id: string;
    status: ReleaseDoctorStatus;
    message: string;
  }>;
  next_actions: {
    operator: string[];
    validation: string[];
    github_readonly: string[];
    remote_workflow: string[];
    publish: string[];
    deploy: string[];
    post_release_validation: string[];
  };
  output?: string;
}

interface EdgeOneSetupSummary {
  provider: string;
  service: string;
  default_domain: string;
  healthcheck_path: string;
  runtime: {
    node: string;
    port: number;
    entry: string;
  };
  deploy_secret: string;
  fallback_deploy_secret?: string;
  project_name: string;
  environment: Record<string, string>;
  kv_bindings: string[];
  include_files: string[];
  console_checklist: string[];
  github_commands: string[];
  workflow_commands: string[];
  validation_commands: string[];
  output?: string;
}

interface NpmPublishSetupSummary {
  scope: string;
  package_name: string;
  repository: string;
  authentication: "trusted-publishing-oidc";
  required_secret: string | null;
  publish_access: string;
  console_checklist: string[];
  github_commands: string[];
  workflow_commands: string[];
  validation_commands: string[];
  post_release_validation_commands: string[];
  output?: string;
}

interface ReleaseHandoffBundleSummary {
  kind: string;
  target: ReleaseDoctorResult["target"];
  output_dir: string;
  cloud_url: string;
  required_secrets: string[];
  alternative_secret_groups: string[][];
  files: {
    manifest: string;
    release_status: string;
    release_plan: string;
    npm_setup: string;
    edgeone_setup: string;
    next_actions: string;
  };
  external_blockers: string[];
  next_actions: ReleaseStatusSummary["next_actions"];
}

async function handleReleaseHandoffCommand(args: string[]): Promise<number> {
  const target = parseReleaseDoctorTarget(flagValue(args, "--target") ?? "primary");
  if (target === undefined) {
    console.error("osstack: release handoff --target must be all, primary, npm, knowledge-cloud, or single-binary");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const proofDir = flagValue(args, "--proof-dir");
  const cloudUrl = flagValue(args, "--cloud-url") ?? "https://knowledge.osstack.ai";
  const outputDir = flagValue(args, "--output-dir") ?? "release-handoff";
  const handoff = await createReleaseHandoffBundle(workspacePath, {
    target,
    outputDir,
    cloudUrl,
    ...(proofDir === undefined ? {} : { proofDir }),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(handoff, null, 2));
  } else {
    console.log(renderReleaseHandoffBundleSummary(handoff));
  }
  return 0;
}

async function handleReleaseNpmCommand(args: string[]): Promise<number> {
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const setup = await createNpmPublishSetupSummary(workspacePath);
  const output = flagValue(args, "--output");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderNpmPublishSetupSummary(setup), "utf-8");
    setup.output = output;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(setup, null, 2));
  } else {
    console.log(renderNpmPublishSetupSummary(setup));
  }
  return 0;
}

async function handleReleaseEdgeOneCommand(args: string[]): Promise<number> {
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const cloudUrl = flagValue(args, "--cloud-url");
  const setup = await createEdgeOneSetupSummary(workspacePath, {
    ...(cloudUrl === undefined ? {} : { cloudUrl }),
  });
  const output = flagValue(args, "--output");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderEdgeOneSetupSummary(setup), "utf-8");
    setup.output = output;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(setup, null, 2));
  } else {
    console.log(renderEdgeOneSetupSummary(setup));
  }
  return 0;
}

async function handleReleaseStatusCommand(args: string[]): Promise<number> {
  const target = parseReleaseDoctorTarget(flagValue(args, "--target") ?? "all");
  if (target === undefined) {
    console.error("osstack: release status --target must be all, primary, npm, knowledge-cloud, or single-binary");
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
  const status = releaseStatusSummary(doctor, plan);
  const output = flagValue(args, "--output");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderReleaseStatusSummary(status), "utf-8");
    status.output = output;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderReleaseStatusSummary(status));
  }
  return 0;
}

async function handleReleasePlanCommand(args: string[]): Promise<number> {
  const target = parseReleaseDoctorTarget(flagValue(args, "--target") ?? "all");
  if (target === undefined) {
    console.error("osstack: release plan --target must be all, primary, npm, knowledge-cloud, or single-binary");
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
    console.error("osstack: release doctor --target must be all, primary, npm, knowledge-cloud, or single-binary");
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
  if (value === "all" || value === "primary" || value === "npm" || value === "knowledge-cloud" || value === "single-binary") return value;
  return undefined;
}

function releaseTargetIncludesNpm(target: ReleaseDoctorTarget): boolean {
  return target === "all" || target === "primary" || target === "npm";
}

function releaseTargetIncludesKnowledgeCloud(target: ReleaseDoctorTarget): boolean {
  return target === "all" || target === "primary" || target === "knowledge-cloud";
}

function releaseTargetIncludesSingleBinary(target: ReleaseDoctorTarget): boolean {
  return target === "all" || target === "single-binary";
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

  const edgeOneDeploySecrets = ["EDGEONE_API_TOKEN", "EDGEONE_DEPLOY_HOOK_URL"];
  const knowledgeCloudPublishSecrets = ["OSSTACK_KNOWLEDGE_PUBLISH_TOKEN"];
  const requiredSecrets = target === "all" ? [...edgeOneDeploySecrets, ...knowledgeCloudPublishSecrets]
    : [
      ...(releaseTargetIncludesKnowledgeCloud(target) ? [...edgeOneDeploySecrets, ...knowledgeCloudPublishSecrets] : []),
    ];
  const secrets = await releaseSecretsCheck(requiredSecrets, {
    alternativeGroups: releaseTargetIncludesKnowledgeCloud(target) ? [edgeOneDeploySecrets] : [],
  });
  checks.push(secrets);

  if (releaseTargetIncludesNpm(target)) {
    checks.push(await releaseNpmPublishAssetsCheck(process.cwd()));
    checks.push(await releaseNpmPackageBootstrapCheck(process.cwd()));
    checks.push(await releaseVersionPackagesPrCheck());
    checks.push(await releaseCommandCheck({
      id: "npm_auth",
      command: "npm",
      args: ["whoami"],
      envOverride: "OSSTACK_TEST_RELEASE_NPM_AUTH",
      okMessage: "Local npm login is available for manual publish checks.",
      errorMessage: "Local npm login is unavailable; it is optional for OIDC publishing but required for first-package bootstrap or manual recovery.",
      missingSeverity: "warn",
    }));
    checks.push(await releaseNpmScopeAccessCheck());
  }

  if (releaseTargetIncludesKnowledgeCloud(target)) {
    checks.push(await releaseKnowledgeCloudDeployAssetsCheck(process.cwd()));
    checks.push(await releaseKnowledgeCloudWorkflowCheck());
    if (options.cloudUrl !== undefined) {
      checks.push(await releaseKnowledgeCloudHealthCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudSearchCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudSyncCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudAuditCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudFeedbackSummaryCheck(options.cloudUrl));
      checks.push(await releaseKnowledgeCloudReviewUiCheck(options.cloudUrl));
    }
    checks.push(releaseEdgeOneDeployCredentialCheck(secrets));
  }
  if (releaseTargetIncludesSingleBinary(target)) {
    checks.push(await releaseSingleBinaryReleaseAssetsCheck(process.cwd()));
    checks.push(await releaseSingleBinaryWorkflowCheck());
  }

  const proofDir = options.proofDir ?? await discoverLatestProofDir(options.workspacePath ?? process.cwd());
  if (proofDir !== undefined) {
    checks.push(await releaseProofValidationCheck(proofDir, { discovered: options.proofDir === undefined }));
  }

  const npmPublishAssetsReady = checks.find((check) => check.id === "npm_publish_assets")?.status !== "error";
  const npmPackageBootstrapReady = checks.find((check) => check.id === "npm_package_bootstrap")?.status !== "error";
  const versionPackagesPrReady = checks.find((check) => check.id === "version_packages_pr")?.status !== "warn";
  const knowledgeDeployAssetsReady = checks.find((check) => check.id === "knowledge_cloud_deploy_assets")?.status !== "error";
  const knowledgeWorkflowReady = checks.find((check) => check.id === "knowledge_cloud_workflow")?.status !== "error";
  const knowledgeHealthReady = checks.find((check) => check.id === "knowledge_cloud_health")?.status !== "error";
  const knowledgeSearchReady = checks.find((check) => check.id === "knowledge_cloud_search")?.status !== "error";
  const knowledgeSyncReady = checks.find((check) => check.id === "knowledge_cloud_sync")?.status !== "error";
  const knowledgeAuditReady = checks.find((check) => check.id === "knowledge_cloud_audit")?.status !== "error";
  const knowledgeFeedbackSummaryReady = checks.find((check) => check.id === "knowledge_cloud_feedback_summary")?.status !== "error";
  const knowledgeReviewUiReady = checks.find((check) => check.id === "knowledge_cloud_review_ui")?.status !== "error";
  const singleBinaryAssetsReady = checks.find((check) => check.id === "single_binary_release_assets")?.status !== "error";
  const singleBinaryWorkflowReady = checks.find((check) => check.id === "single_binary_workflow")?.status !== "error";
  const actionsReady = githubActions.status !== "error";
  const npmPublish = actionsReady && npmPublishAssetsReady && npmPackageBootstrapReady && versionPackagesPrReady;
  const knowledgeCloudDeploy = actionsReady
    && hasAnySecret(secrets, edgeOneDeploySecrets)
    && knowledgeDeployAssetsReady
    && knowledgeWorkflowReady
    && knowledgeHealthReady
    && knowledgeSearchReady
    && knowledgeSyncReady
    && knowledgeAuditReady
    && knowledgeFeedbackSummaryReady
    && knowledgeReviewUiReady;
  const singleBinaryRelease = actionsReady
    && singleBinaryAssetsReady
    && singleBinaryWorkflowReady;
  const ok = target === "primary" ? npmPublish && knowledgeCloudDeploy
    : target === "npm" ? npmPublish
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
    "package.json",
    "scripts/preflight-npm-publish-access.mjs",
    "scripts/preflight-npm-package-bootstrap.mjs",
    "scripts/preflight-npm-trusted-publishers.mjs",
    "scripts/publish-packages-safely.mjs",
    "scripts/smoke-npm-publish-order.mjs",
    ".github/workflows/release.yml",
  ];
  const checkedAssets = [
    ...requiredAssets,
    ".changeset/osstack-upgrade-knowledge-cloud.md",
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
  const readOptionalAsset = async (path: string): Promise<string> => {
    try {
      return await readFile(join(assetRoot, path), "utf-8");
    } catch {
      return "";
    }
  };
  const cliPackageRaw = await readAsset("packages/cli/package.json");
  const changeset = await readOptionalAsset(".changeset/osstack-upgrade-knowledge-cloud.md");
  const workflow = await readAsset(".github/workflows/release.yml");
  const rootPackage = await readAsset("package.json");
  const npmPreflight = await readAsset("scripts/preflight-npm-publish-access.mjs");
  const npmBootstrap = await readAsset("scripts/preflight-npm-package-bootstrap.mjs");
  const npmTrust = await readAsset("scripts/preflight-npm-trusted-publishers.mjs");
  const npmPublisher = await readAsset("scripts/publish-packages-safely.mjs");
  const npmPublishOrderSmoke = await readAsset("scripts/smoke-npm-publish-order.mjs");
  let cliVersion = "";

  if (cliPackageRaw !== "") {
    try {
      const cliPackage = JSON.parse(cliPackageRaw) as {
        name?: string;
        version?: string;
        bin?: Record<string, string>;
        files?: string[];
        publishConfig?: { access?: string };
        repository?: { directory?: string };
        engines?: { node?: string };
      };
      cliVersion = cliPackage.version ?? "";
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
  const changesetPending = changeset.includes("\"@osstack/cli\": minor");
  const versionedForPublish = cliVersion !== "" && cliVersion !== "0.1.0";
  if (!changesetPending && !versionedForPublish) {
    violations.push("NPM publish assets must include a pending CLI changeset or a versioned CLI package.");
  }
  expectAsset(changeset, "\"@osstack/cli\": minor", "Changeset must version @osstack/cli.");
  expectAsset(workflow, "uses: changesets/action@v1", "Release workflow must use changesets/action.");
  expectAsset(workflow, "pnpm smoke:release-plan", "Release workflow must run release plan smoke.");
  expectAsset(workflow, "pnpm smoke:npm-install", "Release workflow must run npm install smoke.");
  expectAsset(workflow, "pnpm smoke:npm-preflight", "Release workflow must run npm preflight smoke.");
  expectAsset(workflow, "pnpm smoke:npm-trust", "Release workflow must test the Trusted Publisher preflight contract.");
  expectAsset(workflow, "pnpm smoke:npm-publish-order", "Release workflow must test dependency-first publish ordering.");
  expectAsset(workflow, "publish: pnpm release", "Release workflow must publish through the guarded root release command.");
  expectAsset(workflow, "id-token: write", "Release workflow must allow npm Trusted Publishing through GitHub OIDC.");
  expectAsset(workflow, "node-version: 24", "Release workflow must use a Node version compatible with npm Trusted Publishing.");
  expectAsset(workflow, "npm@11.17.0", "Release workflow must pin an npm client compatible with Trusted Publishing.");
  violations.push(...trustedPublishingWorkflowViolations(workflow));
  expectAsset(rootPackage, "\"preflight:npm-publish\"", "Root package scripts must expose preflight:npm-publish.");
  expectAsset(rootPackage, "\"preflight:npm-bootstrap\"", "Root package scripts must expose preflight:npm-bootstrap.");
  expectAsset(rootPackage, "\"preflight:npm-trust\"", "Root package scripts must expose preflight:npm-trust.");
  expectAsset(rootPackage, "\"release\": \"pnpm preflight:npm-bootstrap && node scripts/publish-packages-safely.mjs\"", "Root release command must gate the safe sequential publisher on package bootstrap.");
  expectAsset(rootPackage, "\"smoke:npm-publish-order\"", "Root package scripts must expose smoke:npm-publish-order.");
  expectAsset(npmPreflight, "npm\", [\"access\", \"list\", \"packages\", scope, \"--json\"]", "NPM preflight script must verify publish-scope access with npm access list packages.");
  expectAsset(npmPreflight, "Scope not found", "NPM preflight script must explain missing npm scope failures.");
  expectAsset(npmBootstrap, "npm_package_bootstrap", "NPM bootstrap preflight must emit its stable contract kind.");
  expectAsset(npmTrust, "npm_trusted_publishers", "NPM trust preflight must emit its stable contract kind.");
  expectAsset(npmPublisher, "buildTopologicalPublishPlan", "NPM publisher must build a dependency-first plan.");
  expectAsset(npmPublisher, "publishPackagesSequentially", "NPM publisher must stop the train on the first publish failure.");
  expectAsset(npmPublisher, "CHANGESETS_OUTPUT", "NPM publisher must emit Changesets tag events for the release action.");
  expectAsset(npmPublisher, "New tag:", "NPM publisher must announce successful tags to changesets/action@v1.");
  if (npmPublisher.includes("\"--provenance\"")) {
    violations.push("NPM publisher must defer provenance to Trusted Publishing so private source repositories remain publishable.");
  }
  expectAsset(npmPublisher, "\"--registry\"", "NPM publisher must publish to the same canonical registry it inspects.");
  expectAsset(npmPublishOrderSmoke, "the first publish failure must stop the train", "NPM publish ordering smoke must cover fail-stop behavior.");
  if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/u.test(npmPublisher)) {
    violations.push("Safe NPM publisher must not depend on long-lived npm tokens.");
  }

  const ok = missing.length === 0 && violations.length === 0;
  return {
    id: "npm_publish_assets",
    status: ok ? "ok" : "error",
    message: ok
      ? "NPM publish assets are present and internally consistent."
      : "NPM publish assets are missing or inconsistent.",
    details: {
      checked: checkedAssets,
      missing,
      violations,
      root: assetRoot,
      changeset_pending: changesetPending,
      versioned_for_publish: versionedForPublish,
    },
  };
}

async function releaseNpmPackageBootstrapCheck(workspacePath: string): Promise<ReleaseDoctorCheck> {
  const override = process.env["OSSTACK_TEST_RELEASE_NPM_BOOTSTRAP"];
  if (override === "ok") {
    return {
      id: "npm_package_bootstrap",
      status: "ok",
      message: "All public workspace packages exist on npm and are eligible for Trusted Publisher configuration.",
      details: { missing: [] },
    };
  }
  if (override?.startsWith("error:") === true) {
    const missing = override.slice("error:".length).split(",").filter(Boolean);
    return {
      id: "npm_package_bootstrap",
      status: "error",
      message: "One or more public workspace packages require a manual first publish before OIDC can publish them.",
      details: { missing },
    };
  }
  const assetRoot = await findReleaseAssetRoot(workspacePath);
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      join(assetRoot, "scripts", "preflight-npm-package-bootstrap.mjs"),
      "--root",
      assetRoot,
      "--json",
    ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { packages?: unknown; missing?: unknown };
    return {
      id: "npm_package_bootstrap",
      status: "ok",
      message: "All public workspace packages exist on npm and are eligible for Trusted Publisher configuration.",
      details: {
        packages: Array.isArray(parsed.packages) ? parsed.packages : [],
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      },
    };
  } catch (error) {
    const commandError = error as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof commandError.stdout === "string" ? commandError.stdout : "";
    const stderr = typeof commandError.stderr === "string" ? commandError.stderr : "";
    const message = [stdout, stderr, releaseErrorMessage(error)]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    let missing: unknown[] = [];
    for (const candidate of [stdout, stderr]) {
      try {
        const parsed = JSON.parse(candidate) as { missing?: unknown };
        if (Array.isArray(parsed.missing)) {
          missing = parsed.missing;
          break;
        }
      } catch {
        // Preserve the bounded command error below when one stream is not JSON.
      }
    }
    return {
      id: "npm_package_bootstrap",
      status: "error",
      message: missing.length > 0
        ? "One or more public workspace packages require a manual first publish before OIDC can publish them."
        : "Could not verify npm package bootstrap state before Trusted Publishing.",
      details: { missing, error: message },
    };
  }
}

export function trustedPublishingWorkflowViolations(workflow: string): string[] {
  const publishStep = workflow.split("- name: Version PR / Publish")[1] ?? "";
  if (publishStep.includes("NPM_TOKEN") || publishStep.includes("NODE_AUTH_TOKEN")) {
    return ["Release publish step must not expose long-lived npm tokens when using Trusted Publishing."];
  }
  return [];
}

async function releaseNpmScopeAccessCheck(): Promise<ReleaseDoctorCheck> {
  const scope = "@osstack";
  const override = process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"];
  if (override === "ok") {
    return {
      id: "npm_scope_access",
      status: "ok",
      message: `Local npm access to ${scope} is available for bootstrap or manual recovery.`,
      details: { scope },
    };
  }
  if (override === "warn") {
    return {
      id: "npm_scope_access",
      status: "warn",
      message: `npm publish access to ${scope} was not checked locally.`,
      details: { scope, reason: "not_checked" },
    };
  }
  if (override === "error" || override === "error:scope") {
    return {
      id: "npm_scope_access",
      status: "warn",
      message: `Local npm cannot administer ${scope}; OIDC publishing remains independent, but first-package bootstrap/manual recovery is unavailable.`,
      details: { scope, reason: "scope_not_found_or_unauthorized", required_for_oidc_publish: false },
    };
  }
  if (override === "error:forbidden") {
    return {
      id: "npm_scope_access",
      status: "warn",
      message: `Local npm cannot administer ${scope}; OIDC publishing remains independent, but manual recovery is unavailable.`,
      details: { scope, reason: "scope_forbidden", required_for_oidc_publish: false },
    };
  }
  try {
    await execFileAsync("npm", ["access", "list", "packages", scope, "--json"], { timeout: 10_000 });
    return {
      id: "npm_scope_access",
      status: "ok",
      message: `Local npm access to ${scope} is available for bootstrap or manual recovery.`,
      details: { scope },
    };
  } catch (error) {
    const message = releaseErrorMessage(error);
    const scopeMissing = /Scope not found|not found|E404/i.test(message);
    const scopeForbidden = /E403|Forbidden|not authorized|not authorised|permission|access denied/i.test(message);
    return {
      id: "npm_scope_access",
      status: "warn",
      message: scopeMissing
        ? `Local npm cannot administer ${scope}; create/authorize it only for first-package bootstrap or manual recovery.`
        : scopeForbidden
        ? `Local npm cannot administer ${scope}; OIDC publishing remains independent.`
        : `Could not verify local npm recovery access to ${scope}; Trusted Publishing does not use this login.`,
      details: {
        scope,
        reason: scopeMissing ? "scope_not_found_or_unauthorized" : scopeForbidden ? "scope_forbidden" : "not_checked",
        required_for_oidc_publish: false,
        error: message,
      },
    };
  }
}

async function releaseKnowledgeCloudDeployAssetsCheck(workspacePath: string): Promise<ReleaseDoctorCheck> {
  const assetRoot = await findReleaseAssetRoot(workspacePath);
  const requiredAssets = [
    "Dockerfile.knowledge-cloud",
    "deploy/knowledge-cloud/edgeone.json",
    "deploy/knowledge-cloud/render.yaml",
    ".github/workflows/knowledge-cloud-deploy.yml",
    "cloud-functions/[[default]].js",
    "package.json",
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
  const edgeone = await readAsset("deploy/knowledge-cloud/edgeone.json");
  const render = await readAsset("deploy/knowledge-cloud/render.yaml");
  const workflow = await readAsset(".github/workflows/knowledge-cloud-deploy.yml");
  const edgeOneFunction = await readAsset("cloud-functions/[[default]].js");
  const rootPackage = await readAsset("package.json");
  const expectAsset = (text: string, needle: string, message: string): void => {
    if (text !== "" && !text.includes(needle)) violations.push(message);
  };

  expectAsset(dockerfile, "EXPOSE 8787", "Dockerfile must expose port 8787.");
  expectAsset(dockerfile, "packages/knowledge-cloud/dist/bin.js", "Dockerfile must start the Knowledge Cloud executable.");
  expectAsset(edgeone, '"provider": "tencent-edgeone"', "EdgeOne config must identify Tencent EdgeOne.");
  expectAsset(edgeone, '"mode": "pages-functions"', "EdgeOne config must use Pages Functions mode.");
  expectAsset(edgeone, '"default_domain": "osstack-knowledge-cloud-1grycf4k.edgeone.cool"', "EdgeOne config must use the reachable EdgeOne preset domain as the default domain.");
  expectAsset(edgeone, '"custom_domain": "knowledge.osstack.ai"', "EdgeOne config must record the intended branded custom domain.");
  expectAsset(edgeone, '"healthcheck_path": "/healthz"', "EdgeOne config must healthcheck /healthz.");
  expectAsset(edgeone, '"kv_bindings"', "EdgeOne config must declare Knowledge Cloud KV bindings.");
  expectAsset(edgeone, '"osstack_knowledge_kv"', "EdgeOne config must declare the Osstack Knowledge KV binding name.");
  expectAsset(edgeone, '"knowledge-packs/official/**"', "EdgeOne config must include official knowledge packs.");
  expectAsset(edgeone, '"deploy_secret": "EDGEONE_API_TOKEN"', "EdgeOne config must declare the EdgeOne API token secret.");
  expectAsset(edgeone, '"fallback_deploy_secret": "EDGEONE_DEPLOY_HOOK_URL"', "EdgeOne config must retain the deploy hook fallback secret.");
  expectAsset(edgeone, '"project_name": "osstack-knowledge-cloud"', "EdgeOne config must declare the Makers project name.");
  expectAsset(edgeOneFunction, 'url.pathname === "/v1/search"', "EdgeOne function must serve /v1/search.");
  expectAsset(edgeOneFunction, 'url.pathname === "/v1/publish"', "EdgeOne function must serve /v1/publish.");
  expectAsset(edgeOneFunction, 'url.pathname === "/v1/private-packs"', "EdgeOne function must serve /v1/private-packs.");
  expectAsset(edgeOneFunction, 'url.pathname === "/review"', "EdgeOne function must serve the review UI.");
  expectAsset(edgeOneFunction, "OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", "EdgeOne function publish must require an explicit token.");
  expectAsset(edgeOneFunction, "osstack_knowledge_kv", "EdgeOne function must support the Osstack Knowledge KV binding.");
  expectAsset(edgeOneFunction, "edgeone-kv", "EdgeOne function must report durable EdgeOne KV publish persistence.");
  expectAsset(edgeOneFunction, "@edgeone/pages-blob", "EdgeOne function must support zero-config Blob persistence fallback.");
  expectAsset(edgeOneFunction, "edgeone-blob", "EdgeOne function must report durable EdgeOne Blob publish persistence.");
  expectAsset(edgeOneFunction, "osstack-knowledge-cloud-packs", "EdgeOne function must use a stable Blob store name.");
  expectAsset(rootPackage, '"@edgeone/pages-blob"', "Root package must include the EdgeOne Blob SDK for function deployment.");
  expectAsset(render, "dockerfilePath: ./Dockerfile.knowledge-cloud", "Render config must use Dockerfile.knowledge-cloud.");
  expectAsset(render, "healthCheckPath: /healthz", "Render config must healthcheck /healthz.");
  expectAsset(render, "OSSTACK_KNOWLEDGE_AUDIT_LOG", "Render config must persist audit JSONL.");
  expectAsset(render, "OSSTACK_KNOWLEDGE_FEEDBACK_LOG", "Render config must persist feedback JSONL.");
  expectAsset(render, "OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR", "Render config must persist published knowledge packs.");
  expectAsset(workflow, "workflow_dispatch:", "Knowledge Cloud deploy workflow must be manually triggerable.");
  expectAsset(workflow, "cancel-in-progress: true", "Knowledge Cloud deploy workflow must cancel older in-progress deploy runs.");
  expectAsset(workflow, "cloud_url:", "Knowledge Cloud deploy workflow must accept a deployed cloud URL for validation.");
  expectAsset(workflow, "pnpm smoke:knowledge-cloud", "Knowledge Cloud deploy workflow must run service smoke.");
  expectAsset(workflow, "pnpm smoke:knowledge-cloud:deploy", "Knowledge Cloud deploy workflow must run deploy asset smoke.");
  expectAsset(workflow, "docker build -f Dockerfile.knowledge-cloud", "Knowledge Cloud deploy workflow must build the Docker image.");
  expectAsset(workflow, "secrets.EDGEONE_API_TOKEN", "Knowledge Cloud deploy workflow must gate deploy on EDGEONE_API_TOKEN.");
  expectAsset(workflow, "edgeone@latest makers deploy . -n osstack-knowledge-cloud", "Knowledge Cloud deploy workflow must use the EdgeOne Makers CLI.");
  expectAsset(workflow, "timeout-minutes: 10", "Knowledge Cloud deploy workflow must bound the EdgeOne CLI step runtime.");
  expectAsset(workflow, "timeout --foreground --kill-after=30s 8m npx edgeone@latest", "Knowledge Cloud deploy workflow must kill a hung EdgeOne CLI deploy command before the job timeout.");
  expectAsset(workflow, "EDGEONE_DEPLOY_URL=https?://", "Knowledge Cloud deploy workflow must parse the EdgeOne deploy URL from CLI output.");
  expectAsset(workflow, "deploy_url=$deploy_url", "Knowledge Cloud deploy workflow must expose the EdgeOne deploy URL as a step output.");
  expectAsset(workflow, "VALIDATION_CLOUD_URL", "Knowledge Cloud deploy workflow must validate against the resolved deployed URL.");
  expectAsset(workflow, "EdgeOne CLI deploy exceeded the 8 minute command timeout", "Knowledge Cloud deploy workflow must explain EdgeOne CLI timeout failures.");
  expectAsset(workflow, "EDGEONE_DEPLOY_HOOK_URL", "Knowledge Cloud deploy workflow must retain the deploy hook fallback.");
  expectAsset(workflow, "OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", "Knowledge Cloud deploy workflow must configure the EdgeOne publish token when available.");
  expectAsset(workflow, "makers link -n osstack-knowledge-cloud", "Knowledge Cloud deploy workflow must link the EdgeOne project before setting env vars.");
  expectAsset(workflow, "makers env set OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", "Knowledge Cloud deploy workflow must set the EdgeOne publish token env var.");
  expectAsset(workflow, "inputs.cloud_url != '' || steps.edgeone-cli-deploy.outputs.deploy_url != ''", "Knowledge Cloud deploy workflow must validate either an input cloud_url or the EdgeOne CLI deploy URL.");
  expectAsset(workflow, "release doctor --target knowledge-cloud --cloud-url", "Knowledge Cloud deploy workflow must validate deployed health/search/sync/audit/feedback-summary/review-ui gates when cloud_url is supplied.");
  expectAsset(workflow, "knowledge sync --cloud-url", "Knowledge Cloud deploy workflow must sync from the deployed cloud URL when supplied.");
  expectAsset(workflow, "knowledge search \"proof pack checksum\" --cloud-url", "Knowledge Cloud deploy workflow must search the deployed cloud URL when supplied.");
  expectAsset(workflow, "validation-only run completed against", "Knowledge Cloud deploy workflow must summarize validation-only runs that check a cloud URL.");
  expectAsset(workflow, "inputs.cloud_url", "Knowledge Cloud deploy workflow must read the supplied cloud_url input.");

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

async function releaseKnowledgeCloudFeedbackSummaryCheck(cloudUrl: string): Promise<ReleaseDoctorCheck> {
  const normalized = normalizeCloudUrl(cloudUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let summaryUrl: URL | undefined;
  try {
    summaryUrl = new URL("/v1/feedback/summary", normalized);
    const response = await fetch(summaryUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    const raw = await response.text();
    const body = parseJsonObject(raw);
    const total = typeof body?.["total"] === "number" && body["total"] >= 0 ? body["total"] : undefined;
    const useful = typeof body?.["useful"] === "number" && body["useful"] >= 0 ? body["useful"] : undefined;
    const bad = typeof body?.["bad"] === "number" && body["bad"] >= 0 ? body["bad"] : undefined;
    const chunks = Array.isArray(body?.["chunks"]) ? body["chunks"] : undefined;
    const ok = response.ok && total !== undefined && useful !== undefined && bad !== undefined && chunks !== undefined;
    return {
      id: "knowledge_cloud_feedback_summary",
      status: ok ? "ok" : "error",
      message: ok
        ? `Deployed Knowledge Cloud feedback summary smoke passed at ${summaryUrl.toString()}.`
        : `Deployed Knowledge Cloud feedback summary smoke failed at ${summaryUrl.toString()}.`,
      details: {
        cloud_url: normalized,
        feedback_summary_url: summaryUrl.toString(),
        http_status: response.status,
        ...(total === undefined ? {} : { total }),
        ...(useful === undefined ? {} : { useful }),
        ...(bad === undefined ? {} : { bad }),
        ...(chunks === undefined ? {} : { chunk_count: chunks.length }),
      },
    };
  } catch (error) {
    const summaryUrlString = summaryUrl === undefined ? `${normalized.replace(/\/+$/, "")}/v1/feedback/summary` : summaryUrl.toString();
    return {
      id: "knowledge_cloud_feedback_summary",
      status: "error",
      message: `Could not run deployed Knowledge Cloud feedback summary smoke at ${summaryUrlString}.`,
      details: {
        cloud_url: normalized,
        feedback_summary_url: summaryUrlString,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function releaseKnowledgeCloudReviewUiCheck(cloudUrl: string): Promise<ReleaseDoctorCheck> {
  const normalized = normalizeCloudUrl(cloudUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let reviewUrl: URL | undefined;
  try {
    reviewUrl = new URL("/review?status=approved", normalized);
    const response = await fetch(reviewUrl, {
      method: "GET",
      headers: { accept: "text/html" },
      signal: controller.signal,
    });
    const html = await response.text();
    const hasTitle = html.includes("Osstack Knowledge Cloud Review Queue");
    const hasApprovedFilter = html.includes("Filter: approved");
    const hasOfficialPack = html.includes("osstack-core/");
    const ok = response.ok && hasTitle && hasApprovedFilter && hasOfficialPack;
    return {
      id: "knowledge_cloud_review_ui",
      status: ok ? "ok" : "error",
      message: ok
        ? `Deployed Knowledge Cloud review UI smoke passed at ${reviewUrl.toString()}.`
        : `Deployed Knowledge Cloud review UI smoke failed at ${reviewUrl.toString()}.`,
      details: {
        cloud_url: normalized,
        review_url: reviewUrl.toString(),
        http_status: response.status,
        has_title: hasTitle,
        has_approved_filter: hasApprovedFilter,
        has_official_pack: hasOfficialPack,
      },
    };
  } catch (error) {
    const reviewUrlString = reviewUrl === undefined ? `${normalized.replace(/\/+$/, "")}/review?status=approved` : reviewUrl.toString();
    return {
      id: "knowledge_cloud_review_ui",
      status: "error",
      message: `Could not run deployed Knowledge Cloud review UI smoke at ${reviewUrlString}.`,
      details: {
        cloud_url: normalized,
        review_url: reviewUrlString,
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
  expectAsset(publishScript, "--allow-ad-hoc", "Single-binary publish script must require an explicit flag before uploading ad-hoc archives.");
  expectAsset(publishScript, "public-ad-hoc", "Single-binary publish script must label ad-hoc GitHub Release uploads.");
  expectAsset(publishScript, "public-notarized", "Single-binary publish script must label notarized GitHub Release uploads.");
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
  expectAsset(workflow, "notarize:", "Single-binary release workflow must expose an explicit notarization switch.");
  expectAsset(workflow, "--allow-ad-hoc", "Single-binary release workflow must support explicit ad-hoc release uploads without Apple secrets.");
  expectAsset(workflow, "pnpm smoke:single-binary-release-pack", "Single-binary release workflow must smoke release archives.");
  expectAsset(workflow, "pnpm publish:single-binary", "Single-binary release workflow must call the publish script.");
  expectAsset(workflow, "pnpm notarize:single-binary", "Single-binary release workflow must notarize public release assets.");
  expectAsset(workflow, "APPLE_APP_SPECIFIC_PASSWORD", "Single-binary release workflow must gate notarization on Apple notary credentials.");
  expectAsset(workflow, "DEVELOPER_ID_APPLICATION", "Single-binary release workflow must use a Developer ID identity for public release assets.");
  expectAsset(workflow, "MACOS_CERTIFICATE_P12", "Single-binary release workflow must import a Developer ID certificate.");
  expectAsset(workflow, "security import", "Single-binary release workflow must install the Developer ID certificate in a temporary keychain.");
  expectAsset(workflow, "GH_TOKEN:", "Single-binary release workflow must pass GH_TOKEN for upload.");
  expectAsset(workflow, "github.token", "Single-binary release workflow must use the workflow GitHub token.");
  expectAsset(workflow, "actions/upload-artifact@v7", "Single-binary release workflow must retain workflow artifact copies.");

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
  for (const key of Object.keys(manifestRaw)) {
    if (!PROOF_MANIFEST_ALLOWED_FIELDS.has(key)) {
      issues.push({ path: "manifest.json", code: "manifest_unexpected_field", actual: key });
    }
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
  issues.push(...await validateProofStageIntegrity(proofDir, manifestRaw));

  const proofRoot = resolve(proofDir);
  const manifestShaByPath = new Map<string, string>();
  const invalidArtifactPaths = new Set<string>();
  let sha256sumsContent: string | undefined;
  for (const artifact of manifestRaw["artifacts"]) {
    if (!isRecord(artifact)) {
      issues.push({ path: "<unknown>", code: "artifact_malformed" });
      continue;
    }
    const artifactPath = artifact["path"];
    for (const key of Object.keys(artifact)) {
      if (!PROOF_MANIFEST_ARTIFACT_ALLOWED_FIELDS.has(key)) {
        issues.push({
          path: typeof artifactPath === "string" && artifactPath.length > 0 ? artifactPath : "<unknown>",
          code: "artifact_unexpected_field",
          actual: key,
        });
      }
    }
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
    let artifactInvalid = false;
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      issues.push({ path: artifactPath, code: "artifact_invalid_sha256", expected: "64 lowercase hex characters", actual: expectedSha256 });
      artifactInvalid = true;
    }
    if (expectedBytes < 0) {
      issues.push({ path: artifactPath, code: "artifact_invalid_bytes", expected: "non-negative integer", actual: expectedBytes });
      artifactInvalid = true;
    }
    if (artifactInvalid) {
      invalidArtifactPaths.add(artifactPath);
      continue;
    }
    if (isUnsafeProofArtifactPath(artifactPath)) {
      issues.push({ path: artifactPath, code: "path_outside_proof_dir" });
      invalidArtifactPaths.add(artifactPath);
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

  issues.push(...validateProofComplianceReports(manifestRaw, manifestShaByPath));
  issues.push(...validateProofSha256Sums(manifestShaByPath, sha256sumsContent, invalidArtifactPaths));
  return { ok: issues.length === 0, issues };
}

function isUnsafeProofArtifactPath(artifactPath: string): boolean {
  if (isAbsolute(artifactPath) || /^[A-Za-z]:[\\/]/.test(artifactPath)) return true;
  return artifactPath.split(/[\\/]+/).includes("..");
}

const PROOF_MANIFEST_ALLOWED_FIELDS = new Set([
  "schema_version",
  "kind",
  "osstack_version",
  "run_id",
  "loop_id",
  "agent_id",
  "agent_ids",
  "proof_stage",
  "supersedes",
  "workspace",
  "generated_from",
  "created_at",
  "generated_at",
  "compliance_reports",
  "artifacts",
]);

const PROOF_MANIFEST_SUPERSEDES_ALLOWED_FIELDS = new Set([
  "manifest_path",
  "manifest_sha256",
]);

const PROOF_MANIFEST_ARTIFACT_ALLOWED_FIELDS = new Set([
  "path",
  "sha256",
  "bytes",
]);

const PROOF_MANIFEST_COMPLIANCE_REPORT_ALLOWED_FIELDS = new Set([
  "pack_id",
  "path",
  "certification_claim",
]);

function missingManifestString(manifestRaw: Record<string, unknown>, key: string): boolean {
  const value = manifestRaw[key];
  return typeof value !== "string" || value.trim().length === 0;
}

async function validateProofStageIntegrity(
  proofDir: string,
  manifestRaw: Record<string, unknown>,
): Promise<ProofFileIntegrityIssue[]> {
  const stage = manifestRaw["proof_stage"];
  const supersedes = manifestRaw["supersedes"];
  if (stage !== "candidate" && stage !== "final") {
    return [{
      path: "manifest.json",
      code: "manifest_invalid_proof_stage",
      actual: typeof stage === "string" ? stage : String(stage),
    }];
  }
  if (stage === "candidate") {
    return supersedes === undefined
      ? []
      : [{ path: "manifest.json", code: "manifest_invalid_supersedes" }];
  }
  if (supersedes === undefined) {
    return [{ path: "manifest.json", code: "manifest_missing_supersedes" }];
  }
  if (!isRecord(supersedes)) {
    return [{ path: "manifest.json", code: "manifest_invalid_supersedes" }];
  }
  if (
    Object.keys(supersedes).some(
      (key) => !PROOF_MANIFEST_SUPERSEDES_ALLOWED_FIELDS.has(key),
    )
  ) {
    return [{ path: "manifest.json", code: "manifest_invalid_supersedes" }];
  }
  const manifestPath = supersedes["manifest_path"];
  const expectedSha256 = supersedes["manifest_sha256"];
  if (
    typeof manifestPath !== "string"
    || manifestPath.trim().length === 0
    || manifestPath.includes("\\")
    || isAbsolute(manifestPath)
    || /^[A-Za-z]:[\\/]/.test(manifestPath)
    || typeof expectedSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(expectedSha256)
  ) {
    return [{ path: "manifest.json", code: "manifest_invalid_supersedes" }];
  }

  const proofRoot = resolve(proofDir);
  const releaseRoot = dirname(proofRoot);
  const candidateManifest = resolve(proofRoot, manifestPath);
  const candidateRelativeToRelease = relative(releaseRoot, candidateManifest);
  if (
    candidateManifest === join(proofRoot, "manifest.json")
    || candidateRelativeToRelease.startsWith("..")
    || isAbsolute(candidateRelativeToRelease)
    || candidateManifest !== join(dirname(candidateManifest), "manifest.json")
  ) {
    return [{ path: "manifest.json", code: "manifest_invalid_supersedes" }];
  }

  let candidateContent: Buffer;
  try {
    candidateContent = await readFile(candidateManifest);
  } catch {
    return [{ path: manifestPath, code: "supersedes_manifest_missing" }];
  }
  const actualSha256 = sha256Buffer(candidateContent);
  if (actualSha256 !== expectedSha256) {
    return [{
      path: manifestPath,
      code: "supersedes_sha256_mismatch",
      expected: expectedSha256,
      actual: actualSha256,
    }];
  }

  let candidateRaw: unknown;
  try {
    candidateRaw = JSON.parse(candidateContent.toString("utf-8")) as unknown;
  } catch {
    return [{ path: manifestPath, code: "supersedes_not_candidate" }];
  }
  if (
    !isRecord(candidateRaw)
    || candidateRaw["proof_stage"] !== "candidate"
    || candidateRaw["supersedes"] !== undefined
  ) {
    return [{ path: manifestPath, code: "supersedes_not_candidate" }];
  }
  return [];
}

function validateProofComplianceReports(
  manifestRaw: Record<string, unknown>,
  manifestShaByPath: Map<string, string>,
): ProofFileIntegrityIssue[] {
  const reports = manifestRaw["compliance_reports"];
  if (reports === undefined) return [];
  if (!Array.isArray(reports)) {
    return [{ path: "manifest.json", code: "compliance_report_malformed" }];
  }
  const issues: ProofFileIntegrityIssue[] = [];
  for (const report of reports) {
    if (!isRecord(report)) {
      issues.push({ path: "<unknown>", code: "compliance_report_malformed" });
      continue;
    }
    const reportPath = report["path"];
    const issuePath = typeof reportPath === "string" && reportPath.length > 0 ? reportPath : "<unknown>";
    for (const key of Object.keys(report)) {
      if (!PROOF_MANIFEST_COMPLIANCE_REPORT_ALLOWED_FIELDS.has(key)) {
        issues.push({ path: issuePath, code: "compliance_report_unexpected_field", actual: key });
      }
    }
    if (typeof report["pack_id"] !== "string" || report["pack_id"].trim().length === 0 || typeof reportPath !== "string" || reportPath.length === 0) {
      issues.push({ path: issuePath, code: "compliance_report_malformed" });
      continue;
    }
    if (report["certification_claim"] !== "none") {
      issues.push({ path: issuePath, code: "compliance_report_invalid_certification_claim", expected: "none", actual: String(report["certification_claim"]) });
    }
    if (!manifestShaByPath.has(reportPath)) {
      issues.push({ path: reportPath, code: "compliance_report_missing_artifact" });
    }
  }
  return issues;
}

function validateProofSha256Sums(
  manifestShaByPath: Map<string, string>,
  content: string | undefined,
  ignoredPaths = new Set<string>(),
): ProofFileIntegrityIssue[] {
  if (!manifestShaByPath.has("sha256sums.txt") || content === undefined) {
    return [{ path: "sha256sums.txt", code: "sha256sums_missing" }];
  }
  const issues: ProofFileIntegrityIssue[] = [];
  const sums = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    const checksum = match?.[1];
    const path = match?.[2];
    if (checksum === undefined || path === undefined) {
      issues.push({ path: "sha256sums.txt", code: "sha256sums_malformed" });
      continue;
    }
    if (sums.has(path)) {
      issues.push({ path, code: "sha256sums_duplicate_entry" });
      continue;
    }
    if (isUnsafeProofArtifactPath(path)) {
      issues.push({ path, code: "sha256sums_unsafe_path" });
      continue;
    }
    sums.set(path, checksum);
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
    if (ignoredPaths.has(path)) continue;
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
  const expected = proofArchiveExpectedEntries(manifestRaw);
  if (expected === undefined) {
    return { ok: true, checked: false, proof_zip: proofZip, issues: [] };
  }
  let archiveEntries: Array<{ path: string; content: Buffer }>;
  try {
    archiveEntries = readZipEntries(await readFile(proofZip));
  } catch {
    return {
      ok: false,
      checked: true,
      proof_zip: proofZip,
      issues: [{ path: proofZip, code: "proof_zip_unreadable" }],
    };
  }

  const issues: ProofArchiveIntegrityIssue[] = [];
  const actualEntries = new Map<string, Buffer>();
  for (const { path, content } of archiveEntries) {
    if (isUnsafeProofArtifactPath(path)) {
      issues.push({ path, code: "proof_zip_unsafe_entry" });
      continue;
    }
    if (actualEntries.has(path)) {
      issues.push({ path, code: "proof_zip_duplicate_entry" });
      continue;
    }
    actualEntries.set(path, content);
  }
  for (const path of expected.paths) {
    if (!actualEntries.has(path)) issues.push({ path, code: "proof_zip_missing_entry" });
  }
  for (const path of actualEntries.keys()) {
    if (!expected.paths.has(path)) issues.push({ path, code: "proof_zip_extra_entry" });
  }
  for (const [path, expectedSha256] of expected.shaByPath.entries()) {
    const content = actualEntries.get(path);
    if (content === undefined) continue;
    const actualSha256 = sha256Buffer(content);
    if (actualSha256 !== expectedSha256) {
      issues.push({
        path,
        code: "proof_zip_sha256_mismatch",
        expected: expectedSha256,
        actual: actualSha256,
      });
    }
  }
  return { ok: issues.length === 0, checked: true, proof_zip: proofZip, issues };
}

function readZipEntries(data: Buffer): Array<{ path: string; content: Buffer }> {
  const eocdOffset = findZipEndOfCentralDirectory(data);
  if (eocdOffset < 0 || eocdOffset + 22 > data.length) throw new Error("zip end of central directory not found");
  const entryCount = data.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = data.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = data.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > data.length) throw new Error("zip central directory is outside archive");

  const entries: Array<{ path: string; content: Buffer }> = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("zip central directory entry is malformed");
    }
    const compressionMethod = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const fileNameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localHeaderOffset = data.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > data.length) throw new Error("zip entry name is outside archive");
    const path = data.subarray(nameStart, nameEnd).toString("utf-8");
    const content = readZipEntryContent(data, {
      compressionMethod,
      compressedSize,
      localHeaderOffset,
    });
    entries.push({ path, content });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryContent(
  data: Buffer,
  entry: { compressionMethod: number; compressedSize: number; localHeaderOffset: number },
): Buffer {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("zip local entry header is malformed");
  }
  const localFileNameLength = data.readUInt16LE(localOffset + 26);
  const localExtraLength = data.readUInt16LE(localOffset + 28);
  const contentStart = localOffset + 30 + localFileNameLength + localExtraLength;
  const contentEnd = contentStart + entry.compressedSize;
  if (contentEnd > data.length) throw new Error("zip entry content is outside archive");
  const compressed = data.subarray(contentStart, contentEnd);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method ${entry.compressionMethod}`);
}

function findZipEndOfCentralDirectory(data: Buffer): number {
  if (data.length < 22) return -1;
  const minOffset = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minOffset; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function proofArchiveExpectedEntries(manifestRaw: unknown): { paths: Set<string>; shaByPath: Map<string, string> } | undefined {
  if (!isRecord(manifestRaw) || !Array.isArray(manifestRaw["artifacts"])) return undefined;
  const paths = new Set<string>(["manifest.json"]);
  const shaByPath = new Map<string, string>();
  for (const artifact of manifestRaw["artifacts"]) {
    if (
      !isRecord(artifact)
      || typeof artifact["path"] !== "string"
      || artifact["path"].length === 0
      || typeof artifact["sha256"] !== "string"
      || !/^[a-f0-9]{64}$/.test(artifact["sha256"])
    ) {
      return undefined;
    }
    paths.add(artifact["path"]);
    shaByPath.set(artifact["path"], artifact["sha256"]);
  }
  return { paths, shaByPath };
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
    const runnerBlock = latest.databaseId === undefined
      ? undefined
      : await releaseGitHubActionsRunnerBlock(latest.databaseId);
    if (runnerBlock !== undefined) {
      const allocationFailure = runnerBlock.kind === "allocation";
      return {
        id: "github_actions",
        status: "error",
        message: allocationFailure
          ? "GitHub Actions failed before assigning a runner."
          : "GitHub Actions runner is blocked by account billing or spending limits.",
        details: {
          run_id: latest.databaseId,
          status: latest.status,
          conclusion: latest.conclusion,
          workflow: latest.workflowName,
          title: latest.displayTitle,
          url: latest.url,
          ...(allocationFailure ? { runner_allocation: true } : {}),
          ...(runnerBlock.jobId === undefined ? {} : { job_id: runnerBlock.jobId }),
          annotation: runnerBlock.message,
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

async function releaseGitHubActionsRunnerBlock(runId: number): Promise<{ kind: "billing" | "allocation"; message: string; jobId?: number } | undefined> {
  try {
    const { stdout: jobsOutput } = await execFileAsync("gh", [
      "api",
      `repos/gilosbornhello/osstack/actions/runs/${runId}/jobs`,
    ], { timeout: 10_000 });
    const jobs = JSON.parse(jobsOutput) as {
      jobs?: Array<{
        id?: number;
        conclusion?: string;
        runner_id?: number;
        runner_name?: string;
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
    try {
      const { stdout: annotationsOutput } = await execFileAsync("gh", [
        "api",
        `repos/gilosbornhello/osstack/check-runs/${failedJob.id}/annotations`,
      ], { timeout: 10_000 });
      const annotations = JSON.parse(annotationsOutput) as Array<{ message?: string }>;
      const annotation = annotations.find((item) =>
        typeof item.message === "string"
        && /payments have failed|spending limit/i.test(item.message)
      );
      if (annotation?.message !== undefined) {
        return { kind: "billing", message: annotation.message, jobId: failedJob.id };
      }
    } catch {
      // Fall through to the runner-allocation heuristic below.
    }
    if (failedJob.runner_id === 0 || failedJob.runner_name === "") {
      return {
        kind: "allocation",
        message: "GitHub Actions failed before assigning a runner; the job completed with no steps and no runner identity.",
        jobId: failedJob.id,
      };
    }
    return undefined;
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
  if (value === "allocation") {
    return {
      id: "github_actions",
      status: "error",
      message: "GitHub Actions failed before assigning a runner.",
      details: {
        runner_allocation: true,
        annotation: "GitHub Actions job completed with steps=[] and runner_id=0 / runner_name=\"\".",
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

async function releaseSecretsCheck(
  requiredSecrets: string[],
  options: { alternativeGroups?: string[][] } = {},
): Promise<ReleaseDoctorCheck> {
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
  const alternativeSecrets = new Set((options.alternativeGroups ?? []).flat());
  const missingRequired = requiredSecrets.filter((secret) => !alternativeSecrets.has(secret) && !present.includes(secret));
  const missingAlternativeGroups = (options.alternativeGroups ?? [])
    .filter((group) => !group.some((secret) => present.includes(secret)));
  const missingAlternatives = missingAlternativeGroups.flat();
  const missing = [...missingRequired, ...missingAlternatives];
  const missingDescription = formatMissingReleaseSecrets(missingRequired, missingAlternativeGroups);
  return {
    id: "repository_secrets",
    status: missing.length === 0 ? "ok" : "error",
    message: missing.length === 0
      ? requiredSecrets.length === 0
        ? "No repository secrets are required for this release target."
        : `Required repository secrets are configured: ${requiredSecrets.join(", ")}.`
      : `Missing required repository secrets: ${missingDescription}.`,
    details: {
      required: requiredSecrets,
      present,
      missing,
      ...(options.alternativeGroups === undefined || options.alternativeGroups.length === 0 ? {} : { alternative_groups: options.alternativeGroups }),
      ...(missingAlternativeGroups.length === 0 ? {} : { missing_alternative_groups: missingAlternativeGroups }),
    },
  };
}

function formatMissingReleaseSecrets(missingRequired: string[], missingAlternativeGroups: string[][]): string {
  return [
    ...missingRequired,
    ...missingAlternativeGroups.map((group) => `one of (${group.join(", ")})`),
  ].join(", ");
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

function releaseEdgeOneDeployCredentialCheck(secrets: ReleaseDoctorCheck): ReleaseDoctorCheck {
  const override = process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_CREDENTIAL"] ?? process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"];
  if (override === "ok") {
    return {
      id: "edgeone_deploy_credential",
      status: "ok",
      message: "EdgeOne API token or deploy hook is configured for Knowledge Cloud deploy checks.",
    };
  }
  if (override === "error") {
    return {
      id: "edgeone_deploy_credential",
      status: "error",
      message: "EdgeOne deploy credential check failed.",
    };
  }
  const mode = hasSecret(secrets, "EDGEONE_API_TOKEN")
    ? "cli"
    : hasSecret(secrets, "EDGEONE_DEPLOY_HOOK_URL")
    ? "hook"
    : "missing";
  return {
    id: "edgeone_deploy_credential",
    status: mode === "missing" ? "warn" : "ok",
    message: mode === "cli"
      ? "EdgeOne deployment will use EDGEONE_API_TOKEN with the EdgeOne Makers CLI in GitHub Actions."
      : mode === "hook"
      ? "EdgeOne deployment will use EDGEONE_DEPLOY_HOOK_URL as a fallback in GitHub Actions."
      : "EdgeOne deployment requires EDGEONE_API_TOKEN, or EDGEONE_DEPLOY_HOOK_URL as a fallback.",
    details: { mode },
  };
}

function hasSecret(check: ReleaseDoctorCheck, secret: string): boolean {
  const present = check.details?.["present"];
  return Array.isArray(present) && present.includes(secret);
}

function hasAnySecret(check: ReleaseDoctorCheck, secrets: string[]): boolean {
  return secrets.some((secret) => hasSecret(check, secret));
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
    steps.push(releaseGitHubActionsNextStep(githubActions));
  } else if (githubActions?.status === "warn") {
    steps.push("Confirm GitHub Actions can start workflow jobs before publishing or deploying.");
  }
  const missing = options.secrets.details?.["missing"];
  if (
    Array.isArray(missing)
    && missing.includes("EDGEONE_API_TOKEN")
    && missing.includes("EDGEONE_DEPLOY_HOOK_URL")
  ) {
    steps.push("Add repository secret EDGEONE_API_TOKEN before running Knowledge Cloud deploy=true; EDGEONE_DEPLOY_HOOK_URL remains supported as a fallback.");
  }
  if (Array.isArray(missing) && missing.includes("OSSTACK_KNOWLEDGE_PUBLISH_TOKEN")) {
    steps.push("Add repository secret OSSTACK_KNOWLEDGE_PUBLISH_TOKEN before enabling Knowledge Cloud private publish.");
  }
  const singleBinaryAppleSecretsPresent = SINGLE_BINARY_RELEASE_SECRETS.every((secret) => hasSecret(options.secrets, secret));
  if (releaseTargetIncludesSingleBinary(options.target) && !singleBinaryAppleSecretsPresent) {
    steps.push("Apple notarization secrets are not configured; Single Binary Release can publish an explicitly labeled ad-hoc asset, or add Apple Developer ID secrets and run with notarize=true.");
  }
  const versionPr = options.checks.find((check) => check.id === "version_packages_pr");
  if (releaseTargetIncludesNpm(options.target) && versionPr?.status === "warn") {
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
  if (releaseTargetIncludesNpm(options.target) && npmPublishAssets?.status === "error") {
    steps.push("Restore NPM publish assets before merging the Version Packages PR.");
  }
  const npmPackageBootstrap = options.checks.find((check) => check.id === "npm_package_bootstrap");
  if (releaseTargetIncludesNpm(options.target) && npmPackageBootstrap?.status === "error") {
    const missingPackages = npmPackageBootstrap.details?.["missing"];
    const suffix = Array.isArray(missingPackages) && missingPackages.length > 0
      ? `: ${missingPackages.join(", ")}`
      : "";
    steps.push(`Bootstrap the unpublished npm package(s) manually, then configure release.yml as their Trusted Publisher${suffix}`);
  }
  const npmScopeAccess = options.checks.find((check) => check.id === "npm_scope_access");
  if (releaseTargetIncludesNpm(options.target) && npmScopeAccess?.status === "warn") {
    steps.push("Local npm bootstrap/recovery access is unavailable; this does not block the OIDC Release workflow.");
  }
  const knowledgeDeployAssets = options.checks.find((check) => check.id === "knowledge_cloud_deploy_assets");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeDeployAssets?.status === "error") {
    steps.push("Restore Knowledge Cloud deploy assets before running deploy=true.");
  }
  const knowledgeWorkflow = options.checks.find((check) => check.id === "knowledge_cloud_workflow");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeWorkflow?.status === "error") {
    steps.push("Restore the Knowledge Cloud Deploy workflow before running deploy=true.");
  } else if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeWorkflow?.status === "warn") {
    steps.push("Review the latest Knowledge Cloud Deploy workflow run before running deploy=true.");
  }
  const knowledgeHealth = options.checks.find((check) => check.id === "knowledge_cloud_health");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeHealth?.status === "error") {
    steps.push("Fix the deployed Knowledge Cloud /healthz endpoint before handoff.");
  }
  const knowledgeSearch = options.checks.find((check) => check.id === "knowledge_cloud_search");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeSearch?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud search before handoff.");
  }
  const knowledgeSync = options.checks.find((check) => check.id === "knowledge_cloud_sync");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeSync?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud sync before handoff.");
  }
  const knowledgeAudit = options.checks.find((check) => check.id === "knowledge_cloud_audit");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeAudit?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud audit endpoint before handoff.");
  }
  const knowledgeFeedbackSummary = options.checks.find((check) => check.id === "knowledge_cloud_feedback_summary");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeFeedbackSummary?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud feedback summary before handoff.");
  }
  const knowledgeReviewUi = options.checks.find((check) => check.id === "knowledge_cloud_review_ui");
  if (releaseTargetIncludesKnowledgeCloud(options.target) && knowledgeReviewUi?.status === "error") {
    steps.push("Fix deployed Knowledge Cloud review UI before handoff.");
  }
  const singleBinaryAssets = options.checks.find((check) => check.id === "single_binary_release_assets");
  if (releaseTargetIncludesSingleBinary(options.target) && singleBinaryAssets?.status === "error") {
    steps.push("Restore single-binary release assets before publishing release archives.");
  }
  const singleBinaryWorkflow = options.checks.find((check) => check.id === "single_binary_workflow");
  if (releaseTargetIncludesSingleBinary(options.target) && singleBinaryWorkflow?.status === "error") {
    steps.push("Restore the Single Binary Release workflow before uploading release archives.");
  } else if (releaseTargetIncludesSingleBinary(options.target) && singleBinaryWorkflow?.status === "warn") {
    steps.push("Review the latest Single Binary Release workflow run before uploading release archives.");
  }
  const proofValidation = options.checks.find((check) => check.id === "proof_validation");
  if (proofValidation?.status === "error") {
    steps.push(releaseProofValidationNextStep(proofValidation));
  }
  if (releaseTargetIncludesNpm(options.target) && options.npmPublish) {
    steps.push("NPM publish path is ready for the release workflow.");
  }
  if (releaseTargetIncludesKnowledgeCloud(options.target) && options.knowledgeCloudDeploy) {
    steps.push("Knowledge Cloud deploy=true is ready in GitHub Actions.");
  }
  if (releaseTargetIncludesSingleBinary(options.target) && options.singleBinaryRelease) {
    steps.push("Single-binary GitHub Release asset path is ready.");
  }
  if (steps.length === 0) steps.push("Review failed checks above before publishing.");
  return steps;
}

function releaseGitHubActionsNextStep(check: ReleaseDoctorCheck): string {
  if (check.details?.["runner_allocation"] === true) {
    return "Fix GitHub Actions runner allocation before publishing or deploying.";
  }
  return "Fix GitHub Actions billing or spending limit before publishing or deploying.";
}

function releaseProofValidationNextStep(check: ReleaseDoctorCheck): string {
  const fileIntegrity = check.details?.["file_integrity"];
  const archiveIntegrity = check.details?.["archive_integrity"];
  if (proofIntegrityHasIssuePrefix(fileIntegrity, "compliance_report_")) {
    return "Remove external certification claims and repair compliance report references before publishing or deploying.";
  }
  if (
    (isRecord(fileIntegrity) && fileIntegrity["ok"] === false)
    || (isRecord(archiveIntegrity) && archiveIntegrity["ok"] === false)
  ) {
    return "Regenerate or repair proof pack artifacts before publishing or deploying.";
  }
  return "Fix missing or malformed proof evidence before publishing or deploying.";
}

function proofIntegrityHasIssuePrefix(value: unknown, prefix: string): boolean {
  if (!isRecord(value) || !Array.isArray(value["issues"])) return false;
  return value["issues"].some((issue) =>
    isRecord(issue)
    && typeof issue["code"] === "string"
    && issue["code"].startsWith(prefix)
  );
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
  const blockers = result.next_steps.filter(isReleaseBlockerStep);
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
    ...(blockers.length === 0
      ? []
      : [
        "## Blockers",
        "",
        ...blockers.map((step) => `- ${step}`),
        "",
      ]),
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
  const blockers = result.next_steps.filter(isReleaseBlockerStep);
  const repositorySecrets = result.checks.find((check) => check.id === "repository_secrets");
  const missingSecrets = repositorySecrets?.details?.["missing"];
  const latestVersionPrCiUrl = typeof versionPr?.details?.["latest_ci_url"] === "string"
    ? versionPr.details["latest_ci_url"]
    : undefined;
  const latestVersionPrCiConclusion = versionPr?.details?.["latest_ci_conclusion"];
  const operatorCommands = [
    ...(Array.isArray(missingSecrets)
      && missingSecrets.includes("EDGEONE_API_TOKEN")
      && missingSecrets.includes("EDGEONE_DEPLOY_HOOK_URL")
      ? [
        "gh secret set EDGEONE_API_TOKEN --repo gilosbornhello/osstack --body \"$EDGEONE_API_TOKEN\"",
        "# Optional fallback: gh secret set EDGEONE_DEPLOY_HOOK_URL --repo gilosbornhello/osstack --body \"$EDGEONE_DEPLOY_HOOK_URL\"",
      ]
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
    ...(result.checks.find((check) => check.id === "npm_package_bootstrap")?.status === "error"
      ? [
        "Publish each missing package's first version manually from an authorized npm account.",
        "Configure gilosbornhello/osstack and release.yml as that package's npm Trusted Publisher with publish permission.",
      ]
      : []),
    ...releaseGitHubActionsOperatorCommands(result.checks.find((check) => check.id === "github_actions")),
  ];
  const validationCommands = [
    `osstack release doctor --target ${result.target}${options.proofDir === undefined ? "" : ` --proof-dir ${options.proofDir}`}${options.cloudUrl === undefined ? "" : ` --cloud-url ${options.cloudUrl}`} --output release-readiness.md --json`,
    `osstack proof validate <run_id> --proof-dir ${options.proofDir ?? "release/osstack-proof-<run_id>"} --json`,
    ...(result.target === "all" || result.target === "primary" ? ["pnpm smoke:release-plan"] : []),
    ...(releaseTargetIncludesNpm(result.target)
      ? [
        "pnpm smoke:npm-bootstrap",
        "pnpm preflight:npm-bootstrap",
        "pnpm smoke:npm-trust",
        "pnpm preflight:npm-trust",
        "pnpm smoke:npm-publish-order",
        "pnpm smoke:npm-preflight",
        "pnpm smoke:npm-install",
        versionPrNumber === undefined
          ? "gh pr list --state open --head changeset-release/main --json number,mergeable,mergeStateStatus,statusCheckRollup,url"
          : `gh pr view ${versionPrNumber} --json mergeable,mergeStateStatus,statusCheckRollup,url`,
        "gh run list --branch changeset-release/main --limit 5",
      ]
      : []),
    ...(releaseTargetIncludesKnowledgeCloud(result.target)
      ? [
        "pnpm smoke:knowledge-cloud:deploy",
        "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false",
      ]
      : []),
    ...(releaseTargetIncludesSingleBinary(result.target)
      ? [
        "pnpm smoke:single-binary-release-pack",
        "pnpm smoke:single-binary-release-publish",
        "gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=true -f notarize=false",
      ]
      : []),
  ];
  const publishCommands = [
    ...(!releaseTargetIncludesNpm(result.target) ? [] : [
      ...(versionPrNumber === undefined ? [] : [`gh pr merge ${versionPrNumber} --squash --delete-branch`]),
      "npm install -g @osstack/cli",
      "osstack --version",
      "osstack loop doctor --workspace .",
    ]),
    ...(releaseTargetIncludesSingleBinary(result.target)
      ? ["gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=false -f notarize=false"]
      : []),
  ];
  const knowledgeCloudUrl = options.cloudUrl ?? "https://knowledge.osstack.ai";
  const knowledgeCloudDeployCommand = options.cloudUrl === undefined
    ? "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true"
    : `gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true -f cloud_url=${options.cloudUrl}`;
  const deployCommands = !releaseTargetIncludesKnowledgeCloud(result.target) ? [] : [
    knowledgeCloudDeployCommand,
    `osstack knowledge login --cloud-url ${knowledgeCloudUrl}`,
    `osstack knowledge sync --cloud-url ${knowledgeCloudUrl} --json`,
    `osstack knowledge search "proof pack checksum" --cloud-url ${knowledgeCloudUrl} --json`,
  ];
  const postReleaseValidationCommands = [
    ...(!releaseTargetIncludesNpm(result.target) ? [] : [
      "npm view @osstack/cli version --json",
      "npm install -g @osstack/cli",
      "osstack --version",
      "osstack release doctor --target npm --json",
      "osstack doctor --workspace . --json",
    ]),
    ...(!releaseTargetIncludesKnowledgeCloud(result.target) ? [] : [
      `osstack release doctor --target knowledge-cloud --cloud-url ${knowledgeCloudUrl} --json`,
      `osstack knowledge sync --cloud-url ${knowledgeCloudUrl} --json`,
      `osstack knowledge search "proof pack checksum" --cloud-url ${knowledgeCloudUrl} --json`,
    ]),
    ...(releaseTargetIncludesSingleBinary(result.target)
      ? ["osstack release doctor --target single-binary --json"]
      : []),
    ...(!releaseTargetIncludesSingleBinary(result.target) ? [] : [
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

function isReleaseBlockerStep(step: string): boolean {
  return step.startsWith("Add repository secret")
    || step.startsWith("Refresh GitHub auth")
    || step.startsWith("Fix GitHub Actions")
    || step.startsWith("Add Apple notarization")
    || step.startsWith("Fix missing or malformed proof evidence")
    || step.startsWith("Regenerate or repair proof pack artifacts")
    || step.startsWith("Remove external certification claims")
    || step.startsWith("Restore NPM publish assets")
    || step.startsWith("Bootstrap the unpublished npm package")
    || step.startsWith("Restore Knowledge Cloud deploy assets")
    || step.startsWith("Restore the Knowledge Cloud Deploy workflow")
    || step.startsWith("Fix the deployed Knowledge Cloud")
    || step.startsWith("Fix deployed Knowledge Cloud")
    || step.startsWith("Restore single-binary release assets")
    || step.startsWith("Restore the Single Binary Release workflow")
    || step.startsWith("Review Version Packages PR");
}

function releaseGitHubActionsOperatorCommands(check: ReleaseDoctorCheck | undefined): string[] {
  if (check?.status !== "error") return [];
  if (check.details?.["runner_allocation"] === true) {
    return ["Open GitHub Actions settings/billing and confirm ubuntu-latest jobs can be assigned a runner."];
  }
  return ["Open GitHub Billing & plans and fix failed payments or increase the Actions spending limit."];
}

async function createReleaseHandoffBundle(
  workspacePath: string,
  options: {
    target: ReleaseDoctorResult["target"];
    outputDir: string;
    cloudUrl: string;
    proofDir?: string;
  },
): Promise<ReleaseHandoffBundleSummary> {
  await mkdir(options.outputDir, { recursive: true });
  const doctor = await releaseDoctor(options.target, {
    workspacePath,
    ...(options.proofDir === undefined ? {} : { proofDir: options.proofDir }),
  });
  const plan = releaseActionPlan(doctor, {
    cloudUrl: options.cloudUrl,
    ...(options.proofDir === undefined ? {} : { proofDir: options.proofDir }),
  });
  const status = releaseStatusSummary(doctor, plan);
  const npmSetup = await createNpmPublishSetupSummary(workspacePath);
  const edgeOneSetup = await createEdgeOneSetupSummary(workspacePath, { cloudUrl: options.cloudUrl });
  const files = {
    manifest: join(options.outputDir, "manifest.json"),
    release_status: join(options.outputDir, "release-status.md"),
    release_plan: join(options.outputDir, "release-plan.md"),
    npm_setup: join(options.outputDir, "npm-publish-setup.md"),
    edgeone_setup: join(options.outputDir, "edgeone-setup.md"),
    next_actions: join(options.outputDir, "next-actions.sh"),
  };
  await writeFile(files.release_status, renderReleaseStatusSummary(status), "utf-8");
  await writeFile(files.release_plan, renderReleaseActionPlan(plan), "utf-8");
  await writeFile(files.npm_setup, renderNpmPublishSetupSummary(npmSetup), "utf-8");
  await writeFile(files.edgeone_setup, renderEdgeOneSetupSummary(edgeOneSetup), "utf-8");
  await writeFile(files.next_actions, renderReleaseHandoffNextActionsScript({
    target: options.target,
    cloudUrl: options.cloudUrl,
    plan,
    status,
    npmSetup,
    edgeOneSetup,
  }), "utf-8");
  await chmod(files.next_actions, 0o755);
  const summary: ReleaseHandoffBundleSummary = {
    kind: "osstack-release-handoff",
    target: options.target,
    output_dir: options.outputDir,
    cloud_url: options.cloudUrl,
    required_secrets: releaseHandoffRequiredSecrets(options.target),
    alternative_secret_groups: releaseHandoffAlternativeSecretGroups(options.target),
    files,
    external_blockers: status.external_blockers,
    next_actions: status.next_actions,
  };
  await writeFile(files.manifest, JSON.stringify({
    kind: summary.kind,
    target: summary.target,
    cloud_url: summary.cloud_url,
    required_secrets: summary.required_secrets,
    alternative_secret_groups: summary.alternative_secret_groups,
    files: {
      release_status: "release-status.md",
      release_plan: "release-plan.md",
      npm_setup: "npm-publish-setup.md",
      edgeone_setup: "edgeone-setup.md",
      next_actions: "next-actions.sh",
    },
    external_blockers: summary.external_blockers,
    next_actions: summary.next_actions,
  }, null, 2), "utf-8");
  return summary;
}

function renderReleaseHandoffNextActionsScript(input: {
  target: ReleaseDoctorResult["target"];
  cloudUrl: string;
  plan: ReleaseActionPlan;
  status: ReleaseStatusSummary;
  npmSetup: NpmPublishSetupSummary;
  edgeOneSetup: EdgeOneSetupSummary;
}): string {
  const manualSteps = uniqueStrings([
    ...input.npmSetup.console_checklist,
    ...input.edgeOneSetup.console_checklist,
    ...input.status.external_blockers,
  ]);
  const secretCommands = uniqueStrings([
    ...input.npmSetup.github_commands,
    ...input.edgeOneSetup.github_commands.filter(isGitHubSecretCommand),
    ...input.status.next_actions.operator.filter((command) => command.startsWith("gh secret set ")),
  ]);
  const workflowCommands = uniqueStrings([
    ...input.npmSetup.workflow_commands,
    ...input.edgeOneSetup.github_commands.filter((command) => !isGitHubSecretCommand(command)),
    ...input.edgeOneSetup.workflow_commands,
    ...input.plan.deploy_commands,
  ]);
  const allValidationCommands = uniqueStrings([
    ...input.npmSetup.validation_commands,
    ...input.edgeOneSetup.validation_commands,
    ...input.plan.validation_commands,
  ]);
  const localValidationCommands = allValidationCommands.filter((command) =>
    !isGitHubReadOnlyCommand(command) && !isRemoteWorkflowCommand(command)
  );
  const readOnlyCommands = uniqueStrings([
    ...allValidationCommands.filter(isGitHubReadOnlyCommand),
    ...workflowCommands.filter(isGitHubReadOnlyCommand),
  ]);
  const remoteWorkflowCommands = uniqueStrings([
    ...allValidationCommands.filter(isRemoteWorkflowCommand),
    ...workflowCommands.filter(isRemoteWorkflowCommand),
  ]);
  const deployCommands = workflowCommands.filter((command) =>
    !isGitHubReadOnlyCommand(command) && !isRemoteWorkflowCommand(command)
  );
  const publishCommands = uniqueStrings(input.plan.publish_commands);
  const postReleaseValidationCommands = uniqueStrings([
    ...input.npmSetup.post_release_validation_commands,
    ...input.plan.post_release_validation_commands,
  ]);

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "cat <<'OSSTACK_RELEASE_NEXT_ACTIONS'",
    "# Osstack Release Next Actions",
    "",
    "This script prints the operator checklist only.",
    "It does not execute secret writes, npm publishing, EdgeOne deployment, or validation commands.",
    "Remote workflow commands consume GitHub Actions minutes.",
    "Use local validation first, then trigger one remote workflow only when ready.",
    "If a workflow was started by mistake, cancel it with: gh run cancel <run-id> --repo gilosbornhello/osstack",
    "",
    `Target: ${input.target}`,
    `Cloud URL: ${input.cloudUrl}`,
    `Safe to execute publish/deploy commands now: ${input.plan.safe_to_execute ? "yes" : "no"}`,
    "",
    "## Manual Console Steps",
    "",
    ...renderPlainChecklist(manualSteps),
    "",
    "## GitHub Secret Commands",
    "",
    ...renderPlainChecklist(secretCommands),
    "",
    "## Local Validation Commands",
    "",
    ...renderPlainChecklist(localValidationCommands),
    "",
    "## GitHub Read-Only Commands",
    "",
    "These commands inspect GitHub state and do not start workflow jobs.",
    "",
    ...renderPlainChecklist(readOnlyCommands),
    "",
    "## Publish Commands",
    "",
    ...renderPlainChecklist(publishCommands),
    "",
    "## Remote Workflow Commands",
    "",
    "Commands in this section can consume GitHub Actions minutes.",
    "",
    ...renderPlainChecklist(remoteWorkflowCommands),
    "",
    "## EdgeOne Runtime Commands",
    "",
    ...renderPlainChecklist(deployCommands),
    "",
    "## Post-Release Validation Commands",
    "",
    ...renderPlainChecklist(postReleaseValidationCommands),
    "",
    "OSSTACK_RELEASE_NEXT_ACTIONS",
    "",
  ].join("\n");
}

function renderPlainChecklist(items: string[]): string[] {
  return items.length === 0 ? ["- None."] : items.map((item) => `- ${item}`);
}

function isGitHubReadOnlyCommand(command: string): boolean {
  return command.startsWith("gh pr list ")
    || command.startsWith("gh pr view ")
    || command.startsWith("gh run list ")
    || command.startsWith("gh run view ");
}

function isRemoteWorkflowCommand(command: string): boolean {
  return command.startsWith("gh workflow run ")
    || command.startsWith("gh run rerun ");
}

function isGitHubSecretCommand(command: string): boolean {
  return command.startsWith("gh secret set ")
    || command.includes(" gh secret set ");
}

function releaseHandoffRequiredSecrets(target: ReleaseDoctorResult["target"]): string[] {
  return [
    ...(releaseTargetIncludesSingleBinary(target) ? SINGLE_BINARY_RELEASE_SECRETS : []),
  ];
}

function releaseHandoffAlternativeSecretGroups(target: ReleaseDoctorResult["target"]): string[][] {
  return [
    ...(releaseTargetIncludesKnowledgeCloud(target)
      ? [["EDGEONE_API_TOKEN", "EDGEONE_DEPLOY_HOOK_URL"]]
      : []),
  ];
}

function renderReleaseHandoffBundleSummary(handoff: ReleaseHandoffBundleSummary): string {
  return [
    "# Osstack Release Handoff",
    "",
    `Target: \`${handoff.target}\``,
    `Output directory: \`${handoff.output_dir}\``,
    `Cloud URL: \`${handoff.cloud_url}\``,
    "",
    "## Files",
    "",
    ...Object.entries(handoff.files).map(([key, value]) => `- ${key}: \`${value}\``),
    "",
    "## Required Secrets",
    "",
    ...(handoff.required_secrets.length === 0
      ? ["No hard-required repository secrets for this target."]
      : handoff.required_secrets.map((secret) => `- \`${secret}\``)),
    "",
    "## Alternative Secret Groups",
    "",
    ...(handoff.alternative_secret_groups.length === 0
      ? ["No alternative secret groups for this target."]
      : handoff.alternative_secret_groups.map((group) => `- One of: ${group.map((secret) => `\`${secret}\``).join(", ")}`)),
    "",
    "## External Blockers",
    "",
    ...(handoff.external_blockers.length === 0
      ? ["No external blockers detected."]
      : handoff.external_blockers.map((blocker) => `- ${blocker}`)),
    "",
  ].join("\n");
}

async function createNpmPublishSetupSummary(workspacePath: string): Promise<NpmPublishSetupSummary> {
  const assetRoot = await findReleaseAssetRoot(workspacePath);
  const packagePath = join(assetRoot, "packages/cli/package.json");
  const packageSummary = parseNpmPackageSummary(await readFile(packagePath, "utf-8"), packagePath);
  const scope = packageSummary.name.startsWith("@") ? packageSummary.name.split("/")[0] ?? "@osstack" : "@osstack";
  const repository = packageSummary.repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  return {
    scope,
    package_name: packageSummary.name,
    repository,
    authentication: "trusted-publishing-oidc",
    required_secret: null,
    publish_access: packageSummary.publishAccess,
    console_checklist: [
      "Sign in to npmjs.com with an account that can administer every public @osstack package.",
      `Create or claim the ${scope} organization/scope on npmjs.com.`,
      "Manually publish the first version of any new public package because a Trusted Publisher can be configured only after the package exists.",
      `For every public package, configure GitHub Actions Trusted Publisher ${repository} / release.yml with publish permission.`,
      `Confirm ${packageSummary.name} uses public access before publishing.`,
      "After one successful OIDC release, set publishing access to require 2FA and disallow tokens where operationally appropriate.",
      "Use local npm login/token access only for first-package bootstrap or manual recovery; never expose it to the Release publish step.",
      "Run pnpm preflight:npm-trust in an interactive terminal and complete npm's fresh 2FA/web authentication to verify every package mapping.",
      "Rerun the Release workflow only after the package bootstrap and install gates pass.",
    ],
    github_commands: [],
    workflow_commands: [
      "gh run list --workflow Release --branch main --limit 5",
      `gh run rerun <failed-release-run-id> --repo ${repository}`,
    ],
    validation_commands: [
      "pnpm smoke:npm-bootstrap",
      "pnpm preflight:npm-bootstrap",
      "pnpm smoke:npm-trust",
      "pnpm preflight:npm-trust",
      "pnpm smoke:npm-publish-order",
      "pnpm smoke:npm-preflight",
      "osstack release doctor --target npm --json",
    ],
    post_release_validation_commands: [
      `npm view ${packageSummary.name} version --json`,
      `npm install -g ${packageSummary.name}`,
      "osstack --version",
      "osstack loop doctor --workspace . --json",
    ],
  };
}

function parseNpmPackageSummary(raw: string, packagePath: string): {
  name: string;
  publishAccess: string;
  repository: string;
} {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`npm package metadata must be a JSON object: ${packagePath}`);
  const name = requiredString(parsed, "name", packagePath);
  const publishConfig = parsed["publishConfig"];
  const repository = parsed["repository"];
  let repositoryUrl = "https://github.com/gilosbornhello/osstack.git";
  if (isRecord(repository) && typeof repository["url"] === "string" && repository["url"].length > 0) {
    repositoryUrl = repository["url"];
  } else if (typeof repository === "string" && repository.length > 0) {
    repositoryUrl = repository;
  }
  return {
    name,
    publishAccess: isRecord(publishConfig) && typeof publishConfig["access"] === "string"
      ? publishConfig["access"]
      : "public",
    repository: repositoryUrl,
  };
}

function renderNpmPublishSetupSummary(setup: NpmPublishSetupSummary): string {
  return [
    "# NPM Publish Setup",
    "",
    `Scope: \`${setup.scope}\``,
    `Package: \`${setup.package_name}\``,
    `Repository: \`${setup.repository}\``,
    `Authentication: \`${setup.authentication}\``,
    `Required long-lived publish secret: \`${setup.required_secret ?? "none"}\``,
    `Publish access: \`${setup.publish_access}\``,
    "",
    "## Official References",
    "",
    "- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/",
    "- npm trust command: https://docs.npmjs.com/cli/v11/commands/npm-trust/",
    "- npm scoped public package docs: https://docs.npmjs.com/creating-and-publishing-scoped-public-packages",
    "- npm organization package access docs: https://docs.npmjs.com/managing-team-access-to-organization-packages",
    "",
    "## Console Checklist",
    "",
    ...setup.console_checklist.map((item) => `- ${item}`),
    "",
    "## GitHub Commands",
    "",
    ...(setup.github_commands.length === 0
      ? ["No repository secret command is required for npm publishing."]
      : setup.github_commands.map((command) => `- \`${command}\``)),
    "",
    "## Workflow Commands",
    "",
    ...setup.workflow_commands.map((command) => `- \`${command}\``),
    "",
    "## Validation Commands",
    "",
    ...setup.validation_commands.map((command) => `- \`${command}\``),
    "",
    "## Post-Release Validation Commands",
    "",
    ...setup.post_release_validation_commands.map((command) => `- \`${command}\``),
    "",
  ].join("\n");
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

async function createEdgeOneSetupSummary(
  workspacePath: string,
  options: { cloudUrl?: string } = {},
): Promise<EdgeOneSetupSummary> {
  const assetRoot = await findReleaseAssetRoot(workspacePath);
  const manifestPath = join(assetRoot, "deploy/knowledge-cloud/edgeone.json");
  const manifest = parseEdgeOneManifest(await readFile(manifestPath, "utf-8"), manifestPath);
  const cloudUrl = options.cloudUrl ?? `https://${manifest.default_domain}`;
  return {
    provider: manifest.provider,
    service: manifest.service,
    default_domain: manifest.default_domain,
    healthcheck_path: manifest.healthcheck_path,
    runtime: manifest.runtime,
    deploy_secret: manifest.deploy_secret,
    ...(manifest.fallback_deploy_secret === undefined ? {} : { fallback_deploy_secret: manifest.fallback_deploy_secret }),
    project_name: manifest.project_name,
    environment: manifest.environment,
    kv_bindings: manifest.kv_bindings,
    include_files: manifest.include_files,
    console_checklist: [
      "Create an EdgeOne Pages project connected to gilosbornhello/osstack.",
      "Configure the EdgeOne project to build from main.",
      `Use ${relative(assetRoot, manifestPath)} as the source of truth for runtime, healthcheck, storage paths, and official pack include paths.`,
      ...Object.entries(manifest.environment).map(([key, value]) => `Set EdgeOne runtime env ${key}=${value}.`),
      ...manifest.kv_bindings.map((binding) => `Create or select an EdgeOne KV namespace and bind it to the Function variable ${binding}.`),
      `Create an EdgeOne API token for Makers project ${manifest.project_name} and keep it private.`,
      ...(manifest.fallback_deploy_secret === undefined ? [] : ["Optionally create an EdgeOne deploy hook as a fallback and keep the hook URL private."]),
      `Record the production URL, expected default domain ${manifest.default_domain}, and health path ${manifest.healthcheck_path}.`,
    ],
    github_commands: [
      `gh secret set ${manifest.deploy_secret} --repo gilosbornhello/osstack --body "$${manifest.deploy_secret}"`,
      ...(manifest.fallback_deploy_secret === undefined
        ? []
        : [`# Optional fallback: gh secret set ${manifest.fallback_deploy_secret} --repo gilosbornhello/osstack --body "$${manifest.fallback_deploy_secret}"`]),
    ],
    workflow_commands: [
      "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false",
      `gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true -f cloud_url=${cloudUrl}`,
    ],
    validation_commands: [
      `osstack release doctor --target knowledge-cloud --cloud-url ${cloudUrl} --json`,
      `osstack knowledge sync --cloud-url ${cloudUrl} --json`,
      `osstack knowledge search "proof pack checksum" --cloud-url ${cloudUrl} --json`,
    ],
  };
}

function parseEdgeOneManifest(raw: string, manifestPath: string): {
  provider: string;
  service: string;
  default_domain: string;
  healthcheck_path: string;
  runtime: EdgeOneSetupSummary["runtime"];
  deploy_secret: string;
  fallback_deploy_secret?: string;
  project_name: string;
  environment: Record<string, string>;
  kv_bindings: string[];
  include_files: string[];
} {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`EdgeOne manifest must be a JSON object: ${manifestPath}`);
  const deployment = parsed["deployment"];
  const runtime = parsed["runtime"];
  const environment = parsed["environment"];
  const provider = requiredString(parsed, "provider", manifestPath);
  const service = requiredString(parsed, "service", manifestPath);
  const deploySecret = requiredString(parsed, "deploy_secret", manifestPath);
  const fallbackDeploySecret = optionalString(parsed, "fallback_deploy_secret", manifestPath);
  const projectName = requiredString(parsed, "project_name", manifestPath);
  if (!isRecord(deployment)) throw new Error(`EdgeOne manifest deployment must be an object: ${manifestPath}`);
  if (!isRecord(runtime)) throw new Error(`EdgeOne manifest runtime must be an object: ${manifestPath}`);
  if (!isRecord(environment)) throw new Error(`EdgeOne manifest environment must be an object: ${manifestPath}`);
  return {
    provider,
    service,
    default_domain: requiredString(deployment, "default_domain", manifestPath),
    healthcheck_path: requiredString(deployment, "healthcheck_path", manifestPath),
    runtime: {
      node: requiredString(runtime, "node", manifestPath),
      port: requiredNumber(runtime, "port", manifestPath),
      entry: requiredString(runtime, "entry", manifestPath),
    },
    deploy_secret: deploySecret,
    ...(fallbackDeploySecret === undefined ? {} : { fallback_deploy_secret: fallbackDeploySecret }),
    project_name: projectName,
    environment: stringRecord(environment, "environment", manifestPath),
    kv_bindings: stringArray(parsed["kv_bindings"] ?? [], "kv_bindings", manifestPath),
    include_files: stringArray(parsed["includeFiles"], "includeFiles", manifestPath),
  };
}

function requiredString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${source} missing string field ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, source: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${source} field ${key} must be a non-empty string when present`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, source: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`${source} missing numeric field ${key}`);
  return value;
}

function stringRecord(record: Record<string, unknown>, key: string, source: string): Record<string, string> {
  const entries = Object.entries(record).map(([entryKey, entryValue]) => {
    if (typeof entryValue !== "string") throw new Error(`${source} ${key}.${entryKey} must be a string`);
    return [entryKey, entryValue] as const;
  });
  return Object.fromEntries(entries);
}

function stringArray(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${source} ${key} must be a string array`);
  }
  return value;
}

function renderEdgeOneSetupSummary(setup: EdgeOneSetupSummary): string {
  return [
    "# EdgeOne Knowledge Cloud Setup",
    "",
    `Provider: \`${setup.provider}\``,
    `Service: \`${setup.service}\``,
    `Project: \`${setup.project_name}\``,
    `Default domain: \`${setup.default_domain}\``,
    `Healthcheck: \`${setup.healthcheck_path}\``,
    `Deploy secret: \`${setup.deploy_secret}\``,
    ...(setup.fallback_deploy_secret === undefined ? [] : [`Fallback deploy secret: \`${setup.fallback_deploy_secret}\``]),
    "",
    "## Official References",
    "",
    "- EdgeOne CLI docs: https://pages.edgeone.ai/document/edgeone-cli",
    "- EdgeOne API token guide: https://pages.edgeone.ai/document/api-token",
    "",
    "## Runtime",
    "",
    `- Node: \`${setup.runtime.node}\``,
    `- Port: \`${setup.runtime.port}\``,
    `- Entry: \`${setup.runtime.entry}\``,
    "",
    "## Environment",
    "",
    ...Object.entries(setup.environment).map(([key, value]) => `- \`${key}=${value}\``),
    "",
    "## KV Bindings",
    "",
    ...(setup.kv_bindings.length === 0 ? ["No KV bindings declared."] : setup.kv_bindings.map((binding) => `- \`${binding}\``)),
    "",
    "## Include Files",
    "",
    ...setup.include_files.map((path) => `- \`${path}\``),
    "",
    "## Console Checklist",
    "",
    ...setup.console_checklist.map((item) => `- ${item}`),
    "",
    "## GitHub Commands",
    "",
    ...setup.github_commands.map((command) => `- \`${command}\``),
    "",
    "## Workflow Commands",
    "",
    ...setup.workflow_commands.map((command) => `- \`${command}\``),
    "",
    "## Validation Commands",
    "",
    ...setup.validation_commands.map((command) => `- \`${command}\``),
    "",
  ].join("\n");
}

function releaseStatusSummary(result: ReleaseDoctorResult, plan: ReleaseActionPlan): ReleaseStatusSummary {
  const externalBlockers = uniqueStrings([
    ...plan.blockers,
    ...result.next_steps.filter(isExternalReleaseBlockerStep),
  ]);
  const actionCommands = uniqueStrings([
    ...plan.validation_commands,
    ...plan.deploy_commands,
  ]);
  return {
    target: result.target,
    ready: result.ok,
    completion: {
      code_verified: releaseCodeVerified(result.checks),
      npm_publish: result.readiness.npm_publish,
      knowledge_cloud_deploy: result.readiness.knowledge_cloud_deploy,
      single_binary_release: result.readiness.single_binary_release,
    },
    external_blockers: externalBlockers,
    checks: result.checks.map((check) => ({
      id: check.id,
      status: check.status,
      message: check.message,
    })),
    next_actions: {
      operator: plan.operator_commands,
      validation: plan.validation_commands,
      github_readonly: actionCommands.filter(isGitHubReadOnlyCommand),
      remote_workflow: actionCommands.filter(isRemoteWorkflowCommand),
      publish: plan.publish_commands,
      deploy: plan.deploy_commands,
      post_release_validation: plan.post_release_validation_commands,
    },
  };
}

function releaseCodeVerified(checks: ReleaseDoctorCheck[]): boolean {
  const codeGateIds = new Set([
    "github_actions",
    "npm_publish_assets",
    "knowledge_cloud_deploy_assets",
    "knowledge_cloud_workflow",
    "single_binary_release_assets",
    "single_binary_workflow",
    "proof_validation",
  ]);
  return checks
    .filter((check) => codeGateIds.has(check.id))
    .every((check) => check.status !== "error");
}

function isExternalReleaseBlockerStep(step: string): boolean {
  return step.startsWith("Add repository secret")
    || step.startsWith("Add Apple notarization")
    || step.startsWith("Bootstrap the unpublished npm package")
    || step.startsWith("Fix GitHub Actions")
    || step.startsWith("Refresh GitHub auth");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function renderReleaseStatusSummary(status: ReleaseStatusSummary): string {
  return [
    "# Osstack Release Status",
    "",
    `Target: \`${status.target}\``,
    `Ready: \`${status.ready ? "yes" : "no"}\``,
    "",
    "## Completion",
    "",
    "| Area | Status |",
    "|---|---|",
    `| code_verified | ${status.completion.code_verified ? "ready" : "not_ready"} |`,
    `| npm_publish | ${status.completion.npm_publish ? "ready" : "not_ready"} |`,
    `| knowledge_cloud_deploy | ${status.completion.knowledge_cloud_deploy ? "ready" : "not_ready"} |`,
    `| single_binary_release | ${status.completion.single_binary_release ? "ready" : "not_ready"} |`,
    "",
    "## External Blockers",
    "",
    ...(status.external_blockers.length === 0
      ? ["No external release blockers detected."]
      : status.external_blockers.map((blocker) => `- ${blocker}`)),
    "",
    "## Checks",
    "",
    "| Check | Status | Message |",
    "|---|---|---|",
    ...status.checks.map((check) =>
      `| ${markdownCell(check.id)} | ${check.status} | ${markdownCell(check.message)} |`
    ),
    "",
    "## Next Actions",
    "",
    "### Operator",
    "",
    ...renderCommandList(status.next_actions.operator),
    "",
    "### Validation",
    "",
    ...renderCommandList(status.next_actions.validation),
    "",
    "### GitHub Read-Only",
    "",
    "These commands inspect GitHub state and do not start workflow jobs.",
    "",
    ...renderCommandList(status.next_actions.github_readonly),
    "",
    "### Remote Workflow",
    "",
    "These commands can consume GitHub Actions minutes.",
    "",
    ...renderCommandList(status.next_actions.remote_workflow),
    "",
    "### Publish",
    "",
    ...renderCommandList(status.next_actions.publish),
    "",
    "### Deploy",
    "",
    ...renderCommandList(status.next_actions.deploy),
    "",
    "### Post-Release Validation",
    "",
    ...renderCommandList(status.next_actions.post_release_validation),
    "",
  ].join("\n");
}

function renderCommandList(commands: string[]): string[] {
  if (commands.length === 0) return ["No actions required."];
  return commands.map((command) => command.startsWith("http") ? `- ${command}` : `- \`${command}\``);
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
  osstack checkpoint restore <checkpoint_id|dir> [--workspace P] [--apply] [--json]

Checkpoints are written under $OSSTACK_HOME/checkpoints and never inside .git.
Restore is a dry-run unless --apply is passed, and only writes files listed in
the checkpoint metadata.
`);
    return 0;
  }
  if (sub === "restore" || sub === "rewind") {
    const ref = args[1];
    if (ref === undefined || ref.startsWith("-")) {
      console.error("osstack: checkpoint restore requires a checkpoint id or directory");
      return 1;
    }
    const workspaceOverride = flagValue(args, "--workspace");
    const restoreOptions: { workspace?: string; apply: boolean } = { apply: args.includes("--apply") };
    if (workspaceOverride !== undefined) restoreOptions.workspace = workspaceOverride;
    const result = await restoreShadowCheckpoint(ref, restoreOptions);
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`checkpoint=${result.checkpoint_id}`);
      console.log(`workspace=${result.workspace}`);
      console.log(`mode=${result.mode}`);
      console.log(`restored=${result.restored_files} bytes=${result.bytes}`);
      if (result.mode === "dry-run") console.log("pass --apply to write these files");
    }
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

interface ShadowCheckpointRestoreSummary {
  checkpoint_id: string;
  checkpoint_dir: string;
  metadata_path: string;
  workspace: string;
  mode: "dry-run" | "applied";
  restored_files: number;
  bytes: number;
  files: Array<{ path: string; sha256: string; bytes: number; target: string }>;
}

interface ShadowCheckpointMetadata {
  kind: "osstack.shadow_checkpoint";
  version: number;
  checkpoint_id: string;
  workspace: string;
  files_root: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

/**
 * Directories a shadow checkpoint never copies.
 *
 * Checkpoints are a safety net for source edits, so reproducible build output,
 * virtualenvs and caches are pure waste — and expensive waste: with only
 * .git/node_modules/.osstack excluded, one checkpoint of a Python+build
 * workspace weighed 14 GB, and 109 unpruned checkpoints filled the disk until
 * the daemon drained itself (2026-08-13).
 */
const CHECKPOINT_EXCLUSIONS = [
  ".git", "node_modules", ".osstack",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
  ".next", ".turbo", ".cache", ".gradle",
] as const;

/**
 * Names that are build output at the workspace root but are perfectly ordinary
 * source directories deeper in a tree (`src/app/build/`, `lib/out/`). Excluding
 * them at every depth would silently drop real files from a restore safety net,
 * so they are only skipped at the top level.
 */
const CHECKPOINT_ROOT_ONLY_EXCLUSIONS = ["dist", "build", "target", "out"] as const;

/** Newest N checkpoints kept by createShadowCheckpoint; older ones are pruned. */
const CHECKPOINTS_TO_KEEP = 20;

/**
 * Delete all but the newest CHECKPOINTS_TO_KEEP checkpoints. Ids are
 * `chk_<UTC timestamp>_<uuid>`, so lexicographic order is chronological —
 * the same prune shape backupStateDb uses for state.db snapshots.
 */
async function pruneShadowCheckpoints(checkpointsRoot: string): Promise<void> {
  let ids: string[];
  try {
    ids = (await readdir(checkpointsRoot)).filter((name) => name.startsWith("chk_")).sort();
  } catch {
    return; // no checkpoints directory yet
  }
  for (const id of ids.slice(0, Math.max(0, ids.length - CHECKPOINTS_TO_KEEP))) {
    try {
      await rm(join(checkpointsRoot, id), { recursive: true, force: true });
    } catch { /* best effort — never fail a checkpoint over cleanup */ }
  }
}

async function createShadowCheckpoint(workspacePath: string): Promise<ShadowCheckpointSummary> {
  const workspaceStat = await stat(workspacePath);
  if (!workspaceStat.isDirectory()) throw new Error(`workspace is not a directory: ${workspacePath}`);
  const checkpointId = `chk_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const checkpointDir = join(osstackHome(), "checkpoints", checkpointId);
  const filesDir = join(checkpointDir, "files");
  const exclusions = [...CHECKPOINT_EXCLUSIONS];
  const rootOnlyExclusions = [...CHECKPOINT_ROOT_ONLY_EXCLUSIONS];
  const entries = await collectCheckpointFiles(
    workspacePath,
    workspacePath,
    new Set(exclusions),
    new Set(rootOnlyExclusions),
  );
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
    root_only_exclusions: rootOnlyExclusions,
    notes: [
      "Shadow checkpoints are stored outside the workspace and do not write to .git.",
      "Restore is dry-run by default and only writes files listed in this metadata.",
    ],
  };
  const metadataPath = join(checkpointDir, "metadata.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  await pruneShadowCheckpoints(join(osstackHome(), "checkpoints"));
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
  rootOnlyExcludedNames: ReadonlySet<string> = new Set(),
): Promise<Array<{ sourcePath: string; relativePath: string; sha256: string; bytes: number }>> {
  const dirents = await readdir(current, { withFileTypes: true });
  const atRoot = current === root;
  const files: Array<{ sourcePath: string; relativePath: string; sha256: string; bytes: number }> = [];
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (excludedNames.has(dirent.name)) continue;
    if (atRoot && rootOnlyExcludedNames.has(dirent.name)) continue;
    const sourcePath = join(current, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...await collectCheckpointFiles(root, sourcePath, excludedNames, rootOnlyExcludedNames));
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

async function restoreShadowCheckpoint(
  checkpointRef: string,
  options: { workspace?: string; apply: boolean },
): Promise<ShadowCheckpointRestoreSummary> {
  const checkpointDir = await resolveCheckpointDir(checkpointRef);
  const metadataPath = join(checkpointDir, "metadata.json");
  const metadata = parseShadowCheckpointMetadata(JSON.parse(await readFile(metadataPath, "utf-8")) as unknown, metadataPath);
  const workspace = realpathSync(options.workspace ?? metadata.workspace);
  const filesRoot = realpathSync(resolve(checkpointDir, "files"));
  if (realpathSync(metadata.files_root) !== filesRoot) {
    throw new Error(`checkpoint files_root must point to its files directory: ${metadataPath}`);
  }
  const restored: ShadowCheckpointRestoreSummary["files"] = [];
  let totalBytes = 0;
  for (const file of metadata.files) {
    const source = safeJoin(filesRoot, file.path);
    const target = safeJoin(workspace, file.path);
    const content = await readFile(source);
    const actualSha256 = sha256Buffer(content);
    if (actualSha256 !== file.sha256) {
      throw new Error(`checkpoint file sha256 mismatch: ${file.path}`);
    }
    if (content.byteLength !== file.bytes) {
      throw new Error(`checkpoint file size mismatch: ${file.path}`);
    }
    if (options.apply) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    totalBytes += content.byteLength;
    restored.push({ path: file.path, sha256: file.sha256, bytes: file.bytes, target });
  }
  return {
    checkpoint_id: metadata.checkpoint_id,
    checkpoint_dir: checkpointDir,
    metadata_path: metadataPath,
    workspace,
    mode: options.apply ? "applied" : "dry-run",
    restored_files: restored.length,
    bytes: totalBytes,
    files: restored,
  };
}

async function resolveCheckpointDir(checkpointRef: string): Promise<string> {
  const candidate = isAbsolute(checkpointRef) || checkpointRef.includes("/")
    ? resolve(checkpointRef)
    : join(osstackHome(), "checkpoints", checkpointRef);
  const checkpointStat = await stat(candidate);
  if (!checkpointStat.isDirectory()) throw new Error(`checkpoint is not a directory: ${candidate}`);
  return realpathSync(candidate);
}

function parseShadowCheckpointMetadata(value: unknown, metadataPath: string): ShadowCheckpointMetadata {
  if (!isRecord(value)) throw new Error(`checkpoint metadata must be an object: ${metadataPath}`);
  if (value["kind"] !== "osstack.shadow_checkpoint") throw new Error(`unsupported checkpoint kind: ${metadataPath}`);
  const version = value["version"];
  if (version !== 1) throw new Error(`unsupported checkpoint metadata version: ${String(version)}`);
  const checkpointId = value["checkpoint_id"];
  const workspace = value["workspace"];
  const filesRoot = value["files_root"];
  const files = value["files"];
  if (typeof checkpointId !== "string" || checkpointId.length === 0) throw new Error("checkpoint metadata missing checkpoint_id");
  if (typeof workspace !== "string" || workspace.length === 0) throw new Error("checkpoint metadata missing workspace");
  if (typeof filesRoot !== "string" || filesRoot.length === 0) throw new Error("checkpoint metadata missing files_root");
  if (!Array.isArray(files)) throw new Error("checkpoint metadata files must be an array");
  return {
    kind: "osstack.shadow_checkpoint",
    version,
    checkpoint_id: checkpointId,
    workspace,
    files_root: filesRoot,
    files: files.map((file, index) => parseCheckpointMetadataFile(file, index)),
  };
}

function parseCheckpointMetadataFile(value: unknown, index: number): { path: string; sha256: string; bytes: number } {
  if (!isRecord(value)) throw new Error(`checkpoint metadata files[${index}] must be an object`);
  const path = value["path"];
  const sha256Value = value["sha256"];
  const bytes = value["bytes"];
  if (typeof path !== "string" || path.length === 0) throw new Error(`checkpoint metadata files[${index}].path is required`);
  assertSafeRelativePath(path);
  if (typeof sha256Value !== "string" || !/^[a-f0-9]{64}$/.test(sha256Value)) {
    throw new Error(`checkpoint metadata files[${index}].sha256 must be a 64-character lowercase hex checksum`);
  }
  if (!Number.isInteger(bytes) || typeof bytes !== "number" || bytes < 0) {
    throw new Error(`checkpoint metadata files[${index}].bytes must be a non-negative integer`);
  }
  return { path, sha256: sha256Value, bytes };
}

function safeJoin(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`unsafe checkpoint path: ${relativePath}`);
  }
  return resolvedPath;
}

function assertSafeRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new Error(`unsafe checkpoint path: ${path}`);
  }
}

async function handleKnowledgeCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack knowledge — Osstack knowledge pack bootstrap and cloud client

  osstack knowledge list [--pack P|--official|--cache-dir P] [--json]
  osstack knowledge login --cloud-url URL [--token T] [--cache-dir P] [--json]
  osstack knowledge sync [--cloud-url URL] [--cache-dir P] [--private] [--tenant T] [--json]
  osstack knowledge search <query> [--pack P] [--official] [--cloud-url URL] [--tenant T] [--cache-dir P] [--limit N] [--stale-after-days N] [--stale-policy warn|strict] [--json]
  osstack knowledge inspect <chunk_id> [--pack P] [--official] [--cache-dir P] [--json]
  osstack knowledge import P --scope team|project --id ID --name NAME --license L --output P [--taxonomy T] [--json]
  osstack knowledge ingest P --scope official|team|project --id ID --name NAME --license L --output P [--taxonomy T] [--source-kind K] [--reviewer ID] [--review-status approved|changes_requested] [--review-note TEXT] [--json]
  osstack knowledge validate --pack P|--official [--json]
  osstack knowledge pin <pack_id>@<version> [--cache-dir P] [--json]
  osstack knowledge prune [--cache-dir P] [--keep N] [--apply] [--json]
  osstack knowledge publish --pack P [--cloud-url URL] [--tenant T] [--cache-dir P] [--json]
  osstack knowledge feedback <chunk_id> --useful|--bad [--tenant ID] [--cloud-url URL] [--cache-dir P] [--json]
  osstack knowledge feedback-summary [--tenant ID] [--cloud-url URL] [--cache-dir P] [--json]
  osstack knowledge review-queue [--tenant ID] [--status needs_review|all|approved|changes_requested|missing] [--cloud-url URL] [--cache-dir P] [--json]
  osstack knowledge eval --pack P|--official --fixtures P [--top-k N] [--json]
  osstack knowledge sources --internal [--pack P|--official|--cache-dir P] [--json]

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
    const officialRequested = args.includes("--official");
    const explicitSourceRequested = packPaths.length > 0 || officialRequested;
    const packs = [
      ...await Promise.all(packPaths.map((packPath) => loadKnowledgePack(packPath))),
      ...await officialKnowledgePacksIfRequested(args),
      ...(explicitSourceRequested ? [] : await listCachedKnowledgePacks(knowledgeCacheDir(args))),
    ];
    if (packs.length === 0) {
      console.error("osstack: knowledge list requires at least one --pack path, --official, or cached pack from `osstack knowledge sync`");
      return 1;
    }
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
      if (evidence.skipped_pins !== undefined && evidence.skipped_pins.length > 0) console.log(`skipped_pins=${evidence.skipped_pins.length}`);
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
    const query = positionalValues(args.slice(1), new Set(["--pack", "--limit", "--cloud-url", "--mode", "--cache-dir", "--tenant", "--token", "--stale-after-days", "--stale-policy"])).join(" ");
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
    const staleAfterDays = parsePositiveIntegerFlag(flagValue(args, "--stale-after-days"), "--stale-after-days");
    if (staleAfterDays instanceof Error) {
      console.error(`osstack: ${staleAfterDays.message}`);
      return 1;
    }
    const stalePolicy = flagValue(args, "--stale-policy") ?? "warn";
    if (!["warn", "strict"].includes(stalePolicy)) {
      console.error("osstack: --stale-policy must be one of warn, strict");
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
      ...(staleAfterDays === undefined ? {} : { staleAfterDays }),
    }));
    const cacheIsStale = evidence.status === "recorded" && evidence.cache_stale === true;
    const output = cacheIsStale
      ? { ...evidence, cache_policy: stalePolicy }
      : evidence;
    if (args.includes("--json")) {
      console.log(JSON.stringify(output, null, 2));
    } else if (evidence.results.length === 0) {
      console.log("No knowledge chunks matched.");
    } else {
      if (evidence.fallback_mode !== undefined && evidence.reason !== undefined) {
        console.log(`Knowledge fallback: ${evidence.fallback_mode} (${evidence.reason})`);
      }
      if (evidence.status === "recorded" && evidence.cache_stale === true) {
        console.log(`Knowledge cache stale: age=${evidence.cache_age_days ?? "unknown"}d threshold=${evidence.cache_stale_after_days ?? "unknown"}d policy=${stalePolicy}`);
      }
      for (const result of evidence.results) {
        console.log(`${result.pack_id}:${result.chunk_id} score=${result.score} ${result.title}`);
        console.log(result.snippet);
      }
    }
    if (cacheIsStale && stalePolicy === "strict") {
      console.error("osstack: knowledge cache is stale under --stale-policy strict; run `osstack knowledge sync` or lower the freshness threshold");
      return 1;
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

  if (sub === "publish") {
    const packPath = flagValue(args, "--pack");
    if (packPath === undefined) {
      console.error("osstack: knowledge publish requires --pack");
      return 1;
    }
    const config = await readKnowledgeCloudConfig(knowledgeCacheDir(args));
    const cloudUrl = resolveKnowledgeCloudUrl(args, config);
    if (cloudUrl === undefined) {
      console.error("osstack: knowledge publish requires --cloud-url, OSSTACK_KNOWLEDGE_URL, or `osstack knowledge login`");
      return 1;
    }
    const tenantId = flagValue(args, "--tenant");
    const authToken = resolveKnowledgeAuthToken(args, config);
    const pack = await loadKnowledgePack(packPath);
    try {
      const published = await publishKnowledgePack({
        cloudUrl,
        manifest: tenantId === undefined ? pack.manifest : { ...pack.manifest, tenant_id: tenantId },
        ...(authToken === undefined ? {} : { authToken }),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(published, null, 2));
      } else {
        console.log(`published=${published.pack.id}@${published.pack.version}`);
        console.log(`private=${published.private ? "yes" : "no"}`);
        if (published.tenant_id !== undefined) console.log(`tenant=${published.tenant_id}`);
      }
      return 0;
    } catch (error) {
      console.error(`osstack: knowledge publish failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
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

  if (sub === "prune") {
    const keep = parsePositiveIntegerFlag(flagValue(args, "--keep"), "--keep");
    if (keep instanceof Error) {
      console.error(`osstack: ${keep.message}`);
      return 1;
    }
    const result = await pruneKnowledgeCache({
      cacheDir: knowledgeCacheDir(args),
      ...(keep === undefined ? {} : { keepVersions: keep }),
      apply: args.includes("--apply"),
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify({ prune: result }, null, 2));
    } else {
      console.log(`mode=${result.mode}`);
      console.log(`removed=${result.removed.length}`);
      console.log(`kept=${result.kept.length}`);
      console.log(`cache=${result.cache_dir}`);
      if (result.mode === "dry-run") console.log("pass --apply to remove old cached pack versions");
    }
    return 0;
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

  if (sub === "feedback-summary") {
    const config = await readKnowledgeCloudConfig(knowledgeCacheDir(args));
    const cloudUrl = resolveKnowledgeCloudUrl(args, config);
    if (cloudUrl === undefined) {
      console.error("osstack: knowledge feedback-summary requires --cloud-url, OSSTACK_KNOWLEDGE_URL, or `osstack knowledge login`");
      return 1;
    }
    const authToken = resolveKnowledgeAuthToken(args, config);
    const tenantId = flagValue(args, "--tenant");
    try {
      const summary = await fetchKnowledgeFeedbackSummary({
        cloudUrl,
        ...(authToken === undefined ? {} : { authToken }),
        ...(tenantId === undefined ? {} : { tenantId }),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`feedback_total=${summary.total} useful=${summary.useful} bad=${summary.bad}`);
        if (summary.tenant_id !== undefined) console.log(`tenant=${summary.tenant_id}`);
        for (const chunk of summary.chunks) {
          console.log(`${chunk.chunk_id} total=${chunk.total} useful=${chunk.useful} bad=${chunk.bad}`);
        }
      }
      return 0;
    } catch (error) {
      console.error(`osstack: knowledge feedback-summary failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (sub === "review-queue") {
    const config = await readKnowledgeCloudConfig(knowledgeCacheDir(args));
    const cloudUrl = resolveKnowledgeCloudUrl(args, config);
    if (cloudUrl === undefined) {
      console.error("osstack: knowledge review-queue requires --cloud-url, OSSTACK_KNOWLEDGE_URL, or `osstack knowledge login`");
      return 1;
    }
    const authToken = resolveKnowledgeAuthToken(args, config);
    const tenantId = flagValue(args, "--tenant");
    const status = flagValue(args, "--status") ?? "needs_review";
    if (!["needs_review", "all", "approved", "changes_requested", "missing"].includes(status)) {
      console.error("osstack: knowledge review-queue --status must be needs_review, all, approved, changes_requested, or missing");
      return 1;
    }
    try {
      const queue = await fetchKnowledgeReviewQueue({
        cloudUrl,
        status,
        ...(authToken === undefined ? {} : { authToken }),
        ...(tenantId === undefined ? {} : { tenantId }),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(queue, null, 2));
      } else {
        console.log(`review_queue=${queue.total} scope=${queue.scope}${queue.tenant_id === undefined ? "" : ` tenant=${queue.tenant_id}`} status=${queue.status_filter}`);
        for (const item of queue.items) {
          console.log(`${item.pack_id}@${item.version} ${item.review_status} quality=${item.quality_score} chunks=${item.chunk_count} sources=${item.source_count}`);
        }
      }
      return 0;
    } catch (error) {
      console.error(`osstack: knowledge review-queue failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
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
    const officialRequested = args.includes("--official");
    const explicitSourceRequested = packPath !== undefined || officialRequested;
    if (!args.includes("--internal")) {
      console.error("osstack: knowledge sources requires --internal to show provenance");
      return 1;
    }
    const packs = [
      ...(packPath === undefined ? [] : [await loadKnowledgePack(packPath)]),
      ...await officialKnowledgePacksIfRequested(args),
      ...(explicitSourceRequested ? [] : await listCachedKnowledgePacks(knowledgeCacheDir(args))),
    ];
    if (packs.length === 0) {
      console.error("osstack: knowledge sources requires --pack, --official, or cached pack from `osstack knowledge sync`");
      return 1;
    }
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

interface KnowledgeFeedbackSummary {
  total: number;
  useful: number;
  bad: number;
  tenant_id?: string;
  chunks: Array<{ chunk_id: string; total: number; useful: number; bad: number }>;
}

interface KnowledgeReviewQueue {
  scope: string;
  status_filter: string;
  total: number;
  tenant_id?: string;
  items: Array<{
    pack_id: string;
    version: string;
    name: string;
    scope: string;
    tenant_id?: string;
    source_kind: string;
    quality_score: number;
    review_status: string;
    reviewer_id?: string;
    reviewed_at?: string;
    review_summary?: string;
    chunk_count: number;
    source_count: number;
  }>;
}

interface KnowledgePublishResponse {
  ok: true;
  private: boolean;
  tenant_id?: string;
  pack: {
    id: string;
    version: string;
    license: string;
    source_kind: string;
    quality_score: number;
  };
}

async function publishKnowledgePack(options: {
  cloudUrl: string;
  manifest: KnowledgePackManifest;
  authToken?: string;
}): Promise<KnowledgePublishResponse> {
  const endpoint = new URL("/v1/publish", normalizeCloudUrl(options.cloudUrl));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.authToken === undefined ? {} : { authorization: `Bearer ${options.authToken}` }),
    },
    body: JSON.stringify({ pack: options.manifest }),
  });
  const raw = await response.text();
  if (!response.ok) {
    const body = parseJsonObject(raw);
    const detail = typeof body?.["error"] === "string"
      ? body["error"]
      : Array.isArray(body?.["issues"])
        ? body["issues"].map((issue) => isRecord(issue) && typeof issue["code"] === "string" ? issue["code"] : "unknown_issue").join(", ")
        : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return parseKnowledgePublishResponse(raw);
}

async function fetchKnowledgeFeedbackSummary(options: {
  cloudUrl: string;
  authToken?: string;
  tenantId?: string;
}): Promise<KnowledgeFeedbackSummary> {
  const endpoint = new URL("/v1/feedback/summary", normalizeCloudUrl(options.cloudUrl));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.authToken === undefined ? {} : { authorization: `Bearer ${options.authToken}` }),
    },
    body: JSON.stringify(options.tenantId === undefined ? {} : { tenant_id: options.tenantId }),
  });
  const raw = await response.text();
  if (!response.ok) {
    const body = parseJsonObject(raw);
    const detail = typeof body?.["error"] === "string" ? body["error"] : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return parseKnowledgeFeedbackSummary(raw);
}

async function fetchKnowledgeReviewQueue(options: {
  cloudUrl: string;
  authToken?: string;
  tenantId?: string;
  status: string;
}): Promise<KnowledgeReviewQueue> {
  const endpoint = new URL("/v1/review/queue", normalizeCloudUrl(options.cloudUrl));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.authToken === undefined ? {} : { authorization: `Bearer ${options.authToken}` }),
    },
    body: JSON.stringify({
      status: options.status,
      ...(options.tenantId === undefined ? {} : { tenant_id: options.tenantId }),
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    const body = parseJsonObject(raw);
    const detail = typeof body?.["error"] === "string" ? body["error"] : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return parseKnowledgeReviewQueue(raw);
}

function parseKnowledgePublishResponse(raw: string): KnowledgePublishResponse {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("publish response must be an object");
  if (parsed["ok"] !== true) throw new Error("publish response ok must be true");
  if (typeof parsed["private"] !== "boolean") throw new Error("publish response private must be a boolean");
  const packRaw = parsed["pack"];
  if (!isRecord(packRaw)) throw new Error("publish response pack must be an object");
  const tenantId = typeof parsed["tenant_id"] === "string" ? parsed["tenant_id"] : undefined;
  return {
    ok: true,
    private: parsed["private"],
    ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
    pack: {
      id: requiredKnowledgeString(packRaw, "id"),
      version: requiredKnowledgeString(packRaw, "version"),
      license: requiredKnowledgeString(packRaw, "license"),
      source_kind: requiredKnowledgeString(packRaw, "source_kind"),
      quality_score: requiredKnowledgeNumber(packRaw, "quality_score"),
    },
  };
}

function parseKnowledgeFeedbackSummary(raw: string): KnowledgeFeedbackSummary {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("feedback summary response must be an object");
  const total = requiredKnowledgeNumber(parsed, "total");
  const useful = requiredKnowledgeNumber(parsed, "useful");
  const bad = requiredKnowledgeNumber(parsed, "bad");
  const tenantId = typeof parsed["tenant_id"] === "string" ? parsed["tenant_id"] : undefined;
  const chunksRaw = parsed["chunks"];
  if (!Array.isArray(chunksRaw)) throw new Error("feedback summary response chunks must be an array");
  const chunks = chunksRaw.map((item) => {
    if (!isRecord(item)) throw new Error("feedback summary chunk must be an object");
    return {
      chunk_id: requiredKnowledgeString(item, "chunk_id"),
      total: requiredKnowledgeNumber(item, "total"),
      useful: requiredKnowledgeNumber(item, "useful"),
      bad: requiredKnowledgeNumber(item, "bad"),
    };
  });
  return {
    total,
    useful,
    bad,
    ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
    chunks,
  };
}

function parseKnowledgeReviewQueue(raw: string): KnowledgeReviewQueue {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("review queue response must be an object");
  const scope = requiredKnowledgeString(parsed, "scope");
  const statusFilter = requiredKnowledgeString(parsed, "status_filter");
  const total = requiredKnowledgeNumber(parsed, "total");
  const tenantId = typeof parsed["tenant_id"] === "string" ? parsed["tenant_id"] : undefined;
  const itemsRaw = parsed["items"];
  if (!Array.isArray(itemsRaw)) throw new Error("review queue response items must be an array");
  const items = itemsRaw.map((item) => {
    if (!isRecord(item)) throw new Error("review queue item must be an object");
    const itemTenantId = typeof item["tenant_id"] === "string" ? item["tenant_id"] : undefined;
    return {
      pack_id: requiredKnowledgeString(item, "pack_id"),
      version: requiredKnowledgeString(item, "version"),
      name: requiredKnowledgeString(item, "name"),
      scope: requiredKnowledgeString(item, "scope"),
      ...(itemTenantId === undefined ? {} : { tenant_id: itemTenantId }),
      source_kind: requiredKnowledgeString(item, "source_kind"),
      quality_score: requiredKnowledgeNumber(item, "quality_score"),
      review_status: requiredKnowledgeString(item, "review_status"),
      ...(typeof item["reviewer_id"] === "string" ? { reviewer_id: item["reviewer_id"] } : {}),
      ...(typeof item["reviewed_at"] === "string" ? { reviewed_at: item["reviewed_at"] } : {}),
      ...(typeof item["review_summary"] === "string" ? { review_summary: item["review_summary"] } : {}),
      chunk_count: requiredKnowledgeNumber(item, "chunk_count"),
      source_count: requiredKnowledgeNumber(item, "source_count"),
    };
  });
  return {
    scope,
    status_filter: statusFilter,
    total,
    ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
    items,
  };
}

function requiredKnowledgeString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`feedback summary response ${key} must be a non-empty string`);
  }
  return value;
}

function requiredKnowledgeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`feedback summary response ${key} must be a non-negative number`);
  }
  return value;
}

function parseKnowledgeScope(value: string | undefined): KnowledgeScope | undefined {
  if (value === "official" || value === "team" || value === "project") return value;
  return undefined;
}

async function handleLessonsCommand(args: string[]): Promise<number> {
  const { readLoopState } = await loadLoop();
  const sub = args[0] ?? "list";
  if (sub === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack lessons — local pitfall knowledge base

  osstack lessons list [--family F] [--limit N] [--json]
  osstack lessons learn [--workspace P] [--state P] [--json]
                                 Record failed/escalated observations; effectiveness requires independent evaluation
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
          console.log(`${lesson.pitfall_id} ${lesson.family} observations=${lesson.observation_count} legacy_verified=${lesson.legacy_verified_count} (not effectiveness evidence)`);
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
      // Related successes do not prove that any lesson was used or effective.
      const verifiedLessons: ReturnType<typeof upsertPitfallLesson>[] = [];
      if (args.includes("--json")) {
        console.log(JSON.stringify({
          learned: lessons.length,
          verified: verifiedLessons.length,
          lessons,
          verified_lessons: verifiedLessons,
        }, null, 2));
      } else {
        console.log(`learned=${lessons.length}`);
        console.log("effectiveness=not_evaluated");
        for (const lesson of lessons) {
          console.log(`${lesson.pitfall_id} ${lesson.family} observations=${lesson.observation_count} legacy_verified=${lesson.legacy_verified_count} (not effectiveness evidence)`);
        }
        for (const lesson of verifiedLessons) {
          console.log(`${lesson.pitfall_id} ${lesson.family} observations=${lesson.observation_count} legacy_verified=${lesson.legacy_verified_count} (not effectiveness evidence)`);
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
  // Phase 2.1-B: direct-DB commands pass the SAME control-plane guard as
  // serving — opening the DB auto-migrates it, so an undeclared checkout must
  // never touch the default or a reserved home (the 2026-07-18/19 incidents).
  {
    let checkoutRoot = dirname(fileURLToPath(import.meta.url));
    try { checkoutRoot = dirname(realpathSync(fileURLToPath(import.meta.url))); } catch { /* lexical */ }
    assertDbAccessAllowed({ checkoutRoot, osstackHome: home });
  }
  await mkdir(home, { recursive: true });
  return join(home, "state.db");
}

async function observeLoopProbeEvents(
  workspacePath: string,
  events: readonly unknown[],
): Promise<LoopProbeObservationSummaryV1 | undefined> {
  if (!events.some((event) =>
    isRecord(event) && event["type"] === "loop.implementation.deviation"
  )) {
    return undefined;
  }
  try {
    const sourceRevision = await gitOutput(workspacePath, ["rev-parse", "HEAD"]);
    if (sourceRevision instanceof Error || sourceRevision.trim() === "") {
      throw new Error("structured implementation deviations require a Git source revision");
    }
    const repoRoot = realpathSync(workspacePath);
    const db = openDb({ path: await ensureLocalStateDbPath() });
    try {
      const { resolveProbeRepositoryId } = await import("./probe-command.js");
      const { observeLoopImplementationDeviations } = await import("./loop-probe-observer.js");
      const observation = await observeLoopImplementationDeviations({
        db,
        repo_root: repoRoot,
        repo_id: await resolveProbeRepositoryId(repoRoot),
        source_revision: sourceRevision.trim(),
        events,
        now_ms: Date.now(),
        create_item_id: () => `pi_${randomUUID()}`,
        create_event_id: () => `pe_${randomUUID()}`,
      });
      return { status: "ok", ...observation };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function derivePitfallLessonsFromState(state: LoopState): Parameters<typeof upsertPitfallLesson>[2][] {
  return state.completed_tasks
    .filter((task) => task.outcome === "failed" || task.outcome === "escalated")
    .map((task) => {
      const family = pitfallFamilyForCompletedTask(task);
      return {
        family,
        tech_stack: inferLessonTechStack(task.capability),
        symptom: pitfallSymptomForCompletedTask(task),
        resolution: pitfallResolutionForFamily(family),
        source_run_id: state.loop_id,
      };
    });
}

async function learnLessonsFromLoopState(state: LoopState): Promise<{
  learned: number;
  lessons: ReturnType<typeof upsertPitfallLesson>[];
  verified: number;
  verified_lessons: ReturnType<typeof upsertPitfallLesson>[];
} | undefined> {
  const candidates = derivePitfallLessonsFromState(state);
  try {
    const dbPath = await ensureLocalStateDbPath();
    const db = openDb({ path: dbPath });
    try {
      const lessons = candidates.map((candidate) => upsertPitfallLesson(db, dbPath, candidate));
      // Related successes do not prove that any lesson was used or effective.
      const verifiedLessons: ReturnType<typeof upsertPitfallLesson>[] = [];
      if (lessons.length === 0 && verifiedLessons.length === 0) return undefined;
      return {
        learned: lessons.length,
        lessons,
        verified: verifiedLessons.length,
        verified_lessons: verifiedLessons,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function pitfallFamilyForCompletedTask(task: LoopState["completed_tasks"][number]): string {
  const text = [
    task.error_summary,
    task.execution_summary,
    task.verify_summary,
    ...(task.verify_issues ?? []).map((issue) => issue.message),
  ].filter((item): item is string => item !== undefined).join("\n").toLowerCase();
  if (text.includes("agent adapter not registered")
    || text.includes("agent unavailable")
    || text.includes("adapter unavailable")
    || text.includes("not available")) {
    return "agent_unavailable";
  }
  if (text.includes("governance-verifier")
    || text.includes("governance")
    || text.includes("high severity")
    || text.includes("blocking=true")) {
    return "governance_high_severity";
  }
  if (text.includes("merge conflict")
    || text.includes("conflict marker")
    || text.includes("automatic merge failed")
    || text.includes("unmerged paths")
    || text.includes("both modified")) {
    return "merge_conflict";
  }
  if (text.includes("fixture drift")
    || text.includes("snapshot obsolete")
    || text.includes("snapshot failed")
    || text.includes("snapshot mismatch")
    || text.includes("golden file")
    || text.includes("expected fixture")
    || text.includes("received fixture")) {
    return "test_fixture_drift";
  }
  if (text.includes("network timeout")
    || text.includes("network outage")
    || text.includes("econnreset")
    || text.includes("etimedout")
    || text.includes("enotfound")
    || text.includes("temporary failure in name resolution")
    || text.includes("fetch failed")) {
    return "network_outage";
  }
  if (text.includes("permission denied")
    || text.includes("eacces")
    || text.includes("eperm")
    || text.includes("read-only file system")
    || text.includes("operation not permitted")) {
    return "filesystem_permission";
  }
  if (text.includes("npm install")
    || text.includes("pnpm install")
    || text.includes("yarn install")
    || text.includes("bun install")
    || text.includes("missing dependency")
    || text.includes("cannot find module")
    || text.includes("module not found")
    || text.includes("enoent")) {
    return "dependency_install_failure";
  }
  if (text.includes("node version")
    || text.includes("unsupported engine")
    || text.includes("engine mismatch")
    || text.includes("toolchain")
    || text.includes("tsc version")
    || text.includes("typescript version")) {
    return "toolchain_mismatch";
  }
  if (text.includes("reviewer")
    || text.includes("checker")
    || task.verifier_agent_id !== undefined) {
    return "reviewer_checker_failed";
  }
  return task.outcome === "failed" ? "verify_failed" : "max_iter_escalation";
}

function pitfallSymptomForCompletedTask(task: LoopState["completed_tasks"][number]): string {
  const base = `${task.task_id} ended with ${task.outcome} after ${task.iterations} iteration${task.iterations === 1 ? "" : "s"}.`;
  const detail = task.error_summary ?? task.verify_summary ?? task.execution_summary;
  return detail === undefined ? base : `${base} ${detail}`;
}

function pitfallResolutionForFamily(family: string): string {
  if (family === "agent_unavailable") {
    return "Check that the requested agent adapter is installed and logged in, or reroute the task to an available fallback agent.";
  }
  if (family === "reviewer_checker_failed") {
    return "Inspect reviewer/checker findings, fix the reported issues, and rerun the verifier before retrying the loop.";
  }
  if (family === "governance_high_severity") {
    return "Inspect governance findings, fix high-severity safety issues, and rerun governance in the same mode before retrying.";
  }
  if (family === "dependency_install_failure") {
    return "Install or repair project dependencies in the workspace, then rerun the deterministic verifier before retrying.";
  }
  if (family === "merge_conflict") {
    return "Resolve the merge conflict in an isolated worktree, rerun verification, and preserve conflict context in the proof pack.";
  }
  if (family === "toolchain_mismatch") {
    return "Align the local Node/package-manager/toolchain versions with the project requirements before rerunning the verifier.";
  }
  if (family === "test_fixture_drift") {
    return "Regenerate or repair the affected fixture/snapshot only after confirming the behavior change is intended.";
  }
  if (family === "network_outage") {
    return "Retry with network availability confirmed, prefer cached/offline fallbacks, and record any external service dependency in the proof.";
  }
  if (family === "filesystem_permission") {
    return "Fix workspace file permissions or sandbox configuration, then rerun the same deterministic verifier.";
  }
  if (family === "max_iter_escalation") {
    return "Break the task into a smaller queue item, add a stronger verify gate, or route to a reviewer/checker before retrying.";
  }
  return "Inspect verifier output, rerun deterministic checks, and update the task or dependency setup before retrying.";
}

function inferLessonTechStack(capability: string | undefined): string[] {
  if (capability === undefined || capability.length === 0) return ["unknown"];
  return [...new Set(capability.split(/[.:_-]+/).filter((part) => part.length > 0))];
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
type LoopGovernanceScope = "workspace" | "changed" | "baseline";

type GovernanceScanEvidence = GovernanceProofEvidence & {
  error_findings: number;
};

type LoopGovernanceEvidence = GovernanceScanEvidence & {
  mode: LoopGovernanceMode;
  scope: LoopGovernanceScope;
  blocking: boolean;
  baseline_evidence?: GovernanceScanEvidence & {
    mode: "warn";
    scope: "workspace";
    blocking: false;
  };
  changed_evidence?: GovernanceScanEvidence & {
    scope: "changed";
  };
  baseline_revision?: string;
  baseline_suppressed_findings?: number;
};

interface LoopGovernanceBaselineSnapshot {
  evidence?: GovernanceProofEvidence;
  revision?: string;
}

type KnowledgeProofEvidence = KnowledgeSearchEvidence;

type ContractProofEvidence =
  | ContractValidationReport
  | {
    schema_version: 1;
    kind: "osstack.contract_validation";
    status: "unknown";
    service: "unknown";
    manifest_path: string;
    workspace_path: string;
    checked_at: string;
    endpoints: 0;
    frontend_calls: [];
    backend_routes: [];
    findings: [];
    reason: string;
  };

function knowledgeSearchOptions(options: {
  mode: KnowledgeMode | undefined;
  query: string;
  packs: Parameters<typeof resolveKnowledgeSearch>[0]["packs"];
  limit: number;
  cloudUrl: string | undefined;
  authToken?: string;
  tenantId?: string;
  staleAfterDays?: number;
}): Parameters<typeof resolveKnowledgeSearch>[0] {
  return {
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    query: options.query,
    ...(options.packs !== undefined ? { packs: options.packs } : {}),
    limit: options.limit,
    ...(options.cloudUrl !== undefined ? { cloudUrl: options.cloudUrl } : {}),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.staleAfterDays !== undefined ? { staleAfterDays: options.staleAfterDays } : {}),
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
  const { readLoopState } = await loadLoop();
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
  console.log(await renderReportMarkdownForArtifacts(state, events, language));
  return 0;
}

async function handleScorecardCommand(args: string[]): Promise<number> {
  const { readLoopState, createLoopStateScorecardFromState, renderLoopStateScorecardHtml, renderLoopStateScorecardMarkdown } = await loadLoop();
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
  const { readLoopState } = await loadLoop();
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack proof — local evidence proof pack

  osstack proof [run_id] [--loop loop_id] [--workspace P] [--state P] [--events P] [--knowledge-pack P] [--knowledge-mode M] [--knowledge-cloud-url URL] [--knowledge-query Q] [--compliance-pack P] [--output-dir P] [--stage candidate|final] [--supersedes-manifest P] [--risk-preflight P] [--risk-post-diff P] [--approval-request P] [--approval-decision P] [--git-delivery P] [--json]
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
  --stage S           Evidence stage: candidate (default) or final
  --supersedes-manifest P
                      Candidate manifest required by a final proof
  --risk-preflight P  JSON risk evidence from preflight classification
  --risk-post-diff P  JSON risk evidence from staged-diff classification
  --approval-request P
                      JSON scoped approval request evidence
  --approval-decision P
                      JSON externally verified approval decision evidence
  --git-delivery P    JSON GitHub delivery evidence (final stage only)
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
    "--stage",
    "--supersedes-manifest",
    "--risk-preflight",
    "--risk-post-diff",
    "--approval-request",
    "--approval-decision",
    "--git-delivery",
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
  const proofStage = parseProofStage(flagValue(args, "--stage"));
  if (proofStage instanceof Error) {
    console.error(`osstack: ${proofStage.message}`);
    return 1;
  }
  const artifactId = runId ?? loopId ?? state.loop_id;
  const stageInput = await createCliProofStageInput({
    stage: proofStage,
    supersedesManifest: flagValue(args, "--supersedes-manifest"),
    outputDir,
    artifactId,
    workspacePath,
    riskPreflight: flagValue(args, "--risk-preflight"),
    riskPostDiff: flagValue(args, "--risk-post-diff"),
    approvalRequest: flagValue(args, "--approval-request"),
    approvalDecision: flagValue(args, "--approval-decision"),
    gitDelivery: flagValue(args, "--git-delivery"),
  });
  if (stageInput instanceof Error) {
    console.error(`osstack: ${stageInput.message}`);
    return 1;
  }
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
    proof = await writeProofPack(
      state,
      outputDir,
      events,
      runId ?? loopId,
      governance,
      knowledge,
      flagValues(args, "--compliance-pack"),
      workspacePath,
      stageInput,
    );
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

function parseProofStage(
  value: string | undefined,
): ProofStageInput["stage"] | Error {
  if (value === undefined || value === "candidate") return "candidate";
  if (value === "final") return "final";
  return new Error("--stage must be candidate or final");
}

async function createCliProofStageInput(input: {
  stage: ProofStageInput["stage"];
  supersedesManifest: string | undefined;
  outputDir: string;
  artifactId: string;
  workspacePath: string;
  riskPreflight: string | undefined;
  riskPostDiff: string | undefined;
  approvalRequest: string | undefined;
  approvalDecision: string | undefined;
  gitDelivery: string | undefined;
}): Promise<ProofStageInput | Error> {
  let supersedes: ProofStageInput["supersedes"];
  if (input.stage === "candidate") {
    if (input.supersedesManifest !== undefined) {
      return new Error("--supersedes-manifest is valid only with --stage final");
    }
    if (input.gitDelivery !== undefined) {
      return new Error("--git-delivery is valid only with --stage final");
    }
  } else {
    if (input.supersedesManifest === undefined) {
      return new Error("--stage final requires --supersedes-manifest");
    }

    const candidateManifest = resolveLoopPath(
      input.supersedesManifest,
      input.workspacePath,
    );
    const outputRoot = resolve(input.outputDir);
    const candidateRelativeToOutput = relative(outputRoot, candidateManifest);
    if (
      candidateRelativeToOutput.startsWith("..")
      || isAbsolute(candidateRelativeToOutput)
      || candidateManifest !== join(dirname(candidateManifest), "manifest.json")
    ) {
      return new Error(
        "--supersedes-manifest must name a candidate manifest inside --output-dir",
      );
    }

    let candidateContent: Buffer;
    let candidateRaw: unknown;
    try {
      candidateContent = await readFile(candidateManifest);
      candidateRaw = JSON.parse(candidateContent.toString("utf-8")) as unknown;
    } catch (error) {
      return new Error(
        `unable to read candidate manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !isRecord(candidateRaw)
      || candidateRaw["proof_stage"] !== "candidate"
      || candidateRaw["supersedes"] !== undefined
    ) {
      return new Error(
        "--supersedes-manifest must reference a candidate proof manifest",
      );
    }

    const finalProofDir = join(
      input.outputDir,
      `osstack-proof-${safeFileSegment(input.artifactId)}-final`,
    );
    const manifestPath = relative(finalProofDir, candidateManifest)
      .replaceAll("\\", "/");
    supersedes = {
      manifest_path: manifestPath,
      manifest_sha256: sha256Buffer(candidateContent),
    };
  }

  const evidence = await Promise.all([
    readCliProofEvidence(input.riskPreflight, "--risk-preflight", input.workspacePath),
    readCliProofEvidence(input.riskPostDiff, "--risk-post-diff", input.workspacePath),
    readCliProofEvidence(input.approvalRequest, "--approval-request", input.workspacePath),
    readCliProofEvidence(input.approvalDecision, "--approval-decision", input.workspacePath),
    readCliProofEvidence(input.gitDelivery, "--git-delivery", input.workspacePath),
  ]);
  const evidenceError = evidence.find(
    (value): value is Error => value instanceof Error,
  );
  if (evidenceError !== undefined) {
    return evidenceError;
  }
  return {
    stage: input.stage,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(evidence[0] === undefined && evidence[1] === undefined
      ? {}
      : {
          risk_evidence: {
            ...(evidence[0] === undefined ? {} : { preflight: evidence[0] }),
            ...(evidence[1] === undefined ? {} : { post_diff: evidence[1] }),
          },
        }),
    ...(evidence[2] === undefined && evidence[3] === undefined
      ? {}
      : {
          approval_evidence: {
            ...(evidence[2] === undefined ? {} : { request: evidence[2] }),
            ...(evidence[3] === undefined ? {} : { decision: evidence[3] }),
          },
        }),
    ...(evidence[4] === undefined
      ? {}
      : { git_delivery_evidence: evidence[4] }),
  };
}

async function readCliProofEvidence(
  path: string | undefined,
  flag: string,
  workspacePath: string,
): Promise<Record<string, unknown> | undefined | Error> {
  if (path === undefined) return undefined;
  try {
    const raw = JSON.parse(
      await readFile(resolveLoopPath(path, workspacePath), "utf-8"),
    ) as unknown;
    if (!isRecord(raw) || Object.keys(raw).length === 0) {
      return new Error(`${flag} must reference a non-empty JSON object`);
    }
    return raw;
  } catch (error) {
    return new Error(
      `${flag} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  const { readLoopState } = await loadLoop();
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
  const body = await renderPrBody({
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
  osstack serve --install [--bin PATH] [--profile NAME]
    [--write-concurrency N] [--read-concurrency N]
    [--power-policy none|process_assertion] [--no-load] [--json]
  osstack serve --status [--json]
  osstack serve --uninstall [--no-load] [--json]

Options:
  --install       Write ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist and load it with launchctl
  --uninstall     Boot out the LaunchAgent and remove its plist
  --status        Show plist/launchd status
  --bin PATH      osstack binary path to put in the plist
  --profile NAME  Agent profile for daemon work (default: mac-mini)
  --write-concurrency N  Machine-wide write slots (default: 2)
  --read-concurrency N   Machine-wide read slots (default: 8)
  --power-policy MODE    Explicit host sleep policy: none or process_assertion
                         (never changes persistent pmset settings)
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
      if (!isAbsolute(binPath)) {
        throw new Error("--bin must be an absolute stable-serving binary path");
      }
      const profile = optionalStringFlag(
        args,
        "--profile",
        process.env["OSSTACK_AGENT_PROFILE"] ?? "mac-mini",
      ) ?? "mac-mini";
      const writeConcurrency = positiveIntegerFlag(
        args,
        "--write-concurrency",
        2,
      ) ?? 2;
      const readConcurrency = positiveIntegerFlag(
        args,
        "--read-concurrency",
        8,
      ) ?? 8;
      const rawPowerPolicy =
        flagValue(args, "--power-policy")
        ?? process.env["OSSTACK_POWER_POLICY"]
        ?? "none";
      if (
        rawPowerPolicy !== "none"
        && rawPowerPolicy !== "process_assertion"
      ) {
        throw new Error(
          "--power-policy must be none or process_assertion; persistent pmset changes are never applied automatically",
        );
      }
      const powerPolicy = rawPowerPolicy;
      if (
        !args.includes("--bin")
        && isDevelopmentCliDist(binPath)
      ) {
        let explicitlyStable = false;
        try {
          const checkoutRoot = dirname(realpathSync(binPath));
          if (loadRoleFile(checkoutRoot)?.role !== "stable-serving") {
            throw new Error("development dist is not stable-serving");
          }
          assertServeAllowed({
            checkoutRoot,
            osstackHome: process.env.OSSTACK_HOME ?? defaultOsstackHome(),
          });
          explicitlyStable = true;
        } catch {
          // The default checkout remains development-only until an operator
          // names it explicitly with --bin or a deployment provisions it.
        }
        if (!explicitlyStable) {
          console.error(
            "osstack: serve --install aborted — default development dist/bin.js is not stable-serving; pass an explicit absolute --bin to provision this checkout",
          );
          return 78;
        }
      }
      // Provision the control-plane role authority for THIS deployment: an
      // installed launchd daemon serves the default home, which the boot guard
      // only permits for a declared stable-serving root (review F1).
      try {
        const { CURRENT_SCHEMA_VERSION } = await import("@osstack/core");
        const { provisionStableServing } = await import("./control-plane-guard.js");
        provisionStableServing(binPath, process.env.OSSTACK_HOME ?? "~/.osstack", CURRENT_SCHEMA_VERSION, { requireBinary: !noLoad });
        if (!json) console.log("control-plane guard: stable-serving role declaration provisioned and verified");
      } catch (err) {
        // A daemon the guard would refuse must not be installed (round-4 F2).
        console.error(`osstack: serve --install aborted — control-plane provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
        return 78;
      }
      const result = await installLaunchAgent({
        binPath,
        noLoad,
        profile,
        writeConcurrency,
        readConcurrency,
        powerPolicy,
      });
      // Record the plist content baseline for doctor's drift check (2.1-C/F2).
      try {
        const { createHash } = await import("node:crypto");
        const plistPath = (result as { plist_path?: string }).plist_path
          ?? `${process.env.HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
        if (fsExistsSync(plistPath)) {
          const h = createHash("sha256").update(readFileSync(plistPath)).digest("hex");
          const home = process.env.OSSTACK_HOME ?? defaultOsstackHome();
          await mkdir(home, { recursive: true });
          fsWriteFileSync(`${home}/plist.sha256.baseline`, `${h}\n`);
        }
      } catch { /* baseline is best-effort; doctor warns when absent */ }
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

async function installLaunchAgent(options: {
  binPath: string;
  noLoad: boolean;
  profile: string;
  writeConcurrency: number;
  readConcurrency: number;
  powerPolicy: "none" | "process_assertion";
}): Promise<ServeLaunchdInstallResult> {
  const plistPath = launchAgentPlistPath();
  const logDir = logsDir();
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(osstackHome(), { recursive: true });
  const existingPlist = await fileExists(plistPath)
    ? await readFile(plistPath, "utf-8")
    : "";
  const priorPowerPolicy =
    plistEnvironmentValue(existingPlist, "OSSTACK_POWER_POLICY") ===
        "process_assertion"
      ? "process_assertion"
      : "none";
  const plist = renderLaunchAgentPlist({
    binPath: options.binPath,
    home: osstackHome(),
    socketPath: resolveSocketPath(),
    stdoutPath: join(logDir, "daemon.log"),
    stderrPath: join(logDir, "daemon.error.log"),
    profile: options.profile,
    writeConcurrency: options.writeConcurrency,
    readConcurrency: options.readConcurrency,
    powerPolicy: options.powerPolicy,
  });
  await writeFile(plistPath, plist, "utf-8");
  const hostEvidenceDir = join(osstackHome(), "host");
  const powerPolicyRecord = join(hostEvidenceDir, "power-policy.json");
  await mkdir(hostEvidenceDir, { recursive: true });
  await writeFile(
    powerPolicyRecord,
    `${JSON.stringify({
      schema_version: 1,
      selected_at: new Date().toISOString(),
      mode: options.powerPolicy,
      previous_mode: priorPowerPolicy,
      machine_settings_changed: false,
      current:
        options.powerPolicy === "process_assertion"
          ? "caffeinate -ims bound to ai.osstack.daemon lifetime"
          : "no OSStack power assertion",
      rollback:
        `reinstall with --power-policy ${priorPowerPolicy}`,
    }, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );

  let loaded = false;
  if (!options.noLoad) {
    ensureLaunchdSupported();
    const domain = launchdDomain();
    const plan = launchAgentLoadPlan({
      loaded: await isLaunchAgentLoaded(),
      domain,
      plistPath,
    });
    await executeLaunchAgentLoadPlan({
      actions: plan,
      run: launchctl,
      wait: async (milliseconds) => {
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, milliseconds);
        });
      },
    });
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
    profile: options.profile,
    write_concurrency: options.writeConcurrency,
    read_concurrency: options.readConcurrency,
    power_policy: options.powerPolicy,
    clock_monitor: "monotonic-v1",
    power_policy_record: powerPolicyRecord,
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
    profile: null,
    write_concurrency: null,
    read_concurrency: null,
    power_policy: null,
    clock_monitor: null,
  };
}

async function readLaunchAgentStatus(options: { noLoad: boolean } = { noLoad: false }): Promise<ServeLaunchdStatus> {
  const plistPath = launchAgentPlistPath();
  const installed = await fileExists(plistPath);
  const plist = installed ? await readFile(plistPath, "utf-8") : "";
  return {
    label: LAUNCHD_LABEL,
    plist_path: plistPath,
    installed,
    loaded: options.noLoad ? false : await isLaunchAgentLoaded(),
    socket_path: resolveSocketPath(),
    profile: plistEnvironmentValue(plist, "OSSTACK_AGENT_PROFILE") ?? null,
    write_concurrency: plistEnvironmentInteger(
      plist,
      "OSSTACK_WRITE_CONCURRENCY",
    ),
    read_concurrency: plistEnvironmentInteger(
      plist,
      "OSSTACK_READ_CONCURRENCY",
    ),
    power_policy:
      plistEnvironmentValue(plist, "OSSTACK_POWER_POLICY") ===
        "process_assertion"
        ? "process_assertion"
        : installed
          ? "none"
          : null,
    clock_monitor:
      plistEnvironmentValue(plist, "OSSTACK_CLOCK_MONITOR") ===
        "monotonic-v1"
        ? "monotonic-v1"
        : null,
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
  console.log(`profile=${result.profile ?? "unknown"}`);
  console.log(`write_concurrency=${result.write_concurrency ?? "unknown"}`);
  console.log(`read_concurrency=${result.read_concurrency ?? "unknown"}`);
  console.log(`power_policy=${result.power_policy ?? "unknown"}`);
  console.log(`clock_monitor=${result.clock_monitor ?? "unknown"}`);
  if ("power_policy_record" in result) {
    console.log(`power_policy_record=${result.power_policy_record}`);
  }
  if ("load_skipped" in result) console.log(`load_skipped=${result.load_skipped}`);
  if ("unloaded" in result) console.log(`unloaded=${result.unloaded}`);
}

function renderLaunchAgentPlist(options: {
  binPath: string;
  home: string;
  socketPath: string;
  stdoutPath: string;
  stderrPath: string;
  profile: string;
  writeConcurrency: number;
  readConcurrency: number;
  powerPolicy: "none" | "process_assertion";
}): string {
  // launchd's default PATH has no /opt/homebrew/bin (or nvm shims), so a JS
  // binPath's `#!/usr/bin/env node` shebang fails with exit 127 under launchd.
  // Two subtleties (cross-review B1/S1):
  //  - npm-global installs expose an EXTENSIONLESS symlink shim
  //    (/opt/homebrew/bin/osstack -> …/dist/bin.js), so the .js check must run
  //    on the realpath, not the raw binPath. Single-binary builds stay native.
  //  - embedding the absolute process.execPath would go stale on the next
  //    brew/nvm node upgrade (Cellar paths are version-stamped) and `osstack
  //    upgrade` never re-renders the plist. Instead, extend PATH (current
  //    runtime's dir first, then the standard install dirs) and invoke `node`
  //    by name so a future node survives.
  const resolvedBinPath = (() => {
    try {
      return realpathSync(options.binPath);
    } catch {
      return options.binPath;
    }
  })();
  const daemonArgs = resolvedBinPath.endsWith(".js")
    ? ["/usr/bin/env", "node", options.binPath, "serve"]
    : [options.binPath, "serve"];
  const args =
    options.powerPolicy === "process_assertion"
      ? ["/usr/bin/caffeinate", "-ims", ...daemonArgs]
      : daemonArgs;
  const daemonPath = [
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(homedir(), ".local", "bin"),
  ].join(":");
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>OSSTACK_HOME</key>
    <string>${xmlEscape(options.home)}</string>
    <key>OSSTACK_SOCKET</key>
    <string>${xmlEscape(options.socketPath)}</string>
    <key>OSSTACK_AGENT_PROFILE</key>
    <string>${xmlEscape(options.profile)}</string>
    <key>OSSTACK_WRITE_CONCURRENCY</key>
    <string>${options.writeConcurrency}</string>
    <key>OSSTACK_READ_CONCURRENCY</key>
    <string>${options.readConcurrency}</string>
    <key>OSSTACK_POWER_POLICY</key>
    <string>${options.powerPolicy}</string>
    <key>OSSTACK_CLOCK_MONITOR</key>
    <string>monotonic-v1</string>
    <key>OSSTACK_LOG_MAX_BYTES</key>
    <string>26214400</string>
    <key>OSSTACK_LOG_MAX_FILES</key>
    <string>5</string>
    <key>OSSTACK_PROOF_RETENTION_DAYS</key>
    <string>30</string>
    <key>OSSTACK_PROOF_MIN_KEEP</key>
    <string>100</string>
    <key>PATH</key>
    <string>${xmlEscape(daemonPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
      <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.stderrPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.home)}</string>
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

export function launchAgentLoadPlan(options: {
  loaded: boolean;
  domain: string;
  plistPath: string;
}): string[][] {
  const service = `${options.domain}/${LAUNCHD_LABEL}`;
  return [
    ...(options.loaded ? [["bootout", service]] : []),
    ["bootstrap", options.domain, options.plistPath],
    ["kickstart", "-k", service],
  ];
}

const DEFAULT_LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS = [
  100,
  250,
  500,
  1_000,
  2_000,
  3_000,
] as const;

export async function executeLaunchAgentLoadPlan(options: {
  actions: string[][];
  run: (
    action: string[],
    options?: { allowFailure?: boolean },
  ) => Promise<{ ok: boolean; output: string }>;
  wait: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}): Promise<void> {
  const retryDelaysMs = options.retryDelaysMs
    ?? DEFAULT_LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS;
  for (const action of options.actions) {
    if (action[0] !== "bootstrap") {
      await options.run(action);
      continue;
    }

    let attempts = 1;
    let result = await options.run(action, { allowFailure: true });
    for (const retryDelayMs of retryDelaysMs) {
      if (result.ok) break;
      await options.wait(retryDelayMs);
      attempts += 1;
      result = await options.run(action, { allowFailure: true });
    }
    if (!result.ok) {
      throw new Error(
        `launchctl ${action.join(" ")} failed after ${attempts} attempts: ${result.output}`,
      );
    }
  }
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

function isDevelopmentCliDist(binPath: string): boolean {
  const resolved = (() => {
    try {
      return realpathSync(binPath);
    } catch {
      return resolve(binPath);
    }
  })();
  return resolved.endsWith(join("packages", "cli", "dist", "bin.js"));
}

function plistEnvironmentValue(
  plist: string,
  name: string,
): string | undefined {
  const match = plist.match(
    new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`),
  );
  return match?.[1];
}

function plistEnvironmentInteger(
  plist: string,
  name: string,
): number | null {
  const value = plistEnvironmentValue(plist, name);
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

function optionalStringFlag(
  args: string[],
  name: string,
  fallback?: string,
): string | undefined {
  const value = flagValue(args, name);
  if (args.includes(name) && (value === undefined || value.startsWith("--"))) {
    throw new Error(`${name} requires a value`);
  }
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${name} must be a profile identifier`);
  }
  return value ?? fallback;
}

function positiveIntegerFlag(
  args: string[],
  name: string,
  fallback?: number,
): number | undefined {
  const value = flagValue(args, name);
  if (value === undefined) {
    if (args.includes(name)) throw new Error(`${name} requires a positive integer`);
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 64) {
    throw new Error(`${name} requires a positive integer no greater than 64`);
  }
  return parsed;
}

function firstPositionalValue(args: string[], flagsWithValues: Set<string>): string | undefined {
  return positionalValues(args, flagsWithValues)[0];
}

async function readPersistedLoopRunEvidence(runId: string): Promise<{
  run_id: string;
  state_json: string;
  events: LoopEvent[];
} | Error> {
  const dbPath = await ensureLocalStateDbPath();
  const db = openDb({ path: dbPath });
  try {
    const run = getRun(db, runId);
    if (run === undefined) return new Error(`no persisted run found for run_id=${runId}`);
    const rows = listEventsForRun(db, runId);
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
  const { readLoopState } = await loadLoop();
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
  const { createLoopStateScorecardFromState, renderLoopStateScorecardHtml, renderLoopStateScorecardMarkdown } = await loadLoop();
  if (!hasRequestedLoopArtifacts(args)) return undefined;

  const artifacts: LoopEvidenceArtifacts = {};
  const loopId = safeFileSegment(state.loop_id);

  if (args.includes("--report")) {
    const reportDir = join(workspacePath, "reports");
    const reportPath = join(reportDir, `osstack-report-${loopId}.md`);
    await mkdir(reportDir, { recursive: true });
    await writeFile(reportPath, await renderReportMarkdownForArtifacts(state, events), "utf-8");
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
  stageInput: ProofStageInput = { stage: "candidate" },
): Promise<{
  proof_dir: string;
  proof_zip: string;
  proof_manifest: string;
  artifact_count: number;
}> {
  const { createLoopStateScorecardFromState, renderLoopStateScorecardHtml, renderLoopStateScorecardMarkdown } = await loadLoop();
  const {
    createAgentRuntimeEvidence,
    createPolicyDecisionEvidence,
    createProofStageArtifacts,
    createProofStageMetadata,
    createVerifierOutputArtifacts,
  } = await import("./proof-pack.js");
  const stageMetadata = createProofStageMetadata(stageInput);
  const proofDir = join(
    outputDir,
    `osstack-proof-${safeFileSegment(artifactId)}${stageInput.stage === "final" ? "-final" : ""}`,
  );
  const scorecard = createLoopStateScorecardFromState(state);
  const policyDecision = createPolicyDecisionEvidence(events);
  const agentRuntime = createAgentRuntimeEvidence(events);
  const verifyResults = await createVerifyResultsEvidence(scorecard, events);
  const worktreeStatus = createWorktreeStatusEvidence(events);
  const contractValidation = await createContractProofEvidence(workspacePath);
  validateProofEvidenceArtifacts({ policyDecision, agentRuntime, verifyResults, worktreeStatus });
  const artifacts = [
    { path: "report.md", content: await renderReportMarkdownForArtifacts(state, events) },
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
    { path: "contract-validation.json", content: `${JSON.stringify(contractValidation, null, 2)}\n` },
    { path: "logs/events.log", content: renderProofEventsLog(events) },
  ];
  artifacts.push(...createProofStageArtifacts(stageInput));
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
    ...stageMetadata,
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
    const { collectGovernanceScanFiles } = await import("./assurance-command.js");
    const files = await collectGovernanceScanFiles(workspacePath);
    return await scanGovernanceFiles(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unknownGovernanceEvidence(`Governance scan failed: ${message}`);
  }
}

async function scanChangedWorkspaceGovernance(
  workspacePath: string,
  baselineRevision?: string,
): Promise<GovernanceProofEvidence> {
  const { collectChangedGovernanceScanFiles } = await import("./assurance-command.js");
  const files = await collectChangedGovernanceScanFiles(workspacePath, baselineRevision);
  if (files instanceof Error) {
    return unknownGovernanceEvidence(`Governance changed-files scan failed: ${files.message}`);
  }
  try {
    return await scanGovernanceFiles(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unknownGovernanceEvidence(`Governance changed-files scan failed: ${message}`);
  }
}

async function scanGovernanceFiles(files: string[]): Promise<GovernanceProofEvidence> {
  if (files.length === 0) {
    return {
      status: "pass",
      ok: true,
      scanned_files: 0,
      findings: [],
    };
  }
  const { scanFiles } = await import("@osstack/governance");
  const result = await scanFiles(files);
  return {
    status: result.ok ? "pass" : "fail",
    ok: result.ok,
    scanned_files: files.length,
    findings: result.findings,
  };
}

async function captureLoopGovernanceBaseline(
  workspacePath: string,
  includeEvidence: boolean,
): Promise<LoopGovernanceBaselineSnapshot> {
  try {
    const revisionResult = await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
      { timeout: 10_000 },
    );
    const revision = revisionResult.stdout.trim();
    if (revision === "") {
      return includeEvidence
        ? { evidence: unknownGovernanceEvidence("Governance baseline failed: Git HEAD is empty.") }
        : {};
    }
    return {
      revision,
      ...(includeEvidence
        ? { evidence: await scanGovernanceRevision(workspacePath, revision) }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return includeEvidence
      ? { evidence: unknownGovernanceEvidence(`Governance baseline failed: ${message}`) }
      : {};
  }
}

async function scanGovernanceRevision(
  workspacePath: string,
  revision: string,
): Promise<GovernanceProofEvidence> {
  try {
    const listing = await execFileAsync(
      "git",
      ["-C", workspacePath, "ls-tree", "-r", "--name-only", revision],
      { timeout: 10_000 },
    );
    const { isGovernanceExcludedDir, isGovernanceScannableFile, uniqueNonEmptyLines } =
      await import("./assurance-command.js");
    const relativePaths = uniqueNonEmptyLines(listing.stdout)
      .filter((path) => isGovernanceScannableFile(path))
      .filter((path) => !path.split(/[\\/]/).some((part) => isGovernanceExcludedDir(part)))
      .slice(0, 500);
    const findings: GovernanceFinding[] = [];
    for (let offset = 0; offset < relativePaths.length; offset += 16) {
      const batch = relativePaths.slice(offset, offset + 16);
      const contents = await Promise.all(batch.map(async (path) => {
        const result = await execFileAsync(
          "git",
          ["-C", workspacePath, "show", `${revision}:${path}`],
          { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
        );
        return { path, content: result.stdout };
      }));
      for (const { path, content } of contents) {
        const { scanText } = await import("@osstack/governance");
        findings.push(...scanText(content, { file: join(workspacePath, path) }).findings);
      }
    }
    return {
      status: findings.length === 0 ? "pass" : "fail",
      ok: findings.length === 0,
      scanned_files: relativePaths.length,
      findings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unknownGovernanceEvidence(`Governance baseline revision scan failed: ${message}`);
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

function parseLoopGovernanceScope(
  args: string[],
  mode: LoopGovernanceMode | undefined,
): LoopGovernanceScope | undefined | Error {
  const index = args.indexOf("--govern-scope");
  if (index < 0) return mode === undefined ? undefined : "workspace";
  if (mode === undefined) return new Error("--govern-scope requires --govern");
  const value = args[index + 1];
  if (value === "workspace" || value === "changed" || value === "baseline") return value;
  return new Error("--govern-scope must be workspace, changed, or baseline");
}

function governanceScanEvidence(evidence: GovernanceProofEvidence): GovernanceScanEvidence {
  return {
    ...evidence,
    error_findings: evidence.findings.filter((finding) => finding.severity === "error").length,
  };
}

async function createLoopGovernanceEvidence(
  mode: LoopGovernanceMode,
  workspacePath: string,
  scope: LoopGovernanceScope,
  baselineSnapshot?: LoopGovernanceBaselineSnapshot,
): Promise<LoopGovernanceEvidence> {
  if (scope === "baseline") {
    if (baselineSnapshot?.evidence === undefined) {
      const evidence = governanceScanEvidence(unknownGovernanceEvidence(
        "Governance baseline scope requires pre-run workspace evidence.",
      ));
      return {
        ...evidence,
        mode,
        scope,
        blocking: false,
      };
    }

    const baseline = governanceScanEvidence(baselineSnapshot.evidence);
    const changed = governanceScanEvidence(await scanChangedWorkspaceGovernance(
      workspacePath,
      baselineSnapshot.revision,
    ));
    if (changed.status === "unknown") {
      return {
        ...changed,
        mode,
        scope,
        blocking: false,
        baseline_evidence: {
          ...baseline,
          mode: "warn",
          scope: "workspace",
          blocking: false,
        },
        changed_evidence: {
          ...changed,
          scope: "changed",
        },
        ...(baselineSnapshot.revision === undefined
          ? {}
          : { baseline_revision: baselineSnapshot.revision }),
        baseline_suppressed_findings: 0,
      };
    }

    const findings = subtractBaselineFindings(changed.findings, baseline.findings, workspacePath);
    const errorFindings = findings.filter((finding) => finding.severity === "error").length;
    return {
      status: findings.length === 0 ? "pass" : "fail",
      ok: findings.length === 0,
      scanned_files: changed.scanned_files,
      findings,
      error_findings: errorFindings,
      mode,
      scope,
      blocking: mode === "strict" && errorFindings > 0,
      baseline_evidence: {
        ...baseline,
        mode: "warn",
        scope: "workspace",
        blocking: false,
      },
      changed_evidence: {
        ...changed,
        scope: "changed",
      },
      ...(baselineSnapshot.revision === undefined
        ? {}
        : { baseline_revision: baselineSnapshot.revision }),
      baseline_suppressed_findings: changed.findings.length - findings.length,
    };
  }

  const evidence = governanceScanEvidence(scope === "changed"
    ? await scanChangedWorkspaceGovernance(workspacePath, baselineSnapshot?.revision)
    : await scanWorkspaceGovernance(workspacePath));
  return {
    ...evidence,
    mode,
    scope,
    blocking: mode === "strict" && evidence.error_findings > 0,
  };
}

function subtractBaselineFindings(
  changedFindings: GovernanceFinding[],
  baselineFindings: GovernanceFinding[],
  workspacePath: string,
): GovernanceFinding[] {
  const baselineCounts = new Map<string, number>();
  for (const finding of baselineFindings) {
    const fingerprint = governanceFindingFingerprint(finding, workspacePath);
    baselineCounts.set(fingerprint, (baselineCounts.get(fingerprint) ?? 0) + 1);
  }

  return changedFindings.filter((finding) => {
    const fingerprint = governanceFindingFingerprint(finding, workspacePath);
    const remaining = baselineCounts.get(fingerprint) ?? 0;
    if (remaining === 0) return true;
    baselineCounts.set(fingerprint, remaining - 1);
    return false;
  });
}

function governanceFindingFingerprint(finding: GovernanceFinding, workspacePath: string): string {
  const file = finding.file === undefined
    ? "<inline>"
    : relative(workspacePath, finding.file).replaceAll("\\", "/");
  return `${finding.rule_id}\u0000${file}\u0000${finding.excerpt}`;
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
    : `${governance.status}; findings=${governance.findings.length}; errors=${governance.error_findings}; mode=${governance.mode}; scope=${governance.scope}`;
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

function unknownGovernanceEvidence(reason: string): GovernanceProofEvidence {
  return {
    status: "unknown",
    ok: false,
    scanned_files: 0,
    reason,
    findings: [],
  };
}

async function createContractProofEvidence(workspacePath: string | undefined): Promise<ContractProofEvidence> {
  const resolvedWorkspace = resolve(workspacePath ?? process.cwd());
  const manifestPath = join(resolvedWorkspace, "osstack.contracts.json");
  try {
    await stat(manifestPath);
  } catch {
    return {
      schema_version: 1,
      kind: "osstack.contract_validation",
      status: "unknown",
      service: "unknown",
      manifest_path: manifestPath,
      workspace_path: resolvedWorkspace,
      checked_at: new Date().toISOString(),
      endpoints: 0,
      frontend_calls: [],
      backend_routes: [],
      findings: [],
      reason: "No osstack.contracts.json manifest found.",
    };
  }
  try {
    return await validateWorkspaceContracts({ workspacePath: resolvedWorkspace, manifestPath });
  } catch (error) {
    return {
      schema_version: 1,
      kind: "osstack.contract_validation",
      status: "fail",
      service: "unknown",
      manifest_path: manifestPath,
      workspace_path: resolvedWorkspace,
      checked_at: new Date().toISOString(),
      endpoints: 0,
      frontend_calls: [],
      backend_routes: [],
      findings: [{
        rule_id: "contract.invalid_manifest",
        severity: "error",
        kind: "invalid_manifest",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
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

async function renderPrBody(options: {
  state: LoopState;
  events: LoopEvent[];
  proofDir: string;
  governance?: unknown;
  knowledge?: unknown;
  worktree?: unknown;
  verify?: unknown;
}): Promise<string> {
  const { createLoopStateReport } = await loadLoop();
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
    ...(await renderPrPolicy(options.events)),
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
  const { parseGitHubRepoSlug } = await import("./steward-command.js");
  if (remote instanceof Error || parseGitHubRepoSlug(remote.trim()) === undefined) {
    checks.push({ id: "remote", status: "error", summary: "No GitHub origin remote was found." });
  } else {
    checks.push({ id: "remote", status: "ok", summary: `GitHub remote: ${parseGitHubRepoSlug(remote.trim())}` });
  }

  if (checks.some((check) => check.status === "error")) {
    checks.push({ id: "gh_auth", status: "warn", summary: "GitHub CLI auth check skipped because PR create preflight already has blocking errors." });
    return {
      ok: false,
      checks,
    };
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

async function renderPrPolicy(events: LoopEvent[]): Promise<string[]> {
  const { createPolicyDecisionEvidence } = await import("./proof-pack.js");
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

async function createVerifyResultsEvidence(
  scorecard: ReturnType<LoopModule["createLoopStateScorecardFromState"]>,
  events: LoopEvent[],
): Promise<{
  status: "pass" | "fail" | "unknown";
  results?: Array<{
    task_id: string;
    pass: boolean;
    score: number | "unknown";
    reviewer_agent_id: string;
    summary: string;
    event_seq: number;
    review_artifacts?: ReviewArtifact[];
  }>;
  reason?: string;
}> {
  const { ReviewArtifact: ReviewArtifactSchema } = await loadLoop();
  const results: Array<{
    task_id: string;
    pass: boolean;
    score: number | "unknown";
    reviewer_agent_id: string;
    summary: string;
    event_seq: number;
    review_artifacts?: ReviewArtifact[];
  }> = events
    .filter((event) => event.type === "loop.verify.done")
    .map((event) => {
      const reviewArtifacts = reviewArtifactsEventPayload(event, ReviewArtifactSchema);
      return {
        task_id: stringEventPayload(event, "task_id"),
        pass: booleanEventPayload(event, "pass"),
        score: numberEventPayload(event, "score") ?? "unknown",
        reviewer_agent_id: stringEventPayload(event, "reviewer_agent_id"),
        summary: stringEventPayload(event, "summary"),
        event_seq: event.seq,
        ...(reviewArtifacts !== undefined
          ? { review_artifacts: reviewArtifacts }
          : {}),
      };
    });
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

function reviewArtifactsEventPayload(
  event: LoopEvent,
  ReviewArtifactSchema: LoopModule["ReviewArtifact"],
): ReviewArtifact[] | undefined {
  const value = event.payload?.["review_artifacts"];
  if (value === undefined) return undefined;
  const parsed = ReviewArtifactSchema.array().max(100).safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid review_artifacts in loop.verify.done event seq=${event.seq}: ${parsed.error.message}`,
    );
  }
  return parsed.data.length > 0 ? parsed.data : undefined;
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
  policyDecision: ReturnType<ProofPackModule["createPolicyDecisionEvidence"]>;
  agentRuntime: ReturnType<ProofPackModule["createAgentRuntimeEvidence"]>;
  verifyResults: Awaited<ReturnType<typeof createVerifyResultsEvidence>>;
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

function validatePolicyDecisionEvidence(value: ReturnType<ProofPackModule["createPolicyDecisionEvidence"]>): string[] {
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

function validateAgentRuntimeEvidence(value: ReturnType<ProofPackModule["createAgentRuntimeEvidence"]>): string[] {
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

function validateVerifyResultsEvidence(value: Awaited<ReturnType<typeof createVerifyResultsEvidence>>): string[] {
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

async function renderReportMarkdownForArtifacts(
  state: LoopState,
  events: LoopEvent[],
  language: LoopReportLanguage = resolveLanguage(),
): Promise<string> {
  const { renderLoopStateReportFromState, renderLoopStateReportFromStateAndEvents } = await loadLoop();
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

// Observe-mode gate (R1.3, POLICY_PROFILE_V1; kernel-wired in R2.2). Load
// `.osstack/policy.yaml` for the workspace and, when `mode: observe`, refuse
// execution before any daemon RPC / worktree / task work. Absent / propose /
// execute => exactly current behavior. An invalid file fails closed (deny with
// the loader's error, reported here as exit 1). Returns an exit code to stop
// with, or `undefined` to proceed.
//
// This is the FAST-PATH gate: it delegates to the shared `makePolicyGate`
// implementation (`evaluatePolicyGate`) so it stays byte-identical to the
// kernel gate, and it fires before a daemon RPC round-trip for a snappy exit-2.
//
// SCOPE NOTE — enforcement is now kernel-level (R2.2). The same
// `makePolicyGate` backing this gate is injected into every daemon-side
// `LoopEngine` (the `loop.run` RPC and the persisted session scheduler in
// daemon.ts, via `withLoopAdapters`), so direct daemon RPC clients and the
// daemon's own scheduler are covered too — a mid-session flip to `mode:
// observe` stops the session on its next tick with a `policy_denied`
// stop_reason. This CLI gate is retained purely as fast exit-2 UX before the
// RPC; it is no longer the only enforcement point. The only intentionally
// ungated daemon path is the read-only `daily` composition (deferred to R2.3,
// and read-only work is exactly what observe mode permits).
async function enforceObservePolicyGate(workspacePath: string): Promise<number | undefined> {
  const decision = await evaluatePolicyGate(workspacePath);
  if (decision.allow) return undefined;
  console.error(`osstack: ${decision.reason}`);
  // Observe-mode refusal is exit 2; a fail-closed invalid/unreadable file is
  // exit 1 (its reason is the raw loader error, not the observe wording).
  return decision.reason === OBSERVE_POLICY_DENIED_REASON ? 2 : 1;
}

export function createDeliverCommandDeps(): DeliverCommandDeps {
  return {
    enforceObservePolicyGate,
    createShadowCheckpoint,
    createLoopGovernanceEvidence,
    captureLoopGovernanceBaseline,
    appendGovernanceVerifyEvent,
    observeLoopProbeEvents,
    writeRequestedLoopArtifacts,
    learnLessonsFromLoopState,
    startGuardedGit: startGuardedGitDelivery,
  };
}

function canonicalGuardedJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (isRecord(input)) {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

async function guardedGitText(
  workspacePath: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, ...args],
    {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return stdout.trim();
}

function githubRepoId(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const scp = trimmed.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/i,
  );
  if (scp?.[1] !== undefined) return scp[1];
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return /^[^/]+\/[^/]+$/.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function guardedProtectedPolicyPaths(
  repoConfig: Awaited<ReturnType<typeof loadRepoConfig>>,
): string[] {
  if (repoConfig?.schema_version !== 2) return [];
  const paths = new Set([
    ".osstack/repo.yaml",
    ".osstack/policy.yaml",
  ]);
  for (const target of [
    repoConfig.deploy?.staging,
    repoConfig.deploy?.production,
  ]) {
    if (target === undefined) continue;
    for (const argv of [
      target.command,
      target.verify_command,
      target.health_check,
      target.rollback,
    ]) {
      for (const token of argv) {
        if (
          !token.startsWith("-")
          && !isAbsolute(token)
          && !token.includes("://")
          && (
            token.includes("/")
            || token.endsWith(".sh")
            || token.endsWith(".mjs")
            || token.endsWith(".js")
          )
        ) {
          paths.add(token.replace(/^\.\//, ""));
        }
      }
    }
  }
  return [...paths].sort();
}

async function guardedPolicySnapshot(workspacePath: string): Promise<{
  repoConfig: Exclude<
    Awaited<ReturnType<typeof loadRepoConfig>>,
    undefined
  > & { schema_version: 2 };
  policySha256: string;
  protectedPolicyPaths: string[];
}> {
  const [repoRaw, policyRaw] = await Promise.all([
    guardedGitText(workspacePath, [
      "show",
      "HEAD:.osstack/repo.yaml",
    ]),
    guardedGitText(workspacePath, [
      "show",
      "HEAD:.osstack/policy.yaml",
    ]),
  ]);
  let repoValue: unknown;
  let policyValue: unknown;
  try {
    repoValue = parseYaml(repoRaw);
    policyValue = parseYaml(policyRaw);
  } catch (error) {
    throw new Error(
      `guarded-git base policy is invalid YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsedRepoConfig = RepoConfigSchema.parse(repoValue);
  const policyProfile = PolicyProfileSchema.parse(policyValue);
  if (parsedRepoConfig?.schema_version !== 2) {
    throw new Error(
      "guarded-git requires strict .osstack/repo.yaml schema_version 2",
    );
  }
  if (
    policyProfile === undefined
    || policyProfile.mode !== "execute"
    || policyProfile.auto_apply !== true
  ) {
    throw new Error(
      "guarded-git requires .osstack/policy.yaml mode=execute and auto_apply=true",
    );
  }
  const privatePolicyId =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
      parsedRepoConfig.product,
    )
      ? parsedRepoConfig.product
      : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
          basename(workspacePath),
        )
        ? basename(workspacePath)
        : `repo-${sha256(workspacePath).slice(0, 16)}`;
  const privateOverlay = await loadPrivateRepoOverlay(
    osstackHome(),
    privatePolicyId,
  );
  const effective = mergeRepoPolicy(
    {
      autonomy: parsedRepoConfig.autonomy,
      ...(parsedRepoConfig.deploy === undefined
        ? {}
        : { deploy: parsedRepoConfig.deploy }),
    },
    privateOverlay,
  );
  const repoConfigWithoutDeploy = { ...parsedRepoConfig };
  delete repoConfigWithoutDeploy.deploy;
  const repoConfig = RepoConfigSchema.parse({
    ...repoConfigWithoutDeploy,
    autonomy: effective.autonomy,
    ...(effective.deploy === undefined
      ? {}
      : { deploy: effective.deploy }),
  });
  if (repoConfig.schema_version !== 2) {
    throw new Error("effective guarded policy must remain schema_version 2");
  }
  if (!repoConfig.git.auto_merge) {
    throw new Error(
      "guarded-git requires repo git.auto_merge=true",
    );
  }
  if (
    !repoConfig.git.protected_branches.includes(
      repoConfig.default_branch,
    )
  ) {
    throw new Error(
      "guarded-git base branch must be listed in git.protected_branches",
    );
  }
  const protectedPolicyPaths = guardedProtectedPolicyPaths(
    repoConfig,
  );
  return {
    repoConfig,
    policySha256: sha256(
      canonicalGuardedJson({
        repo: repoConfig,
        policy: policyProfile,
        private_policy_id: privatePolicyId,
        protected_policy_paths: protectedPolicyPaths,
      }),
    ),
    protectedPolicyPaths,
  };
}

async function executeControlledRollbackDrill(
  repoId: string,
): Promise<Omit<
  RecordRollbackDrillInput,
  "drill_id" | "repo_id"
>> {
  const { readRepoRegistry } = await import("@osstack/supervisor");
  const registry = await readRepoRegistry(
    join(osstackHome(), "repos.json"),
  );
  const entry = registry.find(
    (candidate) =>
      candidate.repo_id === repoId && candidate.enabled,
  );
  if (entry === undefined) {
    throw new Error(
      `enabled repository ${repoId} is not registered in $OSSTACK_HOME/repos.json`,
    );
  }
  const workspacePath = realpathSync(entry.path);
  const policy = await guardedPolicySnapshot(workspacePath);
  const staging = policy.repoConfig.deploy?.staging;
  const production = policy.repoConfig.deploy?.production;
  if (
    staging?.enabled !== true
    || production?.enabled !== true
  ) {
    throw new Error(
      "controlled rollback drill requires enabled staging and production policies",
    );
  }
  if (
    !production.allowed_environment.includes(
      "OSSTACK_ROLLBACK_DRILL_TARGET",
    )
  ) {
    throw new Error(
      "production policy must allow OSSTACK_ROLLBACK_DRILL_TARGET for a controlled drill",
    );
  }
  const remoteUrl = await guardedGitText(workspacePath, [
    "remote",
    "get-url",
    policy.repoConfig.git.remote,
  ]);
  if (githubRepoId(remoteUrl) !== repoId) {
    throw new Error(
      "rollback drill registry id does not match the GitHub remote",
    );
  }
  await assertGuardedCandidateBase({
    workspace_path: workspacePath,
    remote: policy.repoConfig.git.remote,
    base: policy.repoConfig.default_branch,
  });
  const authority = await computeDeployScriptAuthority({
    workspace_path: workspacePath,
    policy: production,
  });
  const drillRoot = join(
    osstackHome(),
    "drills",
    `drill_${randomUUID()}`,
  );
  const drillWorkspace = join(drillRoot, "workspace");
  const sandboxHome = join(drillRoot, "home");
  const sandboxTmp = join(drillRoot, "tmp");
  await mkdir(sandboxHome, { recursive: true, mode: 0o700 });
  await mkdir(sandboxTmp, { recursive: true, mode: 0o700 });
  try {
    await materializeTrackedDrillWorkspace(
      workspacePath,
      drillWorkspace,
    );
    const copiedAuthority = await computeDeployScriptAuthority({
      workspace_path: drillWorkspace,
      policy: production,
    });
    if (
      copiedAuthority.digest_sha256 !== authority.digest_sha256
    ) {
      throw new Error(
        "controlled drill workspace script authority does not match accepted base",
      );
    }
    const startedAt = Date.now() / 1_000;
    const result = await runControlledRollbackDrill({
      workspace_path: drillWorkspace,
      policy: production,
      expected_script_digest_sha256: authority.digest_sha256,
      host_environment: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: sandboxHome,
        ...(process.env["LANG"] === undefined
          ? {}
          : { LANG: process.env["LANG"] }),
        TMPDIR: sandboxTmp,
        OSSTACK_ROLLBACK_DRILL_TARGET:
          "controlled-non-production",
      },
    });
    return {
      workspace_path: workspacePath,
      deploy_script_digest_sha256:
        result.deploy_script_digest_sha256,
      rollback: result.rollback,
      ...(result.post_rollback_health === undefined
        ? {}
        : {
            post_rollback_health:
              result.post_rollback_health,
          }),
      started_at: startedAt,
      completed_at: Date.now() / 1_000,
    };
  } finally {
    await rm(drillRoot, { recursive: true, force: true });
  }
}

async function materializeTrackedDrillWorkspace(
  sourceWorkspace: string,
  targetWorkspace: string,
): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      sourceWorkspace,
      "ls-files",
      "-z",
    ],
    {
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"],
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  await mkdir(targetWorkspace, { recursive: true, mode: 0o700 });
  for (const path of stdout.split("\0").filter((value) => value !== "")) {
    if (
      isAbsolute(path)
      || path.includes("\0")
      || path.split("/").some(
        (segment) =>
          segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new Error(`invalid tracked rollback drill path: ${path}`);
    }
    const source = resolve(sourceWorkspace, path);
    const target = resolve(targetWorkspace, path);
    if (
      relative(sourceWorkspace, source).startsWith("..")
      || relative(targetWorkspace, target).startsWith("..")
    ) {
      throw new Error(`rollback drill path escapes workspace: ${path}`);
    }
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `rollback drill requires regular tracked files: ${path}`,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, metadata.mode & 0o777);
  }
}

async function writeGuardedGitProof(
  input: GuardedGitProofInput,
): Promise<{ manifest_path: string; manifest_sha256: string }> {
  const { readLoopState } = await loadLoop();
  const statePath = join(
    input.routing.evidence_root,
    "LOOP-STATE.json",
  );
  const state = await readLoopState(statePath);
  if (state === null) {
    throw new Error("guarded proof has no persisted Loop state");
  }
  let events: LoopEvent[];
  try {
    const raw = JSON.parse(
      await readFile(
        join(input.routing.evidence_root, "events.json"),
        "utf8",
      ),
    ) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error("events.json must contain an array");
    }
    events = normalizeLoopEvents(raw);
  } catch (error) {
    throw new Error(
      `guarded proof events are invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const outputDir = join(input.routing.evidence_root, "proof");
  const artifactId = input.evidence.autonomy_run_id;
  const finalEvidence = input.stage === "final"
    ? {
        candidateProof: input.candidate_proof,
        gitDelivery: input.git_delivery,
        deployment: input.evidence,
      }
    : undefined;
  const stageInput: ProofStageInput = {
    stage: input.stage,
    risk_evidence: {
      preflight: input.evidence.preflight_risk,
      post_diff: input.evidence.post_diff_risk,
    },
    ...(
      input.evidence.approval_request === undefined
      && input.evidence.approval_decision === undefined
        ? {}
        : {
            approval_evidence: {
              ...(input.evidence.approval_request === undefined
                ? {}
                : { request: input.evidence.approval_request }),
              ...(input.evidence.approval_decision === undefined
                ? {}
                : { decision: input.evidence.approval_decision }),
            },
          }
    ),
    ...(finalEvidence === undefined
      ? {}
      : {
          supersedes: {
            manifest_path: relative(
              join(
                outputDir,
                `osstack-proof-${safeFileSegment(artifactId)}-final`,
              ),
              finalEvidence.candidateProof.manifest_path,
            ).replaceAll("\\", "/"),
            manifest_sha256:
              finalEvidence.candidateProof.manifest_sha256,
          },
          git_delivery_evidence: finalEvidence.gitDelivery,
          ...(finalEvidence.deployment.deploy_eligibility === undefined
            ? {}
            : {
                deploy_eligibility_evidence:
                  finalEvidence.deployment.deploy_eligibility,
              }),
          ...(finalEvidence.deployment.deploy_script_authority ===
          undefined
            ? {}
            : {
                deploy_script_authority_evidence:
                  finalEvidence.deployment.deploy_script_authority,
              }),
          ...(finalEvidence.deployment.deploy_staging === undefined
            ? {}
            : {
                deploy_staging_evidence:
                  finalEvidence.deployment.deploy_staging,
              }),
          ...(finalEvidence.deployment.deploy_production === undefined
            ? {}
            : {
                deploy_production_evidence:
                  finalEvidence.deployment.deploy_production,
              }),
          ...(finalEvidence.deployment.deploy_production?.rollback ===
          undefined
            ? {}
            : {
                rollback_evidence: {
                  command:
                    finalEvidence.deployment.deploy_production.rollback,
                  ...(finalEvidence.deployment.deploy_production
                      .post_rollback_health === undefined
                    ? {}
                    : {
                        post_health:
                          finalEvidence.deployment.deploy_production
                            .post_rollback_health,
                      }),
                  outcome:
                    finalEvidence.deployment.deploy_production.outcome,
                },
              }),
          ...(finalEvidence.deployment.production_freeze === undefined
            ? {}
            : {
                production_freeze_evidence:
                  finalEvidence.deployment.production_freeze,
              }),
        }),
  };
  const governance = await scanWorkspaceGovernance(
    input.evidence.intent.workspace_path,
  );
  const proof = await writeProofPack(
    state,
    outputDir,
    events,
    artifactId,
    governance,
    offKnowledgeEvidence(),
    [],
    input.evidence.intent.workspace_path,
    stageInput,
  );
  const manifest = await readFile(proof.proof_manifest);
  return {
    manifest_path: proof.proof_manifest,
    manifest_sha256: sha256Buffer(manifest),
  };
}

async function createGuardedGitRuntimeForDb(
  db: ReturnType<typeof openDb>,
  dbPath: string,
  trustedApprovalPublicKeys: ReadonlyMap<string, string>,
): Promise<GuardedGitRuntime> {
  const { GuardedGitRuntime } = await import("./guarded-git-runtime.js");
  return new GuardedGitRuntime({
    db,
    dbPath,
    trustedApprovalPublicKeys,
    writeProof: writeGuardedGitProof,
    assertPolicyUnchanged: async (workspacePath, expected) => {
      const current = await guardedPolicySnapshot(workspacePath);
      if (current.policySha256 !== expected) {
        throw new Error(
          "repository policy changed after autonomy classification",
        );
      }
    },
    evaluateGovernance: async (workspacePath) => {
      const evidence = await createLoopGovernanceEvidence(
        "strict",
        workspacePath,
        "workspace",
      );
      return {
        blocking:
          evidence.blocking || evidence.status === "unknown",
        evidence,
      };
    },
  });
}

const startGuardedGitDelivery: NonNullable<
  DeliverCommandDeps["startGuardedGit"]
> = async (input) => {
  const { GuardedGitRouting } = await import("./guarded-git-runtime.js");
  const policy = await guardedPolicySnapshot(input.workspacePath);
  const branch = await guardedGitText(
    input.workspacePath,
    ["branch", "--show-current"],
  );
  if (
    branch === ""
    || branch === policy.repoConfig.default_branch
    || !branch.startsWith(
      `${policy.repoConfig.git.branch_prefix}/`,
    )
  ) {
    throw new Error(
      `guarded-git requires a ${policy.repoConfig.git.branch_prefix}/ feature branch; found ${branch || "(detached)"}`,
    );
  }
  const verifiedBase = await assertGuardedCandidateBase({
    workspace_path: input.workspacePath,
    remote: policy.repoConfig.git.remote,
    base: policy.repoConfig.default_branch,
  });
  const remoteUrl = await guardedGitText(input.workspacePath, [
    "remote",
    "get-url",
    policy.repoConfig.git.remote,
  ]);
  const repoId = githubRepoId(remoteUrl);
  if (repoId === undefined) {
    throw new Error(
      "guarded-git remote must resolve to exactly one GitHub repository",
    );
  }
  let rollbackDrill: ReturnType<
    typeof rollbackDrillEligibilityEvidence
  >;
  if (
    input.deployPolicy === "project"
    && policy.repoConfig.deploy?.production !== undefined
  ) {
    const drillDbPath = await ensureLocalStateDbPath();
    const drillDb = openDb({ path: drillDbPath });
    try {
      rollbackDrill = rollbackDrillEligibilityEvidence(
        getLatestSuccessfulRollbackDrill(drillDb, repoId),
      );
    } finally {
      drillDb.close();
    }
  }
  const autonomyRunId = `run_${randomUUID().slice(0, 12)}`;
  const evidenceRoot = join(
    osstackHome(),
    "autonomy",
    autonomyRunId,
  );
  await mkdir(evidenceRoot, { recursive: true });
  const verifyCommands = [
    ...new Set([
      ...policy.repoConfig.verification.standard,
      ...input.verifyCommands,
    ]),
  ];
  const routing = GuardedGitRouting.parse({
    schema_version: 1,
    task: {
      task_id: input.taskId,
      capability: input.capability,
      prompt: input.prompt,
      priority: 50,
      source: "manual",
      context: {
        autonomy_run_id: autonomyRunId,
        expected_paths: [...new Set(input.expectedPaths)].sort(),
      },
    },
    profile: input.profileRouting.summary,
    verify_commands: verifyCommands,
    command_timeout_ms: input.commandTimeoutMs,
    evidence_root: evidenceRoot,
    base_commit_sha: verifiedBase.base_commit_sha,
    policy_sha256: policy.policySha256,
    max_auto_risk: policy.repoConfig.autonomy.max_auto_risk,
    protected_policy_paths: policy.protectedPolicyPaths,
    approval_ttl_ms: 3_600_000,
    ...(input.deployPolicy === "project"
      && policy.repoConfig.deploy !== undefined
      ? {
          deploy: {
            base_branch: policy.repoConfig.default_branch,
            ...policy.repoConfig.deploy,
            ...(rollbackDrill === undefined
              ? {}
              : { rollback_drill: rollbackDrill }),
          },
        }
      : {}),
    git: {
      remote: policy.repoConfig.git.remote,
      base: policy.repoConfig.default_branch,
      branch,
      title: input.prompt.replace(/\s+/g, " ").trim().slice(0, 256),
      body_file: join(evidenceRoot, "pull-request.md"),
      ci_timeout_ms: Math.min(
        policy.repoConfig.autonomy.max_wall_time_minutes
          * 60_000,
        86_400_000,
      ),
    },
  });
  const expectedPaths = [...new Set(input.expectedPaths)].sort();
  const requestedActions = [
    ...new Set(input.requestedActions),
  ].sort();
  const contractSha256 = sha256(
    canonicalGuardedJson({
      schema_version: 1,
      autonomy_run_id: autonomyRunId,
      task_id: input.taskId,
      repo_id: repoId,
      workspace_path: input.workspacePath,
      goal: input.prompt,
      expected_paths: expectedPaths,
      requested_actions: requestedActions,
      base_commit_sha: verifiedBase.base_commit_sha,
      policy_sha256: policy.policySha256,
      profile: input.profileRouting.summary,
      verify_commands: verifyCommands,
      deploy: routing.deploy ?? null,
    }),
  );
  const dbPath = await ensureLocalStateDbPath();
  const db = openDb({ path: dbPath });
  try {
    const trust = await readAutonomyApprovalTrustStore(
      join(osstackHome(), "approval-trust.json"),
    );
    const runtime = await createGuardedGitRuntimeForDb(
      db,
      dbPath,
      trust,
    );
    return await runtime.start({
      autonomy_run_id: autonomyRunId,
      task_id: input.taskId,
      repo_id: repoId,
      workspace_path: input.workspacePath,
      goal: input.prompt,
      expected_paths: expectedPaths,
      requested_actions: requestedActions,
      contract_sha256: contractSha256,
      routing,
      budget: {
        max_builder_iterations:
          policy.repoConfig.autonomy.max_builder_iterations,
        max_review_rounds:
          policy.repoConfig.autonomy.max_review_rounds,
        max_wall_time_ms:
          policy.repoConfig.autonomy.max_wall_time_minutes
          * 60_000,
        max_no_progress_rounds:
          policy.repoConfig.autonomy.max_no_progress_rounds,
      },
    });
  } finally {
    db.close();
  }
};

function ensureFlags(args: string[], flags: string[]): string[] {
  const next = [...args];
  for (const flag of flags) {
    if (!next.includes(flag)) next.push(flag);
  }
  return next;
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
  const { LoopEngine, enqueueTask, readLoopState, renderLoopStateMarkdown } = await loadLoop();
  const { resolveLoopProfileRouting } = await import("./loop-profile-routing.js");
  const sub = args[0];

  if (sub === "start") {
    const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
    const policyGate = await enforceObservePolicyGate(workspacePath);
    if (policyGate !== undefined) return policyGate;
    const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
    const markdownPath = flagValue(args, "--markdown");
    const executeCommand = flagValue(args, "--execute");
    let agentId = flagValue(args, "--agent");
    const goalCommand = flagValue(args, "--goal");
    const schedule = flagValue(args, "--schedule");
    const worktreeRoot = flagValue(args, "--worktree-root");
    const verifyCommands = flagValues(args, "--verify");
    let verifierAgentIds = [...flagValues(args, "--reviewer"), ...flagValues(args, "--checker")];
    const artifactVerification = parseArtifactVerification(args);
    const discoveryPolicy = await parseDiscoveryPolicyFlag(args, workspacePath);
    if (discoveryPolicy instanceof Error) {
      console.error(`osstack: ${discoveryPolicy.message}`);
      return 1;
    }
    const budget = await parseLoopBudgetFlags(args);
    if (budget instanceof Error) {
      console.error(`osstack: ${budget.message}`);
      return 1;
    }
    const lessonDrafts = parseLessonDraftFlags(args);
    const sources = flagValues(args, "--source");
    const maxIterRaw = flagValue(args, "--max-iter");
    const commandTimeoutRaw = flagValue(args, "--command-timeout-ms");
    const cyclesRaw = flagValue(args, "--cycles");
    const intervalRaw = flagValue(args, "--interval-ms");
    const archiveCompletedTasks = args.includes("--archive-completed");
    const once = args.includes("--once");
    const autoAgent = args.includes("--auto-agent");
    const profileRouting = await resolveLoopProfileRouting(args, agentId, verifierAgentIds);
    if (profileRouting instanceof Error) {
      console.error(`osstack: ${profileRouting.message}`);
      return 1;
    }
    if (profileRouting !== undefined) {
      agentId = agentId ?? profileRouting.agentId;
      verifierAgentIds = verifierAgentIds.length > 0 ? verifierAgentIds : profileRouting.verifierAgentIds;
    }
    const maxIterations = parsePositiveIntegerFlag(maxIterRaw, "--max-iter");
    if (maxIterations instanceof Error) {
      console.error(`osstack: ${maxIterations.message}`);
      return 1;
    }
    const commandTimeoutMs = parsePositiveIntegerFlag(commandTimeoutRaw, "--command-timeout-ms");
    if (commandTimeoutMs instanceof Error) {
      console.error(`osstack: ${commandTimeoutMs.message}`);
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
      ...(profileRouting !== undefined ? { enforceRoleSeparation: true } : {}),
      ...(profileRouting !== undefined
        ? { profileRouting: profileRouting.summary }
        : {}),
      ...(goalCommand !== undefined ? { goalCommand } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
      ...(verifierAgentIds.length > 0 ? { verifierAgentIds } : {}),
      ...(artifactVerification !== undefined ? { artifactVerification } : {}),
      ...(discoveryPolicy !== undefined ? { discoveryPolicy } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(lessonDrafts !== undefined ? { lessonDrafts } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
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
    const result = resp.result as LoopSessionSummary;
    if (profileRouting !== undefined) result.profile = profileRouting.summary;
    printLoopSession(result, args.includes("--json"));
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
    const policyGate = await enforceObservePolicyGate(workspacePath);
    if (policyGate !== undefined) return policyGate;
    const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
    const markdownPath = flagValue(args, "--markdown");
    const executeCommand = flagValue(args, "--execute");
    let agentId = flagValue(args, "--agent");
    const goalCommand = flagValue(args, "--goal");
    const worktreeRoot = flagValue(args, "--worktree-root");
    const verifyCommands = flagValues(args, "--verify");
    let verifierAgentIds = [...flagValues(args, "--reviewer"), ...flagValues(args, "--checker")];
    const artifactVerification = parseArtifactVerification(args);
    const discoveryPolicy = await parseDiscoveryPolicyFlag(args, workspacePath);
    if (discoveryPolicy instanceof Error) {
      console.error(`osstack: ${discoveryPolicy.message}`);
      return 1;
    }
    const budget = await parseLoopBudgetFlags(args);
    if (budget instanceof Error) {
      console.error(`osstack: ${budget.message}`);
      return 1;
    }
    const lessonDrafts = parseLessonDraftFlags(args);
    const sources = flagValues(args, "--source");
    const maxIterRaw = flagValue(args, "--max-iter");
    const commandTimeoutRaw = flagValue(args, "--command-timeout-ms");
    const cyclesRaw = flagValue(args, "--cycles");
    const intervalRaw = flagValue(args, "--interval-ms");
    const json = args.includes("--json");
    const useDaemon = args.includes("--daemon");
    const stopWhenIdle = args.includes("--stop-when-idle");
    const archiveCompletedTasks = args.includes("--archive-completed");
    const autoAgent = args.includes("--auto-agent");
    const selfImprovementEnabled = args.includes("--self-improvement");
    const neatFinalize = args.includes("--neat-finalize");
    const selfImprovementRepoId = flagValue(args, "--repo-id");
    const proposeImprovements = args.includes("--propose-improvements");
    if (selfImprovementEnabled && selfImprovementRepoId === undefined) {
      console.error("osstack: --self-improvement requires --repo-id <id>");
      return 1;
    }
    if (selfImprovementEnabled && useDaemon) {
      console.error("osstack: --self-improvement is local-only and cannot be combined with --daemon");
      return 1;
    }
    const profileRouting = await resolveLoopProfileRouting(args, agentId, verifierAgentIds);
    if (profileRouting instanceof Error) {
      console.error(`osstack: ${profileRouting.message}`);
      return 1;
    }
    if (profileRouting !== undefined) {
      agentId = agentId ?? profileRouting.agentId;
      verifierAgentIds = verifierAgentIds.length > 0 ? verifierAgentIds : profileRouting.verifierAgentIds;
    }
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
    const governanceScope = parseLoopGovernanceScope(args, governanceMode);
    if (governanceScope instanceof Error) {
      console.error(`osstack: ${governanceScope.message}`);
      return 1;
    }
    const governanceBaseline = governanceScope === "baseline" || governanceScope === "changed"
      ? await captureLoopGovernanceBaseline(workspacePath, governanceScope === "baseline")
      : undefined;
    const maxIterations = parsePositiveIntegerFlag(maxIterRaw, "--max-iter");
    if (maxIterations instanceof Error) {
      console.error(`osstack: ${maxIterations.message}`);
      return 1;
    }
    const commandTimeoutMs = parsePositiveIntegerFlag(commandTimeoutRaw, "--command-timeout-ms");
    if (commandTimeoutMs instanceof Error) {
      console.error(`osstack: ${commandTimeoutMs.message}`);
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
        ...(profileRouting !== undefined ? { enforceRoleSeparation: true } : {}),
        ...(profileRouting !== undefined
          ? { profileRouting: profileRouting.summary }
          : {}),
        ...(goalCommand !== undefined ? { goalCommand } : {}),
        ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
        ...(verifierAgentIds.length > 0 ? { verifierAgentIds } : {}),
        ...(artifactVerification !== undefined ? { artifactVerification } : {}),
        ...(discoveryPolicy !== undefined ? { discoveryPolicy } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(lessonDrafts !== undefined ? { lessonDrafts } : {}),
        ...(sources.length > 0 ? { sources } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
        ...(cycles !== undefined ? { cycles } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(archiveCompletedTasks ? { archiveCompletedTasks } : {}),
        ...(stopWhenIdle ? { stopWhenIdle } : {}),
        ...(useWorktree ? { useWorktree: true } : {}),
        ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
        ...(shouldRecordLoopKnowledge(args, knowledge) ? { knowledge } : {}),
        ...(neatFinalize ? { neatFinalize: true } : {}),
      }) as RpcResp;
      if (!resp.ok) {
        console.error("osstack:", resp.error?.message ?? "loop.run failed");
        return 1;
      }
      const result = resp.result as LoopRunSummary;
      const governance = governanceMode === undefined
        ? undefined
        : await createLoopGovernanceEvidence(governanceMode, workspacePath, governanceScope!, governanceBaseline);
      const events = governance === undefined
        ? normalizeLoopEvents(result.events)
        : appendGovernanceVerifyEvent(normalizeLoopEvents(result.events), result.loop_id, governance);
      if (events.length > 0) result.events = events;
      if (governance !== undefined) result.governance = governance;
      const probeObservation = await observeLoopProbeEvents(workspacePath, events);
      if (probeObservation !== undefined) result.probe_observation = probeObservation;
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
      if (profileRouting !== undefined) result.profile = profileRouting.summary;
      const persistedState = await readLoopState(resolveLoopPath(stateFilePath, workspacePath));
      if (persistedState !== null) {
        const learnedLessons = await learnLessonsFromLoopState(persistedState);
        if (learnedLessons !== undefined) result.learned_lessons = learnedLessons;
      }
      printLoopRun(result, json);
      return result.completed_tasks.some((task) => task.outcome !== "success")
        || governance?.blocking === true
        || result.budget?.exceeded === true
        ? 2
        : 0;
    }

    const adapters = agentId !== undefined || verifierAgentIds.length > 0 || autoAgent
      ? (await import("@osstack/agents")).defaultAdapters()
      : undefined;
    const selfImprovement = selfImprovementEnabled
      ? (await import("./loop-self-improvement.js")).buildSelfImprovementConfig({
          repoId: selfImprovementRepoId!,
          proposeImprovements,
          registryPath: resolveRegistryPath(args),
        })
      : undefined;
    const engine = new LoopEngine({
      workspacePath,
      stateFilePath,
      ...(markdownPath !== undefined ? { markdownPath } : {}),
      ...(executeCommand !== undefined ? { executeCommand } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(autoAgent ? { autoAgent } : {}),
      ...(profileRouting !== undefined ? { enforceRoleSeparation: true } : {}),
      ...(profileRouting !== undefined
        ? { profileRouting: profileRouting.summary }
        : {}),
      ...(adapters !== undefined ? { adapters } : {}),
      ...(verifierAgentIds.length > 0 ? { verifierAgentIds } : {}),
      ...(artifactVerification !== undefined ? { artifactVerification } : {}),
      ...(discoveryPolicy !== undefined ? { discoveryPolicy } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(lessonDrafts !== undefined ? { lessonDrafts } : {}),
      ...(goalCommand !== undefined ? { goalCommand } : {}),
      ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
      ...(archiveCompletedTasks ? { archiveCompletedTasks } : {}),
      ...(useWorktree ? { useWorktree: true } : {}),
      ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
      ...(selfImprovement !== undefined ? { selfImprovement } : {}),
      ...(shouldRecordLoopKnowledge(args, knowledge) ? { knowledge } : {}),
      // Kernel gate (R2.2): defense-in-depth over the upfront gate; a mid-run
      // flip to observe stops `--cycles` runs cleanly on the next tick.
      policyGate: makePolicyGate(workspacePath),
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
      : await createLoopGovernanceEvidence(governanceMode, workspacePath, governanceScope!, governanceBaseline);
    const events = governance === undefined
      ? result.events
      : appendGovernanceVerifyEvent(result.events, result.loop_id, governance);
    const probeObservation = await observeLoopProbeEvents(workspacePath, events);
    const artifacts = await writeRequestedLoopArtifacts(result.state, workspacePath, args, events, governance);
    const learnedLessons = await learnLessonsFromLoopState(result.state);
    const { runLoopNeatFinalizer } = await import("./loop-neat-finalizer.js");
    const knowledgeHygiene = await runLoopNeatFinalizer({
      enabled: neatFinalize,
      loop_succeeded: result.state.completed_tasks.length > 0
        && result.state.completed_tasks.every((task) => task.outcome === "success")
        && governance?.blocking !== true
        && result.budget?.exceeded !== true,
      workspace_path: workspacePath,
    });
    printLoopRun({
      loop_id: result.loop_id,
      json_path: result.jsonPath,
      markdown_path: result.markdownPath,
      completed_tasks: result.state.completed_tasks,
      events,
      ...(probeObservation === undefined ? {} : { probe_observation: probeObservation }),
      ...(artifacts !== undefined ? { artifacts } : {}),
      ...(learnedLessons !== undefined ? { learned_lessons: learnedLessons } : {}),
      ...(governance !== undefined ? { governance } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      ...(profileRouting !== undefined ? { profile: profileRouting.summary } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(result.budget !== undefined ? { budget: result.budget } : {}),
      ...(result.state.key_metrics !== undefined ? { metrics: result.state.key_metrics } : {}),
      ...(knowledgeHygiene !== undefined ? { knowledge_hygiene: knowledgeHygiene } : {}),
      ...("cycles" in result ? { cycles: result.cycles.map((cycle) => ({
        discovered_task_count: cycle.discoveredTaskCount,
        executed_task_count: cycle.executedTaskCount,
        skipped_task_count: cycle.skippedTaskCount,
        ...(cycle.goal !== undefined ? { goal: cycle.goal } : {}),
      })) } : {}),
    }, json);
    return result.state.completed_tasks.some((task) => task.outcome !== "success")
      || governance?.blocking === true
      || result.budget?.exceeded === true
      ? 2
      : 0;
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

  if (sub === "lessons") {
    return await handleLoopLessonsCommand(args.slice(1));
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
  osstack loop lessons <action>    Review SOP lesson drafts (list/show/promote/discard)
  osstack loop doctor [options]    Check workspace, queue, git, and daemon readiness
  osstack loop list [--json]       List daemon-managed polling loops
  osstack loop stop <id> [--json]  Stop a daemon-managed polling loop
  osstack loop status [options]    Print current loop state

Options:
  --workspace P       Workspace to scan and run commands in (default: cwd)
  --source S          Discovery source; repeatable. git_diff | task_queue | github_branch
  --agent ID          Run tasks through a registered adapter (for example codex-cli)
  --auto-agent        Let router + policy choose an available adapter by capability
  --profile P         Resolve Builder/Evaluator/Designer from a device profile
  --role R=ID         Override one profile role: coder, evaluator, or designer; repeatable
  --execute CMD       Shell command to run for each task
  --verify CMD        Shell verifier; repeatable. Non-zero exit marks failure
  --reviewer ID       Adapter verifier to run after execution; repeatable
  --checker ID        Alias for --reviewer for checker/verifier agents
  --artifact-verification
                      Require artifact gates in verification (git diff, target/forbidden paths)
  --discovery-policy P
                      Discovery governance: "default" or a JSON policy file. Non-auto tasks
                      are recorded as needs_approval/suggest_only/blocked instead of executing
  --target-path P     Required changed path/prefix for artifact verification; repeatable
  --forbid-path P     Forbidden changed path/prefix for artifact verification; repeatable
  --goal CMD          Global shell command; loop stops when it exits 0
  --command-timeout-ms N
                      Timeout in milliseconds for execute, verify, and goal commands
  --schedule CRON     Cron schedule for daemon-managed loop start
  --archive-completed Move successful single-task queue files into tasks/archive/
  --checkpoint       Create a shadow checkpoint before non-worktree runs
  --worktree         Run each task in an isolated git worktree, merge success back
  --worktree-root P  Directory for temporary isolated worktrees
  --max-iter N        Iterations before escalation (default: 1)
  --max-runtime-ms N  Budget: stop after N ms total runtime (exit code 2)
  --max-tokens N      Budget: stop after N adapter-reported tokens (in+out)
  --max-cost-usd X    Budget: stop after an adapter-reported spend of X USD
  --no-progress-limit N
                      Budget: opt in to stop after N consecutive cycles that ran
                      tasks without any success (exit code 2)
  --no-lesson-drafts  Disable SOP lesson drafts after recovered failures
  --lessons-dir P     Directory for lesson drafts (default: loop-lessons/drafts)
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
  --govern-scope S    Governance scope: workspace (legacy), changed, or baseline.
                      baseline records pre-run full-workspace warn evidence and
                      gates only changed-file findings not present in that baseline
  --neat-finalize     After a successful run, attach non-gating neat evidence
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

async function handleLoopLessonsCommand(args: string[]): Promise<number> {
  const { discardLessonDraft, listLessonDrafts, promoteLessonDraft, readLessonDraft } = await loadLoop();
  const action = args[0];
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const lessonsDir = flagValue(args, "--lessons-dir") ?? "loop-lessons/drafts";
  const json = args.includes("--json");

  if (action === "list" || action === undefined) {
    const drafts = await listLessonDrafts(workspacePath, lessonsDir);
    if (json) {
      console.log(JSON.stringify({ drafts }, null, 2));
      return 0;
    }
    if (drafts.length === 0) {
      console.log("No lesson drafts.");
      return 0;
    }
    for (const draft of drafts) {
      const skill = draft.suggested_skill !== undefined ? ` skill=${draft.suggested_skill}` : "";
      console.log(`${draft.id}${skill}`);
      console.log(`  ${draft.path}`);
    }
    return 0;
  }

  if (action === "show") {
    const id = args[1];
    if (id === undefined || id.startsWith("--")) {
      console.error("osstack: loop lessons show requires a draft id");
      return 1;
    }
    const draft = await readLessonDraft(workspacePath, id, lessonsDir);
    if (draft === null) {
      console.error(`osstack: no lesson draft found for id ${id}`);
      return 1;
    }
    console.log(draft.content);
    return 0;
  }

  if (action === "promote") {
    const id = args[1];
    if (id === undefined || id.startsWith("--")) {
      console.error("osstack: loop lessons promote requires a draft id");
      return 1;
    }
    const toSkillPath = flagValue(args, "--to-skill");
    const result = await promoteLessonDraft(workspacePath, id, {
      dir: lessonsDir,
      ...(toSkillPath !== undefined ? { toSkillPath } : {}),
    });
    if (!result.promoted) {
      console.error(`osstack: ${result.reason ?? "promote failed"}`);
      return 1;
    }
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`promoted=${result.to}`);
      if (result.appended_to !== undefined) console.log(`appended_to=${result.appended_to}`);
    }
    return 0;
  }

  if (action === "discard") {
    const id = args[1];
    if (id === undefined || id.startsWith("--")) {
      console.error("osstack: loop lessons discard requires a draft id");
      return 1;
    }
    const result = await discardLessonDraft(workspacePath, id, { dir: lessonsDir });
    if (!result.discarded) {
      console.error(`osstack: ${result.reason ?? "discard failed"}`);
      return 1;
    }
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`discarded=${result.to}`);
    }
    return 0;
  }

  if (action === "help" || action === "--help" || action === "-h") {
    printLoopLessonsHelp();
    return 0;
  }

  console.error(`osstack: unknown loop lessons action "${action}"`);
  printLoopLessonsHelp();
  return 1;
}

function printLoopLessonsHelp(): void {
  console.log(`osstack loop lessons — review SOP lesson drafts

  osstack loop lessons list [--workspace P] [--lessons-dir P] [--json]
  osstack loop lessons show <id> [--workspace P] [--lessons-dir P]
  osstack loop lessons promote <id> [--to-skill PATH] [--json]
  osstack loop lessons discard <id> [--json]

Promoting moves the draft to loop-lessons/promoted/. Only with an explicit
--to-skill PATH is the lesson appended to that skill file — the loop never
modifies official skills on its own. --to-skill must point at a SKILL.md file
(may live outside the workspace); any other target is refused.
`);
}

function resolveLoopPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function parseLessonDraftFlags(args: string[]): { enabled?: boolean; dir?: string } | undefined {
  const disabled = args.includes("--no-lesson-drafts");
  const dir = flagValue(args, "--lessons-dir");
  if (!disabled && dir === undefined) return undefined;
  return {
    ...(disabled ? { enabled: false } : {}),
    ...(dir !== undefined ? { dir } : {}),
  };
}

async function parseLoopBudgetFlags(args: string[]): Promise<LoopBudget | undefined | Error> {
  const { LoopBudget: LoopBudgetSchema } = await loadLoop();
  // Runtime and no-progress always enforce. Token/cost enforce against
  // adapter-reported usage (usage.final events) and stay at 0 when adapters
  // don't report — so these caps trip only when there is real usage to measure.
  const maxRuntimeMs = parsePositiveIntegerFlag(flagValue(args, "--max-runtime-ms"), "--max-runtime-ms");
  if (maxRuntimeMs instanceof Error) return maxRuntimeMs;
  const maxTokens = parsePositiveIntegerFlag(flagValue(args, "--max-tokens"), "--max-tokens");
  if (maxTokens instanceof Error) return maxTokens;
  const noProgressLimit = parsePositiveIntegerFlag(flagValue(args, "--no-progress-limit"), "--no-progress-limit");
  if (noProgressLimit instanceof Error) return noProgressLimit;
  const maxCostRaw = flagValue(args, "--max-cost-usd");
  let maxCostUsd: number | undefined;
  if (maxCostRaw !== undefined) {
    maxCostUsd = Number(maxCostRaw);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      return new Error("--max-cost-usd must be a positive number");
    }
  }
  if (
    maxRuntimeMs === undefined
    && maxTokens === undefined
    && noProgressLimit === undefined
    && maxCostUsd === undefined
  ) {
    return undefined;
  }
  return LoopBudgetSchema.parse({
    ...(maxRuntimeMs !== undefined ? { max_runtime_ms: maxRuntimeMs } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(noProgressLimit !== undefined ? { no_progress_limit: noProgressLimit } : {}),
    ...(maxCostUsd !== undefined ? { max_estimated_cost_usd: maxCostUsd } : {}),
  });
}

async function parseDiscoveryPolicyFlag(
  args: string[],
  workspacePath: string,
): Promise<DiscoveryPolicy | undefined | Error> {
  const { DEFAULT_DISCOVERY_POLICY, DiscoveryPolicy: DiscoveryPolicySchema } = await loadLoop();
  const raw = flagValue(args, "--discovery-policy");
  if (raw === undefined) return undefined;
  if (raw === "default") return DEFAULT_DISCOVERY_POLICY;
  const path = isAbsolute(raw) ? raw : join(workspacePath, raw);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch (error) {
    return new Error(`--discovery-policy could not read ${raw}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = DiscoveryPolicySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return new Error(`--discovery-policy file ${raw} is not a valid discovery policy`);
  }
  return parsed.data;
}

function parseArtifactVerification(args: string[]): ArtifactVerificationOptions | undefined {
  const enabled = args.includes("--artifact-verification")
    || process.env["OSSTACK_ARTIFACT_VERIFICATION"] === "1";
  const targetPaths = flagValues(args, "--target-path");
  const forbiddenPaths = flagValues(args, "--forbid-path");
  if (!enabled && targetPaths.length === 0 && forbiddenPaths.length === 0) return undefined;
  return {
    requireGitDiff: enabled || targetPaths.length > 0,
    ...(targetPaths.length > 0 ? { targetPaths } : {}),
    ...(forbiddenPaths.length > 0 ? { forbiddenPaths } : {}),
  };
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
  profile?: LoopProfileSummary;
  budget?: LoopBudgetStatus;
  knowledge_hygiene?: LoopNeatFinalizerResultV1;
  probe_observation?: LoopProbeObservationSummaryV1;
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

type LoopProbeObservationSummaryV1 =
  | ({ status: "ok" } & LoopProbeObservationResultV1)
  | { status: "error"; message: string };

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
  profile?: LoopProfileSummary;
}

interface StatsResult {
  total_runs: number;
  total_events: number;
  per_agent: AgentStatsRow[];
  loops?: LoopStatsSummary;
  rpc?: RpcLatencyRow[];
}

interface RpcLatencyRow {
  method: string;
  count: number;
  window: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
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
  if (result.budget !== undefined) {
    const detail = result.budget.exceeded ? ` limit=${result.budget.limit} reason=${result.budget.reason}` : "";
    console.log(`budget=${result.budget.exceeded ? "exceeded" : "within"}${detail}`);
  }
  if (result.governance !== undefined) {
    console.log(`governance=${result.governance.status} mode=${result.governance.mode} blocking=${result.governance.blocking ? "yes" : "no"} findings=${result.governance.findings.length}`);
  }
  if (result.knowledge_hygiene !== undefined) {
    if (result.knowledge_hygiene.status === "error") {
      console.log(`knowledge_hygiene=error message=${result.knowledge_hygiene.error}`);
    } else {
      const report = result.knowledge_hygiene.report;
      console.log(`knowledge_hygiene=${report.completeness.complete ? "complete" : "incomplete"} findings=${report.findings.length}`);
    }
  }
  if (result.probe_observation !== undefined) {
    if (result.probe_observation.status === "error") {
      console.log(`probe_observation=error message=${result.probe_observation.message}`);
    } else {
      console.log(`probe_observation=ok observed=${result.probe_observation.observed} added=${result.probe_observation.added} replayed=${result.probe_observation.replayed}`);
    }
  }
  if (result.profile !== undefined) {
    console.log(`profile=${result.profile.profile_name} builder=${result.profile.builder_agent_id ?? "none"} evaluator=${result.profile.evaluator_agent_id ?? "none"}`);
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
  if (result.profile !== undefined) {
    console.log(`profile=${result.profile.profile_name} builder=${result.profile.builder_agent_id ?? "none"} evaluator=${result.profile.evaluator_agent_id ?? "none"}`);
  }
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

// ── daily scheduling (R2.3) — daemon-managed read-only brief sessions ─────────

interface DailySessionSummary {
  daily_session_id: string;
  registry_path: string;
  status: "running" | "stopping" | "stopped" | "failed";
  interval_ms: number;
  schedule?: string;
  started_at: number;
  updated_at: number;
  tick_count: number;
  consecutive_failure_count: number;
  last_brief_path?: string;
  last_result_status?: string;
  stop_reason?: string;
  last_error?: string;
}

/**
 * `osstack daily schedule|sessions|unschedule` — the daemon-managed side of the
 * read-only daily brief (bare `osstack daily` stays the in-process manual run).
 * Mirrors `loop start|list|stop` conventions, and requires a running daemon
 * (the shared `rpc` helper surfaces the standard "daemon not running" refusal).
 */
async function handleDailyScheduleCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === "schedule") {
    const intervalMs = parseNonNegativeIntegerFlag(flagValue(args, "--interval-ms"), "--interval-ms");
    if (intervalMs instanceof Error) {
      console.error(`osstack: ${intervalMs.message}`);
      return 1;
    }
    if (intervalMs === undefined) {
      console.error("osstack: daily schedule requires --interval-ms <ms>");
      return 1;
    }
    // Resolve the registry path here (client cwd/OSSTACK_HOME) and hand the
    // daemon an absolute path it stores verbatim — same resolution the manual
    // `daily` run uses, so a scheduled brief reads the same registry.
    const registryPath = resolveRegistryPath(args);
    const scheduleExpression = flagValue(args, "--schedule");
    const resp = await rpc("daily.schedule", {
      intervalMs,
      registryPath,
      ...(scheduleExpression !== undefined ? { schedule: scheduleExpression } : {}),
    }) as RpcResp;
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "daily.schedule failed");
      return 1;
    }
    printDailySession(resp.result as DailySessionSummary, args.includes("--json"));
    return 0;
  }

  if (sub === "sessions") {
    const resp = await rpc("daily.list") as RpcResp;
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "daily.list failed");
      return 1;
    }
    const result = resp.result as { daily: DailySessionSummary[] };
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    printDailySessionList(result.daily);
    return 0;
  }

  if (sub === "unschedule") {
    const dailySessionId = args[1];
    if (dailySessionId === undefined || dailySessionId.startsWith("--")) {
      console.error("osstack: daily unschedule requires a daily_session_id");
      return 1;
    }
    const resp = await rpc("daily.stop", { dailySessionId }) as RpcResp;
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "daily.stop failed");
      return 1;
    }
    printDailySession(resp.result as DailySessionSummary, args.includes("--json"));
    return 0;
  }

  console.error(`osstack: unknown daily subcommand: ${sub ?? ""}`);
  return 1;
}

function printDailySession(result: DailySessionSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`daily_session_id=${result.daily_session_id}`);
  console.log(`status=${result.status}`);
  console.log(`registry=${result.registry_path}`);
  console.log(`interval_ms=${result.interval_ms}`);
  if (result.schedule !== undefined) console.log(`schedule=${result.schedule}`);
  console.log(`ticks=${result.tick_count} consecutive_failures=${result.consecutive_failure_count}`);
  if (result.last_result_status !== undefined) console.log(`last_result_status=${result.last_result_status}`);
  if (result.last_brief_path !== undefined) console.log(`last_brief_path=${result.last_brief_path}`);
  if (result.stop_reason !== undefined) console.log(`stop_reason=${result.stop_reason}`);
  if (result.last_error !== undefined) console.log(`last_error=${result.last_error}`);
}

function printDailySessionList(sessions: DailySessionSummary[]): void {
  if (sessions.length === 0) {
    console.log("No daily sessions.");
    return;
  }
  for (const session of sessions) {
    console.log(`${session.daily_session_id}  ${session.status}  ticks=${session.tick_count} interval_ms=${session.interval_ms}  ${session.registry_path}`);
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
    await addInstructionSourceDoctorCheck(input.workspacePath, add);
    await checkProtectedConfigStatus(input.workspacePath, add);
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
  const { countTaskQueueTasks } = await loadLoop();
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

async function addInstructionSourceDoctorCheck(
  workspacePath: string,
  add: (id: string, status: LoopDoctorCheck["status"], summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  const agentsPath = join(workspacePath, "AGENTS.md");
  const claudePath = join(workspacePath, "CLAUDE.md");
  const { inspectInstructionSource } = await import("@osstack/governance");
  const observation = await inspectInstructionSource({
    repo_root: workspacePath,
    canonical_path: "AGENTS.md",
    mirror_path: "CLAUDE.md",
    mirror_mode: "import_or_symlink",
  });

  if (observation.status === "both_missing") {
    add("agent_instructions", "warn", "no AGENTS.md or CLAUDE.md found at workspace root", {
      expected_source: agentsPath,
    });
    return;
  }
  if (observation.status === "mirror_missing") {
    add("agent_instructions", "ok", "AGENTS.md is the only root instruction source", {
      source: agentsPath,
    });
    return;
  }
  if (observation.status === "canonical_missing") {
    add("agent_instructions", "error", "CLAUDE.md exists without AGENTS.md; instruction source is not unified", {
      claude: claudePath,
      expected_source: agentsPath,
    });
    return;
  }

  if (observation.status === "valid_mirror") {
    add("agent_instructions", "ok", "AGENTS.md is canonical and CLAUDE.md references it", {
      source: agentsPath,
      claude: claudePath,
      mode: observation.mirror_kind === "import" ? "one-line-reference" : "symlink",
    });
    return;
  }

  add("agent_instructions", "error", "AGENTS.md and CLAUDE.md are both real instruction files; drift risk detected", {
    source: agentsPath,
    claude: claudePath,
    reason: observation.reason,
    remediation: "replace CLAUDE.md with a one-line @AGENTS.md reference or a symlink to AGENTS.md",
  });
}

async function checkProtectedConfigStatus(
  workspacePath: string,
  add: (id: string, status: LoopDoctorCheck["status"], summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  const protectedFiles = ["AGENTS.md", "CLAUDE.md", ".codex/config.toml"];
  const status = await execOutput("git", ["status", "--porcelain=v1", "--", ...protectedFiles], workspacePath);
  if (status instanceof Error) {
    add("protected_config", "warn", "could not check protected config file status", {
      protected_files: protectedFiles,
      error: status.message,
    });
    return;
  }
  const changed = status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  if (changed.length === 0) {
    add("protected_config", "ok", "core instruction/config files are unchanged", {
      protected_files: protectedFiles,
    });
    return;
  }
  add("protected_config", "warn", "core instruction/config files have local changes; memory hooks must not write these paths", {
    protected_files: protectedFiles,
    changed,
  });
}

async function checkLoopDaemon(
  add: (id: string, status: LoopDoctorCheck["status"], summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const response = await rpc("health", undefined, 1_000) as RpcResp;
    if (response.ok) {
      // Reachable is not the same as accepting work: a draining daemon
      // rejects session starts and task submissions (daemon.ts "draining"),
      // so reporting a plain ok here sends callers into refusals.
      const health = isRecord(response.result) ? response.result : {};
      if (health["draining"] === true) {
        add("daemon", "error", "daemon is draining — new tasks and sessions are refused", {
          socket: socketPath(),
          health: response.result,
          remedy: "check free disk (autonomy drains below 2 GiB) and restart the daemon once it recovers",
        });
      } else {
        add("daemon", "ok", "daemon RPC is reachable", {
          socket: socketPath(),
          health: response.result,
        });
      }
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
  const snapshotParams = dashboardSnapshotParams(args);

  if (sub === "summary") {
    const [healthResp, snapshotResp] = await Promise.all([
      rpc("health") as Promise<RpcResp>,
      rpc("dashboard.snapshot", snapshotParams) as Promise<RpcResp>,
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
      cockpit: workspaceScopedCockpitSnapshot(snapshotResp.result, args),
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
    console.log(workspaceDashboardUrl(url, args));
    return 0;
  }

  if (sub === "open") {
    const resp = (await rpc("dashboard.url")) as { ok: boolean; result?: { url?: string | null }; error?: { message: string } };
    if (!resp.ok || !resp.result?.url) {
      console.error("osstack:", resp.error?.message ?? "dashboard URL is not available");
      return 1;
    }
    const { spawn } = await import("node:child_process");
    const url = workspaceDashboardUrl(resp.result.url, args);
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    console.log(url);
    return 0;
  }

  if (sub === "snapshot") {
    const resp = (await rpc("dashboard.snapshot", snapshotParams)) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!resp.ok) {
      console.error("osstack:", resp.error?.message ?? "dashboard.snapshot failed");
      return 1;
    }
    console.log(JSON.stringify(workspaceScopedCockpitSnapshot(resp.result, args), null, 2));
    return 0;
  }

  if (sub === "tui") {
    return await handleCockpitTuiCommand(args.slice(1));
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
  osstack cockpit --workspace P
                            Include project-local release readiness evidence
  osstack cockpit run [loop run options]
                            Run queued work with report, scorecard, and proof defaults
  osstack cockpit next [--workspace P] [--status ready|running|blocked] [--json]
                            Print actionable next steps from the cockpit snapshot
  osstack cockpit tui [--workspace P] [--json] [--no-color] [--fullscreen] [--action N] [--execute-action] [--interactive]
                            Render a terminal cockpit panel for live workbench use
  osstack cockpit retry [task_id] [--workspace P] [--state P] [--json]
                            Requeue a failed or escalated task from loop state
  osstack cockpit approve <card_id> [--comment TEXT] [--json]
                            Approve a kanban card by moving it to done
  osstack cockpit report [run_id] [--workspace P] [--state P] [--events P] [--output P] [--open]
                            Generate a cockpit report from loop evidence
  osstack cockpit proof [run_id] [--workspace P] [--state P] [--events P] [--output-dir P] [--open]
                            Generate a proof pack from loop evidence
  osstack dashboard url [--workspace P]
                              Print the URL for chat bots to return
  osstack dashboard open [--workspace P]
                              Open the dashboard locally
  osstack dashboard snapshot [--workspace P]
                              Print the JSON backing the dashboard
  osstack dashboard summary [--workspace P]
                              Show the same product cockpit summary
  osstack dashboard next [--workspace P] [--status ready|running|blocked]
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

function dashboardSnapshotParams(args: string[]): { workspacePath?: string } | undefined {
  const workspacePath = flagValue(args, "--workspace");
  return workspacePath === undefined ? undefined : { workspacePath: resolve(workspacePath) };
}

function workspaceDashboardUrl(url: string, args: string[]): string {
  const workspacePath = flagValue(args, "--workspace");
  if (workspacePath === undefined) return url;
  const nextUrl = new URL(url);
  nextUrl.searchParams.set("workspace", resolve(workspacePath));
  return nextUrl.toString();
}

function workspaceScopedCockpitSnapshot(snapshot: unknown, args: string[]): unknown {
  if (!isRecord(snapshot)) return snapshot;
  const dashboard = isRecord(snapshot["dashboard"]) ? snapshot["dashboard"] : undefined;
  if (dashboard === undefined || typeof dashboard["url"] !== "string") return snapshot;
  return {
    ...snapshot,
    dashboard: {
      ...dashboard,
      url: workspaceDashboardUrl(dashboard["url"], args),
    },
  };
}

async function handleCockpitTuiCommand(args: string[]): Promise<number> {
  const actionIndex = parsePositiveIntegerFlag(flagValue(args, "--action"), "--action");
  if (actionIndex instanceof Error) {
    console.error("osstack:", actionIndex.message);
    return 1;
  }
  const [healthResp, snapshotResp] = await Promise.all([
    rpc("health") as Promise<RpcResp>,
    rpc("dashboard.snapshot", dashboardSnapshotParams(args)) as Promise<RpcResp>,
  ]);
  if (!healthResp.ok) {
    console.error("osstack:", healthResp.error?.message ?? "health failed");
    return 1;
  }
  if (!snapshotResp.ok) {
    console.error("osstack:", snapshotResp.error?.message ?? "dashboard.snapshot failed");
    return 1;
  }
  const snapshot = workspaceScopedCockpitSnapshot(snapshotResp.result, args);
  const knowledge = await cockpitKnowledgeSummary(args);
  const model = cockpitTuiModel(healthResp.result, snapshot, knowledge);
  if (args.includes("--interactive")) {
    if (args.includes("--fullscreen")) {
      return await runInteractiveCockpitFullscreen(model, { json: args.includes("--json") });
    }
    return await runInteractiveCockpitTui(model, { json: args.includes("--json") });
  }
  if (actionIndex !== undefined) {
    const selected = selectCockpitTuiAction(model, actionIndex);
    if (selected === undefined) {
      console.error(`osstack: cockpit tui action must be between 1 and ${model.actions.length || 0}`);
      return 1;
    }
    if (args.includes("--execute-action")) {
      return await executeCockpitTuiAction(selected, { json: args.includes("--json") });
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(selected, null, 2));
    } else {
      console.log(renderCockpitTuiAction(selected));
    }
    return 0;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(model, null, 2));
  } else if (args.includes("--fullscreen")) {
    console.log(renderCockpitFullscreen(model));
  } else {
    console.log(renderCockpitTui(model));
  }
  return 0;
}

async function cockpitKnowledgeSummary(args: string[]): Promise<CockpitKnowledgeSummary> {
  const cacheDir = knowledgeCacheDir(args);
  const packs = await listCachedKnowledgePacks(cacheDir);
  const topPack = [...packs].sort((a, b) => (
    b.manifest.quality_score - a.manifest.quality_score
    || a.manifest.id.localeCompare(b.manifest.id)
  ))[0];
  return {
    cache_dir: cacheDir,
    pack_count: packs.length,
    official: packs.filter((pack) => pack.manifest.scope === "official").length,
    team: packs.filter((pack) => pack.manifest.scope === "team").length,
    project: packs.filter((pack) => pack.manifest.scope === "project").length,
    internal: packs.filter((pack) => pack.manifest.source_kind === "internal").length,
    ...(topPack === undefined
      ? {}
      : {
        top_pack: {
          id: topPack.manifest.id,
          version: topPack.manifest.version,
          quality_score: topPack.manifest.quality_score,
          sources: topPack.manifest.source_provenance?.length ?? 0,
        },
      }),
  };
}

async function executeCockpitTuiAction(
  selection: CockpitTuiActionSelection,
  options: { json: boolean },
): Promise<number> {
  const argv = parseCockpitActionCommand(selection.next_command);
  if (argv instanceof Error) {
    console.error(`osstack: ${argv.message}`);
    return 1;
  }
  const result = await captureCliMain(argv.slice(1));
  const payload = {
    mode: "terminal-cockpit-action-execution",
    selection,
    argv,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderCockpitTuiAction(selection));
    console.log(`exit_code=${result.exit_code}`);
    if (result.stdout.length > 0) {
      console.log("stdout:");
      for (const line of result.stdout) console.log(`  ${line}`);
    }
    if (result.stderr.length > 0) {
      console.log("stderr:");
      for (const line of result.stderr) console.log(`  ${line}`);
    }
  }
  return result.exit_code;
}

async function captureCliMain(args: string[]): Promise<{ exit_code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => {
    stdout.push(values.map((value) => String(value)).join(" "));
  };
  console.error = (...values: unknown[]) => {
    stderr.push(values.map((value) => String(value)).join(" "));
  };
  try {
    const exitCode = await main(args);
    return { exit_code: exitCode, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function parseCockpitActionCommand(command: string): string[] | Error {
  if (command.includes("<task>") || command.includes("<query>")) {
    return new Error("cockpit action still contains an input placeholder; edit the command and run it manually");
  }
  const argv = splitShellLikeCommand(command);
  if (argv instanceof Error) return argv;
  if (argv[0] !== "osstack") {
    return new Error("cockpit --execute-action only runs osstack commands");
  }
  const commandGroup = argv[1];
  const allowed = new Set([
    "cockpit",
    "dashboard",
    "doctor",
    "examples",
    "guide",
    "knowledge",
    "proof",
    "release",
    "report",
    "scorecard",
  ]);
  if (commandGroup === undefined || !allowed.has(commandGroup)) {
    return new Error(`cockpit --execute-action rejected unsupported command: ${commandGroup ?? "unknown"}`);
  }
  return argv;
}

function splitShellLikeCommand(command: string): string[] | Error {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === "'" && char === "\\" && command[index + 1] === "'") {
        current += "'";
        index += 1;
        continue;
      }
      if (quote === "\"" && char === "\\" && command[index + 1] !== undefined) {
        current += command[index + 1];
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    if (char === "\\" && command[index + 1] !== undefined) {
      current += command[index + 1];
      index += 1;
      continue;
    }
    current += char;
  }
  if (quote !== undefined) return new Error("unterminated quote in cockpit action command");
  if (current.length > 0) argv.push(current);
  if (argv.length === 0) return new Error("empty cockpit action command");
  return argv;
}

async function handleCockpitNextCommand(args: string[]): Promise<number> {
  const statusRaw = flagValue(args, "--status");
  const statusFilter = parseCockpitNextStatus(statusRaw);
  if (statusRaw !== undefined && statusFilter === undefined) {
    console.error("osstack: cockpit next requires --status ready|running|blocked");
    return 1;
  }
  const resp = (await rpc("dashboard.snapshot", dashboardSnapshotParams(args))) as { ok: boolean; result?: unknown; error?: { message: string } };
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
  const { readLoopState } = await loadLoop();
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
  await writeFile(output, await renderReportMarkdownForArtifacts(state, events, language), "utf-8");
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
  const { enqueueTask, readLoopState } = await loadLoop();
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
  const { readLoopState } = await loadLoop();
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
  const latestReport = isRecord(evidence["latest_report"]) ? evidence["latest_report"] : undefined;
  const latestProofPack = isRecord(evidence["latest_proof_pack"]) ? evidence["latest_proof_pack"] : undefined;
  if (typeof latestReport?.["path"] === "string") console.log(`latest_report=${latestReport["path"]}`);
  if (typeof latestProofPack?.["path"] === "string") console.log(`latest_proof=${latestProofPack["path"]}`);
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
    const blockers = Array.isArray(step["blockers"]) ? step["blockers"] : [];
    for (const blocker of blockers) {
      if (!isRecord(blocker)) continue;
      console.log(`    blocker ${String(blocker["id"] ?? "unknown")}: ${String(blocker["detail"] ?? "")}`);
    }
    if (typeof step["command"] === "string" && step["command"].length > 0) {
      console.log(`    command: ${step["command"]}`);
    }
  }
  if (nextSteps.length === 0) console.log(`  ${text.none}`);
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

  if (s.loops === undefined) {
    printRpcLatency(s.rpc);
    return;
  }
  console.log();
  const loopAvg = s.loops.avg_cycle_duration_ms === null ? "—" : s.loops.avg_cycle_duration_ms.toFixed(0);
  console.log(
    `loop_sessions=${s.loops.total_sessions} running=${s.loops.running} stopping=${s.loops.stopping} stopped=${s.loops.stopped} failed=${s.loops.failed}`,
  );
  console.log(
    `loop_cycles=${s.loops.total_cycles} discovered=${s.loops.total_discovered} executed=${s.loops.total_executed} skipped=${s.loops.total_skipped} ok=${s.loops.total_successful} failed=${s.loops.total_failed} escalated=${s.loops.total_escalated} tokens=${s.loops.total_tokens_consumed} avg_cycle_ms=${loopAvg}`,
  );
  if (s.loops.per_loop.length > 0) {
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

  printRpcLatency(s.rpc);
}

/** RPC latency section: sorted by the daemon (descending p95), sliding window ≤512. */
function printRpcLatency(rows: RpcLatencyRow[] | undefined): void {
  if (rows === undefined || rows.length === 0) return;
  console.log();
  console.log("rpc_method                count window   p50_ms   p95_ms   max_ms");
  console.log("-".repeat(68));
  for (const r of rows) {
    console.log(
      `${pad(r.method, 24)} ${num(r.count, 7)} ${num(r.window, 6)} ${pad(r.p50_ms.toFixed(1), 8)} ${pad(r.p95_ms.toFixed(1), 8)} ${pad(r.max_ms.toFixed(1), 8)}`,
    );
  }
}

function pad(s: string, n: number): string { return s.length >= n ? s : `${s}${" ".repeat(n - s.length)}`; }
function num(n: number, w: number): string {
  const s = String(n);
  return s.length >= w ? s : `${" ".repeat(w - s.length)}${s}`;
}

// No self-execution block here: cli-entry.ts (the dist/bin.js wrapper) owns
// the direct-entry guard and calls main() explicitly. Under bun --compile
// every bundled module reports the same import.meta.url, so a guard in this
// module would fire alongside the wrapper's and run main() twice.
