import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import {
  appendKnowledgeHygienePlanEventV1,
  getKnowledgeHygienePlanProjectionV1,
  openDb,
  type KnowledgeHygienePlanStateV1Core,
} from "@osstack/core";
import {
  applyKnowledgeHygieneTransactionPlanV1,
  approveKnowledgeHygieneTransactionPlanV1,
  buildKnowledgeHygieneTransactionPlanV1,
  checkKnowledgeHygieneV2,
  CLAUDE_CODE_MEMORY_ADAPTER_V1,
  KnowledgeHygieneSimulatedCrashV1,
  KnowledgeHygieneTransactionErrorV1,
  KnowledgeHygieneTransactionPlanV1,
  recoverKnowledgeHygieneTransactionPlanV1,
  renderKnowledgeHygieneTransactionPlanMarkdownV1,
  runKnowledgeSurfaceAdapter,
  type KnowledgeHygieneActionDraftV1,
  type KnowledgeHygieneFileSnapshotV1,
  type KnowledgeHygieneReportV2,
  type KnowledgeHygieneTransactionApplyHooksV1,
  type KnowledgeHygieneTransactionPlanV1 as TransactionPlan,
} from "@osstack/governance";
import { osstackHome } from "./paths.js";

const execFile = promisify(execFileCallback);
const PLAN_ID = /^khtp_[a-f0-9]{64}$/;
const REPO_KEY = /^repo_[a-f0-9]{64}$/;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const NARRATIVE_RULES = [
  "rulebook.managed_context_block",
  "rulebook.narrative_block",
  "rulebook.narrative_density",
] as const;

export interface NeatTransactionCommandDependencies {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  home?: () => string;
  now?: () => Date;
  is_tty?: () => boolean;
  local_user_id?: () => string;
  min_free_bytes?: number;
  check_v2?: typeof checkKnowledgeHygieneV2;
  apply_hooks?: KnowledgeHygieneTransactionApplyHooksV1;
}

class NeatTransactionUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatTransactionUsageError";
  }
}

interface ParsedArguments {
  values: Map<string, string>;
  flags: Set<string>;
}

export interface StoredPlan {
  plan: TransactionPlan;
  artifact_path: string;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function parseArguments(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  flagOptions = new Set(["--json", "--dry-run", "--execute", "--help"]),
): ParsedArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (flagOptions.has(token)) {
      if (flags.has(token)) throw new NeatTransactionUsageError(`duplicate option ${token}`);
      flags.add(token);
      continue;
    }
    if (!valueOptions.has(token)) {
      throw new NeatTransactionUsageError(`unknown option ${token}`);
    }
    if (values.has(token)) throw new NeatTransactionUsageError(`duplicate option ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new NeatTransactionUsageError(`${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }
  return { values, flags };
}

function required(parsed: ParsedArguments, option: string): string {
  const value = parsed.values.get(option);
  if (value === undefined || value.trim().length === 0) {
    throw new NeatTransactionUsageError(`${option} is required`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new NeatTransactionUsageError(`${option} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function portablePath(value: string, option: string): string {
  if (
    value.length === 0 || isAbsolute(value) || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new NeatTransactionUsageError(`${option} must be a portable relative path`);
  }
  return value;
}

function splitValues(value: string, option: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new NeatTransactionUsageError(`${option} must contain unique values`);
  }
  return values;
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
  );
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateFile(path: string, content: string): Promise<void> {
  await privateDirectory(dirname(path));
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function planRoot(home: string): string {
  return join(home, "neat", "plans");
}

function repoKey(repoRoot: string): string {
  return `repo_${digest(repoRoot)}`;
}

export async function savePlan(
  home: string,
  plan: TransactionPlan,
): Promise<StoredPlan> {
  const parsed = KnowledgeHygieneTransactionPlanV1.parse(plan);
  const directory = join(planRoot(home), repoKey(parsed.repo.root_realpath), parsed.plan_id);
  const artifactPath = join(directory, "plan.json");
  const json = `${JSON.stringify(parsed, null, 2)}\n`;
  await atomicPrivateFile(artifactPath, json);
  await atomicPrivateFile(
    join(directory, "plan.md"),
    renderKnowledgeHygieneTransactionPlanMarkdownV1(parsed),
  );
  return { plan: parsed, artifact_path: artifactPath };
}

async function readPlanFile(path: string): Promise<TransactionPlan | undefined> {
  let handle: FileHandle;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_PLAN_BYTES) {
      throw new Error(`unsafe plan artifact: ${path}`);
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    return KnowledgeHygieneTransactionPlanV1.parse(
      JSON.parse(await handle.readFile("utf8")),
    );
  } finally {
    await handle.close();
  }
}

export async function loadPlan(
  home: string,
  planId: string,
): Promise<StoredPlan> {
  if (!PLAN_ID.test(planId)) throw new NeatTransactionUsageError("invalid --plan id");
  const root = planRoot(home);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new NeatTransactionUsageError(`plan not found: ${planId}`);
    }
    throw error;
  }
  if (entries.length > 10_000) throw new Error("plan registry exceeds safe scan limit");
  for (const entry of entries) {
    if (!entry.isDirectory() || !REPO_KEY.test(entry.name)) continue;
    const artifactPath = join(root, entry.name, planId, "plan.json");
    const plan = await readPlanFile(artifactPath);
    if (plan === undefined) continue;
    if (plan.plan_id !== planId) throw new Error("plan artifact identity mismatch");
    return { plan, artifact_path: artifactPath };
  }
  throw new NeatTransactionUsageError(`plan not found: ${planId}`);
}

async function snapshot(
  rootId: "repo" | "memory",
  root: string,
  path: string,
): Promise<KnowledgeHygieneFileSnapshotV1> {
  const target = resolve(root, path);
  if (!inside(root, target)) throw new NeatTransactionUsageError(`path escapes ${rootId} root`);
  let metadata: Stats;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { root_id: rootId, path, content_utf8: null, mode: 0o644 };
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 4 * 1024 * 1024) {
    throw new NeatTransactionUsageError(`unsafe or oversized source: ${rootId}:${path}`);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await handle.readFile("utf8");
    if (content.includes("\u0000")) {
      throw new NeatTransactionUsageError(`source is not UTF-8 text: ${rootId}:${path}`);
    }
    return { root_id: rootId, path, content_utf8: content, mode: metadata.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export async function gitIdentity(repo: string): Promise<{
  base_revision: string;
  fingerprint: string;
}> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFile("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }),
      execFile("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        cwd: repo,
        encoding: "utf8",
      }),
    ]);
    const baseRevision = head.trim();
    return {
      base_revision: baseRevision,
      fingerprint: digest(JSON.stringify([baseRevision, status])),
    };
  } catch {
    return {
      base_revision: "unversioned",
      fingerprint: digest("unversioned"),
    };
  }
}

async function memoryIdentity(repo: string, memoryDir: string): Promise<{
  root: string;
  fingerprint: string;
}> {
  const detected = await runKnowledgeSurfaceAdapter(CLAUDE_CODE_MEMORY_ADAPTER_V1, {
    repo_root: repo,
    enabled: true,
    options: {
      memory_directory: memoryDir,
      ...(process.env["HOME"] === undefined ? {} : { home_directory: process.env["HOME"] }),
    },
  });
  if (detected.status !== "available") {
    throw new NeatTransactionUsageError("configured Claude Code memory root is unavailable");
  }
  const root = await realpath(detected.detection.root!);
  return {
    root,
    fingerprint: digest(JSON.stringify(detected.inventory.surfaces.map((surface) => [
      surface.path,
      surface.exists,
      surface.sha256 ?? null,
      surface.bytes ?? null,
    ]))),
  };
}

export async function assertRootFingerprints(
  plan: TransactionPlan,
): Promise<void> {
  const repo = await realpath(plan.repo.root_realpath);
  const currentRepo = await gitIdentity(repo);
  if (
    currentRepo.base_revision !== plan.repo.base_revision
    || currentRepo.fingerprint !== plan.repo.fingerprint
  ) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "stale",
      "repository base tree changed after planning",
    );
  }
  if (plan.memory_root !== undefined) {
    const memory = await memoryIdentity(repo, plan.memory_root.root_realpath);
    if (
      memory.root !== plan.memory_root.root_realpath
      || memory.fingerprint !== plan.memory_root.fingerprint
    ) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "stale",
        "memory root changed after planning",
      );
    }
  }
}

function eventId(body: object): string {
  return `khte_${digest(JSON.stringify(body))}`;
}

export async function recordEvent(
  deps: NeatTransactionCommandDependencies,
  home: string,
  stored: StoredPlan,
  actor: string,
  reason: string,
): Promise<void> {
  await privateDirectory(home);
  const db = openDb({
    path: join(home, "state.db"),
    ...(deps.min_free_bytes === undefined ? {} : { minFreeBytes: deps.min_free_bytes }),
  });
  try {
    const projection = getKnowledgeHygienePlanProjectionV1(db, stored.plan.plan_id);
    const occurredAt = (deps.now ?? (() => new Date()))().toISOString();
    const artifactSha = digest(await readFile(stored.artifact_path));
    const body = {
      schema_version: "1" as const,
      plan_id: stored.plan.plan_id,
      kind: stored.plan.kind,
      repo_id: stored.plan.repo.repo_id,
      revision: stored.plan.revision,
      from_state: projection?.state ?? null,
      to_state: stored.plan.state as KnowledgeHygienePlanStateV1Core,
      artifact_path: stored.artifact_path,
      artifact_sha256: artifactSha,
      actor,
      reason,
      occurred_at: occurredAt,
    };
    appendKnowledgeHygienePlanEventV1(db, {
      ...body,
      event_id: eventId(body),
    });
  } finally {
    db.close();
  }
}

function output(
  deps: NeatTransactionCommandDependencies,
  stored: StoredPlan,
  json: boolean,
  receipt?: unknown,
): void {
  if (json) {
    deps.stdout(JSON.stringify({
      plan_id: stored.plan.plan_id,
      kind: stored.plan.kind,
      revision: stored.plan.revision,
      state: stored.plan.state,
      action_ids: stored.plan.actions.map((action) => action.action_id),
      artifact_path: stored.artifact_path,
      ...(receipt === undefined ? {} : { receipt }),
    }, null, 2));
    return;
  }
  deps.stdout(
    `${stored.plan.kind} plan ${stored.plan.plan_id} is ${stored.plan.state}\n${stored.artifact_path}`,
  );
}

function ensureKind(expected: "memory" | "narrative", plan: TransactionPlan): void {
  if (plan.kind !== expected) {
    throw new NeatTransactionUsageError(
      `plan kind is ${plan.kind}; expected ${expected}`,
    );
  }
}

export function requireTty(
  deps: NeatTransactionCommandDependencies,
  operation: string,
): void {
  const isTty = deps.is_tty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (!isTty()) {
    throw new NeatTransactionUsageError(`${operation} requires a local interactive TTY`);
  }
}

async function planMemory(
  args: readonly string[],
  deps: NeatTransactionCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args, new Set([
    "--repo",
    "--adapter",
    "--claude-memory-dir",
    "--source",
    "--start-line",
    "--end-line",
    "--target",
    "--kind",
    "--replacement",
    "--reason",
    "--format",
  ]));
  if (parsed.flags.has("--help")) {
    deps.stdout(renderNeatTransactionHelp("memory"));
    return 0;
  }
  const repo = await realpath(resolve(parsed.values.get("--repo") ?? deps.cwd()));
  if (required(parsed, "--adapter") !== "claude-code") {
    throw new NeatTransactionUsageError("--adapter must be claude-code");
  }
  const memory = await memoryIdentity(repo, required(parsed, "--claude-memory-dir"));
  const sourcePath = portablePath(parsed.values.get("--source") ?? "MEMORY.md", "--source");
  const targetPath = portablePath(
    parsed.values.get("--target") ?? "docs/knowledge.md",
    "--target",
  );
  if (!targetPath.startsWith("docs/") && targetPath !== "AGENTS.md") {
    throw new NeatTransactionUsageError(
      "memory target must be documentation under docs/ or canonical AGENTS.md",
    );
  }
  const source = await snapshot("memory", memory.root, sourcePath);
  if (source.content_utf8 === null) throw new NeatTransactionUsageError("memory source is absent");
  const lineCount = source.content_utf8.split(/\r?\n/).length
    - (source.content_utf8.endsWith("\n") ? 1 : 0);
  const startLine = positiveInteger(parsed.values.get("--start-line") ?? "1", "--start-line");
  const endLine = positiveInteger(
    parsed.values.get("--end-line") ?? String(lineCount),
    "--end-line",
  );
  const target = await snapshot("repo", repo, targetPath);
  const kind = parsed.values.get("--kind") ?? "move";
  let draft: KnowledgeHygieneActionDraftV1;
  if (kind === "move") {
    draft = {
      kind,
      source: { root_id: "memory", path: sourcePath, start_line: startLine, end_line: endLine },
      target: {
        root_id: "repo",
        path: targetPath,
        placement: "after",
        purpose: targetPath === "AGENTS.md" ? "instruction_canonical" : "documentation",
      },
    };
  } else if (kind === "compress") {
    draft = {
      kind,
      sources: [{ root_id: "memory", path: sourcePath, start_line: startLine, end_line: endLine }],
      target: {
        root_id: "repo",
        path: targetPath,
        placement: "after",
        purpose: targetPath === "AGENTS.md" ? "instruction_canonical" : "documentation",
      },
      replacement_utf8: required(parsed, "--replacement"),
    };
  } else if (kind === "delete") {
    draft = {
      kind,
      sources: [{ root_id: "memory", path: sourcePath, start_line: startLine, end_line: endLine }],
      reasons: [required(parsed, "--reason")],
    };
  } else {
    throw new NeatTransactionUsageError("--kind must be move, compress, or delete");
  }
  const now = deps.now ?? (() => new Date());
  const createdAt = now();
  const git = await gitIdentity(repo);
  const plan = buildKnowledgeHygieneTransactionPlanV1({
    kind: "memory",
    revision: 1,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    repo: {
      repo_id: basename(repo),
      root_realpath: repo,
      base_revision: git.base_revision,
      fingerprint: git.fingerprint,
    },
    memory_root: {
      root_realpath: memory.root,
      fingerprint: memory.fingerprint,
    },
    snapshots: [source, target],
    drafts: [draft],
    evidence_refs: [{
      kind: "external",
      ref: "https://code.claude.com/docs/en/memory",
    }],
  });
  const home = (deps.home ?? osstackHome)();
  const stored = await savePlan(home, plan);
  await recordEvent(deps, home, stored, "system", "Created evidence-bound memory plan.");
  output(deps, stored, parsed.flags.has("--json") || parsed.values.get("--format") === "json");
  return 0;
}

async function narrativeReport(
  repo: string,
  deps: NeatTransactionCommandDependencies,
): Promise<KnowledgeHygieneReportV2> {
  return (deps.check_v2 ?? checkKnowledgeHygieneV2)({
    schema_version: "2",
    repo_root: repo,
    mode: "all",
    checks: [...NARRATIVE_RULES],
  });
}

async function planNarrative(
  args: readonly string[],
  deps: NeatTransactionCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args, new Set([
    "--repo",
    "--findings",
    "--kind",
    "--target",
    "--replacement",
    "--reason",
    "--judge",
    "--format",
  ]));
  if (parsed.flags.has("--help")) {
    deps.stdout(renderNeatTransactionHelp("narrative"));
    return 0;
  }
  const repo = await realpath(resolve(parsed.values.get("--repo") ?? deps.cwd()));
  const requested = splitValues(required(parsed, "--findings"), "--findings");
  const report = await narrativeReport(repo, deps);
  const findings = requested.map((fingerprint) => {
    const finding = report.findings.find((candidate) => candidate.fingerprint === fingerprint);
    if (finding === undefined) {
      throw new NeatTransactionUsageError(`narrative finding is not active: ${fingerprint}`);
    }
    const citation = finding.citations.find((item) => item.source.kind === "repository");
    if (citation === undefined || citation.source.kind !== "repository") {
      throw new NeatTransactionUsageError(`finding has no repository byte anchor: ${fingerprint}`);
    }
    return {
      finding,
      citation: {
        path: citation.source.path,
        start_line: citation.start_line,
        end_line: citation.end_line,
      },
    };
  });
  const paths = [...new Set(findings.map(({ citation }) => citation.path))];
  const snapshots = await Promise.all(paths.map((path) => snapshot("repo", repo, path)));
  const kind = parsed.values.get("--kind") ?? "delete";
  const selections = findings.map(({ citation }) => ({
    root_id: "repo" as const,
    path: citation.path,
    start_line: citation.start_line,
    end_line: citation.end_line,
  }));
  let draft: KnowledgeHygieneActionDraftV1;
  if (kind === "delete") {
    draft = {
      kind,
      sources: selections,
      reasons: selections.map(() =>
        parsed.values.get("--reason") ?? "Discard verified transient narrative context."
      ),
    };
  } else if (kind === "compress") {
    if (new Set(selections.map((item) => item.path)).size !== 1) {
      throw new NeatTransactionUsageError("compression sources must share one target file");
    }
    draft = {
      kind,
      sources: selections,
      target: {
        root_id: "repo",
        path: selections[0]!.path,
        placement: "replace",
        purpose: "instruction_canonical",
      },
      replacement_utf8: required(parsed, "--replacement"),
    };
  } else if (kind === "move") {
    if (selections.length !== 1) {
      throw new NeatTransactionUsageError("narrative move accepts exactly one finding");
    }
    const targetPath = portablePath(required(parsed, "--target"), "--target");
    if (!targetPath.startsWith("docs/") && targetPath !== "CHANGELOG.md") {
      throw new NeatTransactionUsageError("narrative move target must be docs/ or CHANGELOG.md");
    }
    const target = await snapshot("repo", repo, targetPath);
    snapshots.push(target);
    draft = {
      kind,
      source: selections[0]!,
      target: {
        root_id: "repo",
        path: targetPath,
        placement: "after",
        purpose: "documentation",
      },
    };
  } else {
    throw new NeatTransactionUsageError("--kind must be move, compress, or delete");
  }
  const now = deps.now ?? (() => new Date());
  const createdAt = now();
  const git = await gitIdentity(repo);
  const plan = buildKnowledgeHygieneTransactionPlanV1({
    kind: "narrative",
    revision: 1,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    repo: {
      repo_id: report.repo.repo_id ?? basename(repo),
      root_realpath: repo,
      base_revision: git.base_revision,
      fingerprint: git.fingerprint,
    },
    snapshots,
    drafts: [draft],
    evidence_refs: findings.map(({ finding }) => ({
      kind: "report" as const,
      ref: `finding:${finding.fingerprint}`,
      sha256: digest(JSON.stringify(finding)),
    })),
  });
  const home = (deps.home ?? osstackHome)();
  const stored = await savePlan(home, plan);
  await recordEvent(deps, home, stored, "system", "Created evidence-bound narrative plan.");
  output(deps, stored, parsed.flags.has("--json") || parsed.values.get("--format") === "json");
  return 0;
}

async function approve(
  kind: "memory" | "narrative",
  args: readonly string[],
  deps: NeatTransactionCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args, new Set([
    "--plan",
    "--actions",
    "--actor",
    "--reason",
    "--if-revision",
  ]));
  requireTty(deps, "approve");
  const home = (deps.home ?? osstackHome)();
  const loaded = await loadPlan(home, required(parsed, "--plan"));
  ensureKind(kind, loaded.plan);
  const actionOption = required(parsed, "--actions");
  const actionIds = actionOption === "all"
    ? loaded.plan.actions.map((action) => action.action_id)
    : splitValues(actionOption, "--actions");
  const approved = approveKnowledgeHygieneTransactionPlanV1(loaded.plan, {
    action_ids: actionIds,
    actor: required(parsed, "--actor"),
    reason: required(parsed, "--reason"),
    if_revision: positiveInteger(required(parsed, "--if-revision"), "--if-revision"),
    local_user_id: (deps.local_user_id ?? (() => String(userInfo().uid)))(),
    tty_consented_at: (deps.now ?? (() => new Date()))().toISOString(),
  });
  const stored = await savePlan(home, approved);
  await recordEvent(
    deps,
    home,
    stored,
    required(parsed, "--actor"),
    required(parsed, "--reason"),
  );
  output(deps, stored, parsed.flags.has("--json"));
  return 0;
}

function selectedNarrativeFingerprints(plan: TransactionPlan): string[] {
  return plan.evidence_refs.flatMap((ref) =>
    ref.kind === "report" && ref.ref.startsWith("finding:")
      ? [ref.ref.slice("finding:".length)]
      : []
  );
}

async function verifyNarrativePostcondition(
  plan: TransactionPlan,
  deps: NeatTransactionCommandDependencies,
): Promise<void> {
  const selected = new Set(selectedNarrativeFingerprints(plan));
  const report = await narrativeReport(plan.repo.root_realpath, deps);
  const remaining = report.findings
    .map((finding) => finding.fingerprint)
    .filter((fingerprint) => selected.has(fingerprint));
  if (remaining.length > 0) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "conflict",
      `narrative postcondition failed for ${remaining.join(",")}`,
    );
  }
}

async function apply(
  kind: "memory" | "narrative",
  args: readonly string[],
  deps: NeatTransactionCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args, new Set(["--plan", "--if-revision"]));
  if (parsed.flags.has("--execute") && parsed.flags.has("--dry-run")) {
    throw new NeatTransactionUsageError("--execute and --dry-run are mutually exclusive");
  }
  const execute = parsed.flags.has("--execute");
  if (execute) {
    requireTty(deps, "apply --execute");
    if (process.env["OSSTACK_NEAT_APPLY_DISABLED"] === "1") {
      throw new NeatTransactionUsageError(
        "apply --execute is disabled by OSSTACK_NEAT_APPLY_DISABLED=1",
      );
    }
  }
  const home = (deps.home ?? osstackHome)();
  const loaded = await loadPlan(home, required(parsed, "--plan"));
  ensureKind(kind, loaded.plan);
  const revision = positiveInteger(required(parsed, "--if-revision"), "--if-revision");
  if (revision !== loaded.plan.revision) {
    throw new KnowledgeHygieneTransactionErrorV1("stale", "plan revision changed");
  }
  const now = deps.now ?? (() => new Date());
  if (
    loaded.plan.state !== "applied"
    && Date.parse(now().toISOString()) >= Date.parse(loaded.plan.expires_at)
  ) {
    const stale = KnowledgeHygieneTransactionPlanV1.parse({
      ...loaded.plan,
      state: "stale",
    });
    const stored = await savePlan(home, stale);
    await recordEvent(deps, home, stored, "system", "Transaction plan expired.");
    throw new KnowledgeHygieneTransactionErrorV1("stale", "transaction plan is expired");
  }
  if (loaded.plan.state !== "applied") {
    try {
      await assertRootFingerprints(loaded.plan);
    } catch (error) {
      if (error instanceof KnowledgeHygieneTransactionErrorV1 && error.code === "stale") {
        const stale = KnowledgeHygieneTransactionPlanV1.parse({
          ...loaded.plan,
          state: "stale",
        });
        const stored = await savePlan(home, stale);
        await recordEvent(deps, home, stored, "system", error.message);
      }
      throw error;
    }
  }
  const stateRoot = join(home, "neat");
  if (!execute) {
    try {
      const result = await applyKnowledgeHygieneTransactionPlanV1(loaded.plan, {
        state_root: stateRoot,
        execute: false,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.apply_hooks === undefined ? {} : { hooks: deps.apply_hooks }),
      });
      const stored = await savePlan(home, result.plan);
      await recordEvent(deps, home, stored, "system", "Verified transaction dry-run.");
      output(deps, stored, parsed.flags.has("--json"), result.receipt);
      return 0;
    } catch (error) {
      if (error instanceof KnowledgeHygieneTransactionErrorV1 && error.code === "stale") {
        const stale = KnowledgeHygieneTransactionPlanV1.parse({
          ...loaded.plan,
          state: "stale",
        });
        const stored = await savePlan(home, stale);
        await recordEvent(deps, home, stored, "system", error.message);
      }
      throw error;
    }
  }
  if (loaded.plan.state !== "applied") {
    const applying = KnowledgeHygieneTransactionPlanV1.parse({
      ...loaded.plan,
      state: "applying",
    });
    const applyingStored = await savePlan(home, applying);
    await recordEvent(deps, home, applyingStored, "system", "Started transaction apply.");
  }
  let postconditionRecovered = false;
  try {
    const result = await applyKnowledgeHygieneTransactionPlanV1(loaded.plan, {
      state_root: stateRoot,
      execute: true,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.apply_hooks === undefined ? {} : { hooks: deps.apply_hooks }),
    });
    if (kind === "narrative") {
      try {
        await verifyNarrativePostcondition(result.plan, deps);
      } catch (postconditionError) {
        const recoveryRequired = KnowledgeHygieneTransactionPlanV1.parse({
          ...result.plan,
          state: "recovery_required",
        });
        const recoveryRequiredStored = await savePlan(home, recoveryRequired);
        await recordEvent(
          deps,
          home,
          recoveryRequiredStored,
          "system",
          "Narrative postcondition failed; recovery required.",
        );
        const recovered = await recoverKnowledgeHygieneTransactionPlanV1(
          recoveryRequired,
          {
            state_root: stateRoot,
            allow_applied: true,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
        );
        const recoveredStored = await savePlan(home, recovered.plan);
        await recordEvent(
          deps,
          home,
          recoveredStored,
          "system",
          "Rolled back failed narrative postcondition.",
        );
        postconditionRecovered = true;
        throw postconditionError;
      }
    }
    const stored = await savePlan(home, result.plan);
    await recordEvent(deps, home, stored, "system", "Applied transaction.");
    output(deps, stored, parsed.flags.has("--json"), result.receipt);
    return 0;
  } catch (error) {
    if (postconditionRecovered) throw error;
    if (
      error instanceof KnowledgeHygieneSimulatedCrashV1
      || (error instanceof KnowledgeHygieneTransactionErrorV1
        && error.code === "recovery_required")
    ) {
      const recoveryPlan = KnowledgeHygieneTransactionPlanV1.parse({
        ...loaded.plan,
        state: "recovery_required",
      });
      const stored = await savePlan(home, recoveryPlan);
      await recordEvent(deps, home, stored, "system", "Apply requires recovery.");
    } else if (
      error instanceof KnowledgeHygieneTransactionErrorV1
      && error.code === "apply_failed_recovered"
    ) {
      const recoveryRequired = KnowledgeHygieneTransactionPlanV1.parse({
        ...loaded.plan,
        state: "recovery_required",
      });
      const recoveryRequiredStored = await savePlan(home, recoveryRequired);
      await recordEvent(
        deps,
        home,
        recoveryRequiredStored,
        "system",
        "Apply failed; automatic recovery completed.",
      );
      const recovered = KnowledgeHygieneTransactionPlanV1.parse({
        ...recoveryRequired,
        state: "recovered",
      });
      const recoveredStored = await savePlan(home, recovered);
      await recordEvent(
        deps,
        home,
        recoveredStored,
        "system",
        "Recorded automatic transaction recovery.",
      );
    } else if (
      error instanceof KnowledgeHygieneTransactionErrorV1
      && error.code === "stale"
    ) {
      const stale = KnowledgeHygieneTransactionPlanV1.parse({
        ...loaded.plan,
        state: "stale",
      });
      const stored = await savePlan(home, stale);
      await recordEvent(deps, home, stored, "system", error.message);
    } else {
      const cancelled = KnowledgeHygieneTransactionPlanV1.parse({
        ...loaded.plan,
        state: "cancelled",
      });
      const stored = await savePlan(home, cancelled);
      await recordEvent(
        deps,
        home,
        stored,
        "system",
        "Apply stopped before a recoverable journal was established.",
      );
    }
    throw error;
  }
}

async function recover(
  kind: "memory" | "narrative",
  args: readonly string[],
  deps: NeatTransactionCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args, new Set(["--plan"]));
  const home = (deps.home ?? osstackHome)();
  const loaded = await loadPlan(home, required(parsed, "--plan"));
  ensureKind(kind, loaded.plan);
  let recoverable = loaded.plan;
  if (recoverable.state === "applying") {
    recoverable = KnowledgeHygieneTransactionPlanV1.parse({
      ...recoverable,
      state: "recovery_required",
    });
    const recoveryRequired = await savePlan(home, recoverable);
    await recordEvent(
      deps,
      home,
      recoveryRequired,
      "system",
      "Detected incomplete apply; recovery required.",
    );
  }
  const result = await recoverKnowledgeHygieneTransactionPlanV1(recoverable, {
    state_root: join(home, "neat"),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.apply_hooks === undefined ? {} : { hooks: deps.apply_hooks }),
  });
  const stored = await savePlan(home, result.plan);
  await recordEvent(deps, home, stored, "system", "Recovered transaction.");
  output(deps, stored, parsed.flags.has("--json"), result.receipt);
  return 0;
}

export function renderNeatTransactionHelp(kind: "memory" | "narrative"): string {
  const plan = kind === "memory"
    ? `osstack neat memory plan --repo <path> --adapter claude-code --claude-memory-dir <path>
    [--source <path>] [--start-line <n>] [--end-line <n>]
    [--kind move|compress|delete] [--target <path>]
    [--replacement <text>] [--reason <text>] [--format human|json]`
    : `osstack neat narrative plan --repo <path> --findings <fingerprint,...>
    [--kind move|compress|delete] [--target <path>]
    [--replacement <text>] [--reason <text>] [--format human|json]`;
  return `osstack neat ${kind} — approved, recoverable knowledge remediation

Usage:
  ${plan}
  osstack neat ${kind} approve --plan <id> --actions <id,...|all> --actor <id>
    --reason <text> --if-revision <n>
  osstack neat ${kind} apply --plan <id> --if-revision <n> [--dry-run | --execute]
  osstack neat ${kind} recover --plan <id>

Execute and approve require a local interactive TTY. Apply defaults to dry-run.
No command creates a Git commit.`;
}

export async function handleNeatTransactionCommand(
  kind: "memory" | "narrative",
  args: readonly string[],
  deps: NeatTransactionCommandDependencies,
): Promise<number> {
  try {
    const command = args[0];
    if (command === undefined || command === "--help" || command === "help") {
      deps.stdout(renderNeatTransactionHelp(kind));
      return 0;
    }
    if (command === "plan") {
      return kind === "memory"
        ? await planMemory(args.slice(1), deps)
        : await planNarrative(args.slice(1), deps);
    }
    if (command === "approve") return await approve(kind, args.slice(1), deps);
    if (command === "apply") return await apply(kind, args.slice(1), deps);
    if (command === "recover") return await recover(kind, args.slice(1), deps);
    throw new NeatTransactionUsageError(
      `unknown ${kind} command ${command}; expected plan, approve, apply, or recover`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(`osstack neat ${kind}: ${message}`);
    if (error instanceof NeatTransactionUsageError) return 2;
    if (error instanceof KnowledgeHygieneTransactionErrorV1) return 3;
    return 3;
  }
}
