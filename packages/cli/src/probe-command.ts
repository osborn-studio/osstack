import {
  createProbeSession,
  getProbeSession,
  listProbeEvents,
  listProbeItems,
  listProbeSessionsByRepo,
  mutateProbeSession,
  openDb,
  ProbeStoreConflictError,
  recordProbeArtifact,
  replayProbeCommand,
} from "@osstack/core";
import {
  applyProbeMutation,
  compileProbeEvaluations,
  createRestatementQuestionBatch,
  createProbeRenderBundle,
  deriveProbeReadiness,
  deriveProbeSeverity,
  evaluateProbeGate,
  getCurrentProbeItem,
  materializeProbeQuestions,
  materializeProbeQuestionBatch,
  ProbeActorV1,
  ProbeDestinationRoleV1,
  ProbeDocTypeV1,
  ProbeItemStateV1,
  ProbeItemV1,
  ProbeQuadrantV1,
  ProbeRepositoryRelativePathV1,
  ProbeReducerError,
  ProbeSessionV1,
  ProbeSeverityV1,
  selectProbeQuestions,
  sortProbeItems,
  toProbeMetricItemFact,
  ProbeDynamicInputError,
  ProbeEvaluationCompilerError,
  type ProbeDomainStateV1,
  type ProbeEventV1,
  type ProbeFamiliarityV1,
  type ProbeItemV1 as ProbeItem,
} from "@osstack/governance";
import {
  AgentCommandResult,
  PROTOCOL_VERSION,
  type ErrorCode,
} from "@osstack/protocol";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { osstackHome } from "./paths.js";
import {
  ProbeCompileFileError,
  createProbeCompilerEnvironment,
  readProbeCompilationBatch,
  verifyProbeCompilationDelta,
  writeProbeCompilationDelta,
} from "./probe-compile.js";
import {
  ProbeDynamicFileError,
  readProbeQuestionBatch,
  readProbeRestatementFindings,
  verifyProbeDynamicEvidence,
  verifyProbeRestatementEvidence,
} from "./probe-dynamic.js";
import {
  ProbeGateInputError,
  collectProbeDestinationContent,
  loadProbeGatePolicy,
  readPortableProbeLedger,
} from "./probe-gate.js";
import {
  ProbeRenderWriteError,
  readProbeRenderDirectory,
  writeProbeRenderBundle,
} from "./probe-render.js";
import { VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

type ProbeFormat = "human" | "json";

export interface ProbeRepositoryInspectionV1 {
  source_revision?: string;
  worktree_state: "clean" | "dirty" | "not_git";
}

export interface ProbeCommandDependencies {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now_ms?: () => number;
  create_id?: (prefix: "probe" | "pi" | "pe" | "par") => string;
  state_db_path?: () => Promise<string>;
  inspect_repository?: (
    repoPath: string,
  ) => Promise<ProbeRepositoryInspectionV1>;
  resolve_repo_id?: (repoPath: string) => Promise<string | undefined>;
  read_stdin?: () => Promise<string>;
  min_free_bytes?: number;
}

class ProbeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeUsageError";
  }
}

class ProbeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeNotFoundError";
  }
}

interface ParsedFlags {
  values: ReadonlyMap<string, readonly string[]>;
  booleans: ReadonlySet<string>;
}

interface ParseFlagOptions {
  value_flags: readonly string[];
  boolean_flags?: readonly string[];
  repeatable_flags?: readonly string[];
}

export function renderProbeHelp(): string {
  return `osstack probe — expose and track implementation-changing unknowns

Usage:
  osstack probe start --input <path|-> [start options]
  osstack probe next --session <id> [disposition options]
  osstack probe resume --session <id> --if-revision <n> [resume options]
  osstack probe status (--session <id> | --repo <path>)
  osstack probe ledger --session <id> [filters]
  osstack probe ledger destination --session <id> --item <id> [write options]
  osstack probe render --session <id> --if-revision <n> --target <target>
  osstack probe gate (--session <id> | --ledger <path>) [--config <path>]
  osstack probe add --session <id> --if-revision <n> --from <questions.json>
  osstack probe restate --spec <path> --restatement <path> --findings <path>
  osstack probe compile --session <id> --if-revision <n> --from <requests.json>

Start options:
  --repo <path>                    Repository root (default: cwd)
  --repo-id <id>                   Explicit portable repository identity
  --input <path|->                 Required intent/spec input; - reads stdin
  --reference <path>               Repeatable read-only reference file
  --doc-type <product|tech|test>   Repeatable document pack (default: tech)
  --depth <quick|standard|deep>    Question budget 8/20/40 (default: standard)
  --task <id>                      Optional external task reference
  --domain-familiarity <level>     novice|working|expert
  --repo-familiarity <level>       new|familiar|maintainer
  --intent-maturity <level>        sketch|draft|review_ready

Write options:
  --actor-kind <human|agent> --actor-id <id>
  --idempotency-key <key>
  --if-revision <n>                Required for writes to an existing session

Next dispositions (mutually exclusive):
  --answer <text> | --answer-file <path|->
  --defer --owner <id> --revisit-when <text> [--review-after <RFC3339>]
  --waive --reason <text> [--expires-at <RFC3339>]
  --invalidate --reason <text>
  --pause --reason <text>
  --abandon --reason <text>

Document answers also require:
  --destination-role <role> --destination-path <repo-relative-path>
  [--destination-anchor <anchor>]

Resume options:
  --extend-budget <1..100>         Required after a budget pause
  --revisit <deferred-item-id>     Repeatable

Render options:
  --target <ledger|product-delta|technical-delta|test-matrix|all>
  --out <repo-relative-dir>        Default: docs/probe/sessions/<session-id>

Dynamic input options:
  --from <repo-relative-path>      Strict ProbeQuestionBatchV1 JSON
  --findings <repo-relative-path>  Skill-produced restatement findings JSON

Compile options:
  --from <repo-relative-path>      Strict registered-template requests JSON
  --out <repo-relative-path>       Default: docs/probe/evaluations/<session>-r<n>.json

Output:
  --format <human|json> | --json

Exit codes:
  0  Command completed
  1  Block-mode gate found readiness violations
  2  Invalid arguments, schema, or transition
  3  Conflict, I/O, SQLite, or runtime failure`;
}

function parseFlags(
  args: readonly string[],
  options: ParseFlagOptions,
): ParsedFlags {
  const valueFlags = new Set(options.value_flags);
  const booleanFlags = new Set(options.boolean_flags ?? []);
  const repeatableFlags = new Set(options.repeatable_flags ?? []);
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new ProbeUsageError(`unexpected argument: ${flag ?? ""}`);
    }
    if (booleanFlags.has(flag)) {
      if (booleans.has(flag)) {
        throw new ProbeUsageError(`duplicate flag: ${flag}`);
      }
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.has(flag)) {
      throw new ProbeUsageError(`unknown option: ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ProbeUsageError(`${flag} requires a value`);
    }
    const existing = values.get(flag) ?? [];
    if (existing.length > 0 && !repeatableFlags.has(flag)) {
      throw new ProbeUsageError(`duplicate flag: ${flag}`);
    }
    existing.push(value);
    values.set(flag, existing);
    index += 1;
  }
  return { values, booleans };
}

function one(flags: ParsedFlags, name: string): string | undefined {
  return flags.values.get(name)?.[0];
}

function many(flags: ParsedFlags, name: string): readonly string[] {
  return flags.values.get(name) ?? [];
}

function required(flags: ParsedFlags, name: string): string {
  const value = one(flags, name);
  if (value === undefined) throw new ProbeUsageError(`${name} is required`);
  return value;
}

function parseFormat(flags: ParsedFlags): ProbeFormat {
  const explicit = one(flags, "--format");
  if (explicit !== undefined && explicit !== "human" && explicit !== "json") {
    throw new ProbeUsageError(`unsupported format: ${explicit}`);
  }
  if (flags.booleans.has("--json") && explicit === "human") {
    throw new ProbeUsageError("--json conflicts with --format human");
  }
  return flags.booleans.has("--json") || explicit === "json"
    ? "json"
    : "human";
}

function wantsJson(args: readonly string[]): boolean {
  if (args.includes("--json")) return true;
  const index = args.indexOf("--format");
  return index >= 0 && args[index + 1] === "json";
}

function parseInteger(
  value: string,
  flag: string,
  options: { min: number; max: number },
): number {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < options.min ||
    parsed > options.max
  ) {
    throw new ProbeUsageError(
      `${flag} must be an integer from ${options.min} to ${options.max}`,
    );
  }
  return parsed;
}

function parseTimestamp(value: string, flag: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProbeUsageError(`${flag} must be an RFC3339 timestamp`);
  }
  return parsed;
}

function parseActor(flags: ParsedFlags): ProbeActorV1 {
  const parsed = ProbeActorV1.safeParse({
    type: required(flags, "--actor-kind"),
    id: required(flags, "--actor-id"),
  });
  if (!parsed.success) throw new ProbeUsageError("invalid actor");
  return parsed.data;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function readRegularFile(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new ProbeUsageError(`${path} is not a regular file`);
  }
  return readFile(path);
}

async function readStdinDefault(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function stateDbPathDefault(): Promise<string> {
  const home = osstackHome();
  await mkdir(home, { recursive: true });
  return resolve(home, "state.db");
}

async function inspectRepositoryDefault(
  repoPath: string,
): Promise<ProbeRepositoryInspectionV1> {
  try {
    const revision = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
    });
    const status = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoPath,
    });
    return {
      source_revision: revision.stdout.trim(),
      worktree_state: status.stdout.trim() === "" ? "clean" : "dirty",
    };
  } catch {
    return { worktree_state: "not_git" };
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function resolveRegisteredRepoIdDefault(
  repoRoot: string,
): Promise<string | undefined> {
  const registryPaths = [
    resolve(repoRoot, ".osstack", "repos.json"),
    resolve(osstackHome(), "repos.json"),
  ];
  const matchingIds = new Set<string>();
  for (const registryPath of new Set(registryPaths)) {
    let raw: string;
    try {
      raw = await readFile(registryPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    let registry: unknown;
    try {
      registry = JSON.parse(raw);
    } catch {
      throw new ProbeUsageError(`invalid repository registry: ${registryPath}`);
    }
    if (!Array.isArray(registry)) continue;
    for (const entry of registry) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("repo_id" in entry) ||
        !("path" in entry) ||
        typeof entry.repo_id !== "string" ||
        typeof entry.path !== "string"
      ) {
        throw new ProbeUsageError(
          `invalid repository registry entry: ${registryPath}`,
        );
      }
      let entryRoot: string;
      try {
        entryRoot = await realpath(
          isAbsolute(entry.path)
            ? entry.path
            : resolve(dirname(registryPath), entry.path),
        );
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      if (entryRoot === repoRoot && entry.repo_id.trim() !== "") {
        matchingIds.add(entry.repo_id);
      }
    }
  }
  return matchingIds.size === 1 ? [...matchingIds][0] : undefined;
}

export async function resolveProbeRepositoryId(
  repoRoot: string,
): Promise<string> {
  const resolvedRoot = await realpath(repoRoot);
  return (await resolveRegisteredRepoIdDefault(resolvedRoot)) ?? basename(resolvedRoot);
}

async function resolveRepoId(
  repoRoot: string,
  explicit: string | undefined,
  deps: ProbeCommandDependencies,
): Promise<string> {
  if (explicit !== undefined) {
    if (explicit.trim() === "") {
      throw new ProbeUsageError("--repo-id cannot be empty");
    }
    return explicit;
  }
  return (
    deps.resolve_repo_id === undefined
      ? await resolveProbeRepositoryId(repoRoot)
      : (await deps.resolve_repo_id(repoRoot)) ?? basename(repoRoot)
  );
}

async function validateDestinationPath(
  repoRoot: string,
  value: string,
): Promise<string> {
  const parsed = ProbeRepositoryRelativePathV1.safeParse(value);
  if (!parsed.success) {
    throw new ProbeUsageError(
      "destination path must be a normalized repository-relative path",
    );
  }
  let existingAncestor = resolve(repoRoot, parsed.data);
  while (true) {
    try {
      existingAncestor = await realpath(existingAncestor);
      break;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  const ancestorRelative = relative(repoRoot, existingAncestor);
  if (
    ancestorRelative === ".." ||
    ancestorRelative.startsWith(`..${sep}`) ||
    isAbsolute(ancestorRelative)
  ) {
    throw new ProbeUsageError("destination path escapes the repository");
  }
  return parsed.data;
}

function createIdDefault(prefix: "probe" | "pi" | "pe" | "par"): string {
  return `${prefix}_${randomUUID()}`;
}

function successEnvelope(result: Record<string, unknown>) {
  return AgentCommandResult.parse({
    protocol_version: PROTOCOL_VERSION,
    status: "ok",
    result,
  });
}

function errorEnvelope(code: ErrorCode, message: string, retryable: boolean) {
  return AgentCommandResult.parse({
    protocol_version: PROTOCOL_VERSION,
    status: "error",
    error: { code, message, retryable },
  });
}

function blockedEnvelope(
  result: Record<string, unknown>,
  message: string,
) {
  return AgentCommandResult.parse({
    protocol_version: PROTOCOL_VERSION,
    status: "blocked",
    result,
    error: { code: "policy_denied", message, retryable: false },
  });
}

function renderHuman(result: Record<string, unknown>): string {
  const session = result["session"] as
    | { session_id?: string; state?: string; revision?: number }
    | undefined;
  const item = result["current_item"] as
    | { item_id?: string; prompt?: string }
    | undefined;
  return [
    String(result["command"] ?? "probe"),
    ...(session === undefined
      ? []
      : [
          `session: ${session.session_id ?? "-"}`,
          `state: ${session.state ?? "-"} revision=${session.revision ?? "-"}`,
        ]),
    ...(item === undefined
      ? []
      : [
          `question: ${item.item_id ?? "-"}`,
          String(item.prompt ?? ""),
        ]),
  ].join("\n");
}

function emitResult(
  deps: ProbeCommandDependencies,
  format: ProbeFormat,
  result: Record<string, unknown>,
): void {
  if (format === "json") {
    deps.stdout(JSON.stringify(successEnvelope(result), null, 2));
  } else {
    deps.stdout(renderHuman(result));
  }
}

function emitError(
  deps: ProbeCommandDependencies,
  json: boolean,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): void {
  if (json) {
    deps.stdout(JSON.stringify(errorEnvelope(code, message, retryable), null, 2));
  } else {
    deps.stderr(`osstack probe: ${message}`);
  }
}

function emitBlocked(
  deps: ProbeCommandDependencies,
  format: ProbeFormat,
  result: Record<string, unknown>,
): void {
  const message = "probe readiness policy denied execution";
  if (format === "json") {
    deps.stdout(JSON.stringify(blockedEnvelope(result, message), null, 2));
  } else {
    deps.stdout(renderHuman(result));
    deps.stderr(`osstack probe: policy_denied: ${message}`);
  }
}

async function openProbeDb(deps: ProbeCommandDependencies) {
  const path = await (deps.state_db_path?.() ?? stateDbPathDefault());
  await mkdir(dirname(path), { recursive: true });
  return openDb({
    path,
    ...(deps.min_free_bytes === undefined
      ? {}
      : { minFreeBytes: deps.min_free_bytes }),
  });
}

function loadDomainState(
  db: ReturnType<typeof openDb>,
  sessionId: string,
): ProbeDomainStateV1 {
  const row = getProbeSession(db, sessionId);
  if (row === undefined) {
    throw new ProbeNotFoundError(`probe session not found: ${sessionId}`);
  }
  return {
    session: ProbeSessionV1.parse(JSON.parse(row.snapshot_json)),
    items: listProbeItems(db, sessionId).map((item) =>
      ProbeItemV1.parse(JSON.parse(item.item_json)),
    ),
  };
}

function resultForState(
  command: string,
  state: ProbeDomainStateV1,
  nowMs: number,
): Record<string, unknown> {
  return {
    command,
    session: state.session,
    current_item: getCurrentProbeItem(state) ?? null,
    readiness: deriveProbeReadiness(state, nowMs),
  };
}

function storedItems(items: readonly ProbeItem[]) {
  return items.map((item) => ({
    item_id: item.item_id,
    question_id: item.question_id,
    state: item.state,
    current_quadrant: item.current_quadrant,
    severity: deriveProbeSeverity(item),
    updated_at_ms: item.updated_at_ms,
    item_json: JSON.stringify(item),
  }));
}

interface PortableInputRef {
  kind: "input" | "reference";
  label: string;
  sha256: string;
  external: boolean;
  repo_relative_path?: string;
}

async function buildInputRef(
  rawPath: string,
  kind: PortableInputRef["kind"],
  repoRoot: string,
  deps: ProbeCommandDependencies,
): Promise<{ ref: PortableInputRef; content: Buffer }> {
  if (rawPath === "-") {
    if (kind !== "input") {
      throw new ProbeUsageError("--reference does not accept stdin");
    }
    const content = Buffer.from(
      await (deps.read_stdin?.() ?? readStdinDefault()),
      "utf8",
    );
    return {
      ref: {
        kind,
        label: "stdin",
        sha256: sha256(content),
        external: true,
      },
      content,
    };
  }
  const requested = resolve(deps.cwd(), rawPath);
  const resolvedPath = await realpath(requested);
  const content = await readRegularFile(resolvedPath);
  const internal = isInside(repoRoot, resolvedPath);
  const repoRelativePath = internal
    ? relative(repoRoot, resolvedPath).split("\\").join("/")
    : undefined;
  return {
    ref: {
      kind,
      label: internal ? (repoRelativePath ?? basename(resolvedPath)) : basename(resolvedPath),
      sha256: sha256(content),
      external: !internal,
      ...(repoRelativePath === undefined
        ? {}
        : { repo_relative_path: repoRelativePath }),
    },
    content,
  };
}

function parseFamiliarity(flags: ParsedFlags): Partial<ProbeFamiliarityV1> {
  const familiarity: Partial<ProbeFamiliarityV1> = {};
  const domain = one(flags, "--domain-familiarity");
  if (
    domain !== undefined &&
    domain !== "novice" &&
    domain !== "working" &&
    domain !== "expert"
  ) {
    throw new ProbeUsageError(`unsupported domain familiarity: ${domain}`);
  }
  if (domain !== undefined) familiarity.domain = domain;
  const repository = one(flags, "--repo-familiarity");
  if (
    repository !== undefined &&
    repository !== "new" &&
    repository !== "familiar" &&
    repository !== "maintainer"
  ) {
    throw new ProbeUsageError(`unsupported repository familiarity: ${repository}`);
  }
  if (repository !== undefined) familiarity.repository = repository;
  const intent = one(flags, "--intent-maturity");
  if (
    intent !== undefined &&
    intent !== "sketch" &&
    intent !== "draft" &&
    intent !== "review_ready"
  ) {
    throw new ProbeUsageError(`unsupported intent maturity: ${intent}`);
  }
  if (intent !== undefined) familiarity.intent = intent;
  return familiarity;
}

async function handleStart(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = parseFlags(args, {
    value_flags: [
      "--repo",
      "--repo-id",
      "--input",
      "--reference",
      "--doc-type",
      "--depth",
      "--task",
      "--domain-familiarity",
      "--repo-familiarity",
      "--intent-maturity",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
      "--format",
    ],
    boolean_flags: ["--json"],
    repeatable_flags: ["--reference", "--doc-type"],
  });
  const format = parseFormat(flags);
  const actor = parseActor(flags);
  const idempotencyKey = required(flags, "--idempotency-key");
  const repoRoot = await realpath(resolve(deps.cwd(), one(flags, "--repo") ?? "."));
  if (!(await stat(repoRoot)).isDirectory()) {
    throw new ProbeUsageError("--repo must resolve to a directory");
  }
  const repoId = await resolveRepoId(
    repoRoot,
    one(flags, "--repo-id"),
    deps,
  );
  const input = await buildInputRef(
    required(flags, "--input"),
    "input",
    repoRoot,
    deps,
  );
  const references = await Promise.all(
    many(flags, "--reference").map((path) =>
      buildInputRef(path, "reference", repoRoot, deps),
    ),
  );
  const rawDocTypes = many(flags, "--doc-type");
  const docTypes = (rawDocTypes.length === 0 ? ["tech"] : rawDocTypes).map(
    (value) => {
      const parsed = ProbeDocTypeV1.safeParse(value);
      if (!parsed.success) throw new ProbeUsageError(`unsupported doc type: ${value}`);
      return parsed.data;
    },
  );
  const uniqueDocTypes = [...new Set(docTypes)];
  const depth = one(flags, "--depth") ?? "standard";
  if (depth !== "quick" && depth !== "standard" && depth !== "deep") {
    throw new ProbeUsageError(`unsupported depth: ${depth}`);
  }
  const familiarity = parseFamiliarity(flags);
  const { policy } = await loadProbeGatePolicy(repoRoot);
  const selection = selectProbeQuestions({
    doc_types: uniqueDocTypes,
    depth,
    familiarity,
    question_budget: policy.budgets[depth],
  });
  const nowMs = (deps.now_ms ?? Date.now)();
  const createId = deps.create_id ?? createIdDefault;
  const sessionId = createId("probe");
  const items = materializeProbeQuestions({
    session_id: sessionId,
    questions: selection.selected_questions,
    created_at_ms: nowMs,
    create_item_id: () => createId("pi"),
  });
  const current = items[0];
  if (current === undefined) {
    throw new ProbeUsageError("question selection produced no questions");
  }
  const inspection = await (
    deps.inspect_repository ?? inspectRepositoryDefault
  )(repoRoot);
  const session = ProbeSessionV1.parse({
    schema_version: "1",
    session_id: sessionId,
    repo_id: repoId,
    ...(inspection.source_revision === undefined
      ? {}
      : { source_revision: inspection.source_revision }),
    worktree_state: inspection.worktree_state,
    ...(one(flags, "--task") === undefined
      ? {}
      : { task_ref: one(flags, "--task") }),
    input_refs: [input.ref, ...references.map((reference) => reference.ref)],
    doc_types: uniqueDocTypes,
    question_pack_refs: selection.question_pack_refs,
    selected_question_ids: selection.selected_questions.map(
      (question) => question.question_id,
    ),
    unselected_required_question_ids:
      selection.unselected_required_question_ids,
    depth,
    question_budget: selection.question_budget,
    questions_presented: 1,
    ...(Object.keys(familiarity).length === 0 ? {} : { familiarity }),
    revision: 1,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    state: "active",
    current_question_id: current.item_id,
  });
  const event: ProbeEventV1 = {
    schema_version: "1",
    event_id: createId("pe"),
    session_id: sessionId,
    revision: 1,
    type: "session_started",
    actor,
    idempotency_key: idempotencyKey,
    occurred_at_ms: nowMs,
    payload: {
      selected_question_ids: session.selected_question_ids,
      unselected_required_question_ids:
        session.unselected_required_question_ids,
      metric_facts: {
        item_facts: items.map(toProbeMetricItemFact),
        ...(session.task_ref === undefined
          ? {}
          : { task_ref: session.task_ref }),
      },
    },
  };
  const state = { session, items };
  const result = resultForState("probe.start", state, nowMs);
  const requestSha = digest({
    repo_id: repoId,
    input_ref: input.ref,
    reference_refs: references.map((reference) => reference.ref),
    doc_types: uniqueDocTypes,
    depth,
    task_ref: one(flags, "--task"),
    familiarity,
    actor,
  });
  const db = await openProbeDb(deps);
  try {
    const stored = createProbeSession(db, {
      session: {
        session_id: session.session_id,
        repo_id: session.repo_id,
        state: session.state,
        revision: session.revision,
        snapshot_json: JSON.stringify(session),
        created_at_ms: session.created_at_ms,
        updated_at_ms: session.updated_at_ms,
      },
      items: storedItems(items),
      event: {
        event_id: event.event_id,
        revision: event.revision,
        type: event.type,
        idempotency_key: event.idempotency_key,
        event_json: JSON.stringify(event),
        occurred_at_ms: event.occurred_at_ms,
      },
      receipt: {
        scope_key: `repo:${repoId}`,
        idempotency_key: idempotencyKey,
        request_sha256: requestSha,
        result_json: JSON.stringify(result),
        created_at_ms: nowMs,
      },
    });
    emitResult(
      deps,
      format,
      JSON.parse(stored.result_json) as Record<string, unknown>,
    );
    return 0;
  } finally {
    db.close();
  }
}

function commonExistingSessionFlags(args: readonly string[], options: ParseFlagOptions) {
  return parseFlags(args, {
    ...options,
    value_flags: [
      ...options.value_flags,
      "--session",
      "--format",
    ],
    boolean_flags: [...(options.boolean_flags ?? []), "--json"],
  });
}

async function readAnswer(
  flags: ParsedFlags,
  deps: ProbeCommandDependencies,
): Promise<string | undefined> {
  const inline = one(flags, "--answer");
  const file = one(flags, "--answer-file");
  if (inline !== undefined && file !== undefined) {
    throw new ProbeUsageError("--answer and --answer-file are mutually exclusive");
  }
  if (inline !== undefined) return inline;
  if (file === undefined) return undefined;
  if (file === "-") return deps.read_stdin?.() ?? readStdinDefault();
  return (await readRegularFile(resolve(deps.cwd(), file))).toString("utf8");
}

function rejectSensitiveAnswer(answer: string): void {
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(answer) ||
    /\b(?:sk|ghp|npm)_[A-Za-z0-9_-]{16,}\b/.test(answer) ||
    /\b(?:password|token|api[_-]?key)\s*[:=]\s*\S+/i.test(answer)
  ) {
    throw new ProbeUsageError(
      "answer appears to contain a secret; record only the secret name and required permission",
    );
  }
}

function calibrationProfileKey(item: ProbeItem): "domain" | "repository" | "intent" {
  if (item.question_id === "cal.domain_familiarity.v1") return "domain";
  if (item.question_id === "cal.repo_familiarity.v1") return "repository";
  if (item.question_id === "cal.intent_maturity.v1") return "intent";
  throw new ProbeUsageError("unknown calibration question id");
}

async function persistMutation(
  db: ReturnType<typeof openDb>,
  state: ProbeDomainStateV1,
  mutation: Parameters<typeof applyProbeMutation>[1],
  requestSha: string,
  command: string,
  nowMs: number,
  extraResult: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const scopeKey = `session:${state.session.session_id}`;
  const replay = replayProbeCommand(db, {
    scope_key: scopeKey,
    idempotency_key: mutation.idempotency_key,
    request_sha256: requestSha,
  });
  if (replay !== undefined) {
    return JSON.parse(replay.result_json) as Record<string, unknown>;
  }
  const next = applyProbeMutation(state, mutation);
  const result = { ...resultForState(command, next, nowMs), ...extraResult };
  const stored = mutateProbeSession(db, {
    session_id: next.session.session_id,
    expected_revision: state.session.revision,
    session: {
      state: next.session.state,
      revision: next.session.revision,
      snapshot_json: JSON.stringify(next.session),
      updated_at_ms: next.session.updated_at_ms,
    },
    items: storedItems(next.items),
    event: {
      event_id: next.event.event_id,
      revision: next.event.revision,
      type: next.event.type,
      idempotency_key: next.event.idempotency_key,
      event_json: JSON.stringify(next.event),
      occurred_at_ms: next.event.occurred_at_ms,
    },
    receipt: {
      scope_key: scopeKey,
      idempotency_key: mutation.idempotency_key,
      request_sha256: requestSha,
      result_json: JSON.stringify(result),
      created_at_ms: nowMs,
    },
  });
  return JSON.parse(stored.result_json) as Record<string, unknown>;
}

async function handleNext(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = commonExistingSessionFlags(args, {
    value_flags: [
      "--question",
      "--if-revision",
      "--answer",
      "--answer-file",
      "--destination-role",
      "--destination-path",
      "--destination-anchor",
      "--owner",
      "--revisit-when",
      "--review-after",
      "--reason",
      "--expires-at",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
    ],
    boolean_flags: ["--defer", "--waive", "--invalidate", "--pause", "--abandon"],
  });
  const format = parseFormat(flags);
  const sessionId = required(flags, "--session");
  const answer = await readAnswer(flags, deps);
  const actions = [
    answer === undefined ? undefined : "answer",
    ...["--defer", "--waive", "--invalidate", "--pause", "--abandon"].filter(
      (flag) => flags.booleans.has(flag),
    ),
  ].filter((action): action is string => action !== undefined);
  if (actions.length > 1) {
    throw new ProbeUsageError("next dispositions are mutually exclusive");
  }
  const db = await openProbeDb(deps);
  try {
    const state = loadDomainState(db, sessionId);
    if (actions.length === 0) {
      emitResult(deps, format, resultForState("probe.next", state, (deps.now_ms ?? Date.now)()));
      return 0;
    }
    const actor = parseActor(flags);
    const idempotencyKey = required(flags, "--idempotency-key");
    const ifRevision = parseInteger(
      required(flags, "--if-revision"),
      "--if-revision",
      { min: 0, max: Number.MAX_SAFE_INTEGER },
    );
    const nowMs = (deps.now_ms ?? Date.now)();
    const currentItem = getCurrentProbeItem(state);
    const normalizedRequest = {
      command: "probe.next",
      session_id: sessionId,
      if_revision: ifRevision,
      action: actions[0],
      question: one(flags, "--question"),
      answer,
      destination_role: one(flags, "--destination-role"),
      destination_path: one(flags, "--destination-path"),
      destination_anchor: one(flags, "--destination-anchor"),
      owner: one(flags, "--owner"),
      revisit_when: one(flags, "--revisit-when"),
      review_after: one(flags, "--review-after"),
      reason: one(flags, "--reason"),
      expires_at: one(flags, "--expires-at"),
      actor,
    };
    const requestSha = digest(normalizedRequest);
    const replay = replayProbeCommand(db, {
      scope_key: `session:${sessionId}`,
      idempotency_key: idempotencyKey,
      request_sha256: requestSha,
    });
    if (replay !== undefined) {
      emitResult(
        deps,
        format,
        JSON.parse(replay.result_json) as Record<string, unknown>,
      );
      return 0;
    }
    const metadata = {
      if_revision: ifRevision,
      actor,
      idempotency_key: idempotencyKey,
      event_id: (deps.create_id ?? createIdDefault)("pe"),
      occurred_at_ms: nowMs,
    };
    let mutation: Parameters<typeof applyProbeMutation>[1];
    if (answer !== undefined) {
      rejectSensitiveAnswer(answer);
      if (currentItem === undefined) {
        throw new ProbeUsageError("session has no current question");
      }
      const itemId = required(flags, "--question");
      const selectedOption = currentItem.options.some(
        (option) => option.option_id === answer,
      )
        ? answer
        : undefined;
      if (currentItem.origin === "calibration") {
        if (
          one(flags, "--destination-role") !== undefined ||
          one(flags, "--destination-path") !== undefined ||
          one(flags, "--destination-anchor") !== undefined
        ) {
          throw new ProbeUsageError(
            "calibration answers do not accept destination flags",
          );
        }
        mutation = {
          type: "resolve",
          item_id: itemId,
          answer,
          ...(selectedOption === undefined
            ? {}
            : { selected_option_id: selectedOption }),
          destination: {
            role: "session_profile",
            profile_key: calibrationProfileKey(currentItem),
            write_state: "verified",
          },
          compilation: { state: "not_eligible" },
          ...metadata,
        };
      } else {
        const destinationRole = ProbeDestinationRoleV1.safeParse(
          required(flags, "--destination-role"),
        );
        if (
          !destinationRole.success ||
          destinationRole.data === "session_profile"
        ) {
          throw new ProbeUsageError("invalid document destination role");
        }
        const destinationPath = await validateDestinationPath(
          await realpath(deps.cwd()),
          required(flags, "--destination-path"),
        );
        mutation = {
          type: "resolve",
          item_id: itemId,
          answer,
          ...(selectedOption === undefined
            ? {}
            : { selected_option_id: selectedOption }),
          destination: {
            role: destinationRole.data,
            path: destinationPath,
            ...(one(flags, "--destination-anchor") === undefined
              ? {}
              : { anchor: one(flags, "--destination-anchor") }),
            write_state: "pending",
          },
          compilation: { state: "not_eligible" },
          ...metadata,
        };
      }
    } else if (flags.booleans.has("--defer")) {
      mutation = {
        type: "defer",
        item_id: required(flags, "--question"),
        owner: required(flags, "--owner"),
        revisit_trigger: required(flags, "--revisit-when"),
        ...(one(flags, "--review-after") === undefined
          ? {}
          : {
              review_after_ms: parseTimestamp(
                required(flags, "--review-after"),
                "--review-after",
              ),
            }),
        ...metadata,
      };
    } else if (flags.booleans.has("--waive")) {
      mutation = {
        type: "waive",
        item_id: required(flags, "--question"),
        reason: required(flags, "--reason"),
        ...(one(flags, "--expires-at") === undefined
          ? {}
          : {
              expires_at_ms: parseTimestamp(
                required(flags, "--expires-at"),
                "--expires-at",
              ),
            }),
        ...metadata,
      };
    } else if (flags.booleans.has("--invalidate")) {
      mutation = {
        type: "invalidate",
        item_id: required(flags, "--question"),
        reason: required(flags, "--reason"),
        ...metadata,
      };
    } else if (flags.booleans.has("--pause")) {
      mutation = {
        type: "pause",
        reason: required(flags, "--reason"),
        ...metadata,
      };
    } else {
      mutation = {
        type: "abandon",
        reason: required(flags, "--reason"),
        ...metadata,
      };
    }
    const result = await persistMutation(
      db,
      state,
      mutation,
      requestSha,
      "probe.next",
      nowMs,
    );
    emitResult(deps, format, result);
    return 0;
  } finally {
    db.close();
  }
}

async function handleResume(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = commonExistingSessionFlags(args, {
    value_flags: [
      "--if-revision",
      "--extend-budget",
      "--revisit",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
    ],
    repeatable_flags: ["--revisit"],
  });
  const format = parseFormat(flags);
  const sessionId = required(flags, "--session");
  const actor = parseActor(flags);
  const idempotencyKey = required(flags, "--idempotency-key");
  const ifRevision = parseInteger(
    required(flags, "--if-revision"),
    "--if-revision",
    { min: 0, max: Number.MAX_SAFE_INTEGER },
  );
  const extension =
    one(flags, "--extend-budget") === undefined
      ? undefined
      : parseInteger(
          required(flags, "--extend-budget"),
          "--extend-budget",
          { min: 1, max: 100 },
        );
  const revisits = many(flags, "--revisit");
  const requestSha = digest({
    command: "probe.resume",
    session_id: sessionId,
    if_revision: ifRevision,
    extend_budget: extension,
    revisit_item_ids: revisits,
    actor,
  });
  const db = await openProbeDb(deps);
  try {
    const replay = replayProbeCommand(db, {
      scope_key: `session:${sessionId}`,
      idempotency_key: idempotencyKey,
      request_sha256: requestSha,
    });
    if (replay !== undefined) {
      emitResult(
        deps,
        format,
        JSON.parse(replay.result_json) as Record<string, unknown>,
      );
      return 0;
    }
    const state = loadDomainState(db, sessionId);
    const nowMs = (deps.now_ms ?? Date.now)();
    const existingQuestionIds = new Set(
      state.items.map((item) => item.question_id),
    );
    let addedItems: ProbeItem[] = [];
    let unselectedRequired = state.session.unselected_required_question_ids;
    if (extension !== undefined) {
      const selection = selectProbeQuestions({
        doc_types: state.session.doc_types,
        depth: state.session.depth,
        ...(state.session.familiarity === undefined
          ? {}
          : { familiarity: state.session.familiarity }),
        question_budget: Math.min(
          100,
          state.session.question_budget + extension,
        ),
      });
      const additions = selection.selected_questions
        .filter((question) => !existingQuestionIds.has(question.question_id))
        .slice(0, extension);
      addedItems = materializeProbeQuestions({
        session_id: sessionId,
        questions: additions,
        created_at_ms: nowMs,
        create_item_id: () => (deps.create_id ?? createIdDefault)("pi"),
      });
      const selectedAfterExtension = new Set([
        ...existingQuestionIds,
        ...addedItems.map((item) => item.question_id),
      ]);
      unselectedRequired = selection.unselected_required_question_ids.filter(
        (questionId) => !selectedAfterExtension.has(questionId),
      );
    }
    const mutation: Parameters<typeof applyProbeMutation>[1] = {
      type: "resume",
      ...(extension === undefined ? {} : { extend_budget: extension }),
      revisit_item_ids: revisits,
      ...(addedItems.length === 0 ? {} : { added_items: addedItems }),
      ...(extension === undefined
        ? {}
        : { unselected_required_question_ids: unselectedRequired }),
      if_revision: ifRevision,
      actor,
      idempotency_key: idempotencyKey,
      event_id: (deps.create_id ?? createIdDefault)("pe"),
      occurred_at_ms: nowMs,
    };
    const result = await persistMutation(
      db,
      state,
      mutation,
      requestSha,
      "probe.resume",
      nowMs,
    );
    emitResult(deps, format, result);
    return 0;
  } finally {
    db.close();
  }
}

async function handleStatus(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = parseFlags(args, {
    value_flags: ["--session", "--repo", "--format"],
    boolean_flags: ["--json"],
  });
  const format = parseFormat(flags);
  const sessionId = one(flags, "--session");
  const repoPath = one(flags, "--repo");
  if ((sessionId === undefined) === (repoPath === undefined)) {
    throw new ProbeUsageError("status requires exactly one of --session or --repo");
  }
  const db = await openProbeDb(deps);
  try {
    if (sessionId !== undefined) {
      const state = loadDomainState(db, sessionId);
      emitResult(
        deps,
        format,
        resultForState("probe.status", state, (deps.now_ms ?? Date.now)()),
      );
      return 0;
    }
    const repoRoot = await realpath(resolve(deps.cwd(), repoPath ?? "."));
    const repoId = await resolveRepoId(repoRoot, undefined, deps);
    const sessions = listProbeSessionsByRepo(db, repoId).map((session) => ({
      session_id: session.session_id,
      repo_id: session.repo_id,
      state: session.state,
      revision: session.revision,
      created_at_ms: session.created_at_ms,
      updated_at_ms: session.updated_at_ms,
    }));
    emitResult(deps, format, {
      command: "probe.status",
      repo_id: repoId,
      sessions,
    });
    return 0;
  } finally {
    db.close();
  }
}

async function handleLedger(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = commonExistingSessionFlags(args, {
    value_flags: ["--state", "--quadrant", "--severity"],
  });
  const format = parseFormat(flags);
  const sessionId = required(flags, "--session");
  const stateFilter = one(flags, "--state");
  const quadrantFilter = one(flags, "--quadrant");
  const severityFilter = one(flags, "--severity");
  if (
    stateFilter !== undefined &&
    !ProbeItemStateV1.safeParse(stateFilter).success
  ) {
    throw new ProbeUsageError(`unsupported item state: ${stateFilter}`);
  }
  if (
    quadrantFilter !== undefined &&
    !ProbeQuadrantV1.safeParse(quadrantFilter).success
  ) {
    throw new ProbeUsageError(`unsupported quadrant: ${quadrantFilter}`);
  }
  if (
    severityFilter !== undefined &&
    !ProbeSeverityV1.safeParse(severityFilter).success
  ) {
    throw new ProbeUsageError(`unsupported severity: ${severityFilter}`);
  }
  const db = await openProbeDb(deps);
  try {
    const state = loadDomainState(db, sessionId);
    const items = state.items.filter(
      (item) =>
        (stateFilter === undefined || item.state === stateFilter) &&
        (quadrantFilter === undefined ||
          item.current_quadrant === quadrantFilter) &&
        (severityFilter === undefined ||
          deriveProbeSeverity(item) === severityFilter),
    );
    const events = listProbeEvents(db, sessionId).map((event) =>
      JSON.parse(event.event_json),
    );
    emitResult(deps, format, {
      command: "probe.ledger",
      session: state.session,
      items,
      events,
      readiness: deriveProbeReadiness(state, (deps.now_ms ?? Date.now)()),
    });
    return 0;
  } finally {
    db.close();
  }
}

async function handleLedgerDestination(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = commonExistingSessionFlags(args, {
    value_flags: [
      "--item",
      "--state",
      "--content-sha256",
      "--if-revision",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
    ],
  });
  const format = parseFormat(flags);
  const sessionId = required(flags, "--session");
  const itemId = required(flags, "--item");
  const destinationState = required(flags, "--state");
  if (destinationState !== "applied" && destinationState !== "verified") {
    throw new ProbeUsageError("destination state must be applied or verified");
  }
  const actor = parseActor(flags);
  const idempotencyKey = required(flags, "--idempotency-key");
  const ifRevision = parseInteger(
    required(flags, "--if-revision"),
    "--if-revision",
    { min: 1, max: Number.MAX_SAFE_INTEGER },
  );
  const contentSha256 = required(flags, "--content-sha256");
  const requestSha = digest({
    command: "probe.ledger.destination",
    session_id: sessionId,
    item_id: itemId,
    destination_state: destinationState,
    content_sha256: contentSha256,
    if_revision: ifRevision,
    actor,
  });
  const db = await openProbeDb(deps);
  try {
    const replay = replayProbeCommand(db, {
      scope_key: `session:${sessionId}`,
      idempotency_key: idempotencyKey,
      request_sha256: requestSha,
    });
    if (replay !== undefined) {
      emitResult(
        deps,
        format,
        JSON.parse(replay.result_json) as Record<string, unknown>,
      );
      return 0;
    }
    const state = loadDomainState(db, sessionId);
    const nowMs = (deps.now_ms ?? Date.now)();
    const result = await persistMutation(
      db,
      state,
      {
        type: "destination",
        item_id: itemId,
        destination_state: destinationState,
        content_sha256: contentSha256,
        if_revision: ifRevision,
        actor,
        idempotency_key: idempotencyKey,
        event_id: (deps.create_id ?? createIdDefault)("pe"),
        occurred_at_ms: nowMs,
      },
      requestSha,
      "probe.ledger.destination",
      nowMs,
    );
    emitResult(deps, format, result);
    return 0;
  } finally {
    db.close();
  }
}

function parseRenderTargets(value: string) {
  if (value === "all") {
    return [
      "ledger",
      "product-delta",
      "technical-delta",
      "test-matrix",
    ] as const;
  }
  if (
    value === "ledger" ||
    value === "product-delta" ||
    value === "technical-delta" ||
    value === "test-matrix"
  ) {
    return [value] as const;
  }
  throw new ProbeUsageError(`unsupported render target: ${value}`);
}

async function handleRender(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = commonExistingSessionFlags(args, {
    value_flags: [
      "--if-revision",
      "--target",
      "--out",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
    ],
  });
  const format = parseFormat(flags);
  const sessionId = required(flags, "--session");
  const ifRevision = parseInteger(
    required(flags, "--if-revision"),
    "--if-revision",
    { min: 1, max: Number.MAX_SAFE_INTEGER },
  );
  const targets = parseRenderTargets(required(flags, "--target"));
  const outDir =
    one(flags, "--out") ?? `docs/probe/sessions/${sessionId}`;
  const actor = parseActor(flags);
  const idempotencyKey = required(flags, "--idempotency-key");
  const requestSha = digest({
    command: "probe.render",
    session_id: sessionId,
    if_revision: ifRevision,
    targets,
    out_dir: outDir,
    actor,
  });
  const repoRoot = await realpath(deps.cwd());
  const db = await openProbeDb(deps);
  try {
    const replay = replayProbeCommand(db, {
      scope_key: `session:${sessionId}`,
      idempotency_key: idempotencyKey,
      request_sha256: requestSha,
    });
    if (replay !== undefined) {
      const replayedResult = JSON.parse(replay.result_json) as Record<
        string,
        unknown
      >;
      try {
        await readProbeRenderDirectory(resolve(repoRoot, outDir));
      } catch {
        throw new ProbeRenderWriteError(
          "artifact_conflict",
          "render receipt exists but its artifact set is missing or modified",
        );
      }
      emitResult(deps, format, replayedResult);
      return 0;
    }
    const state = loadDomainState(db, sessionId);
    if (state.session.revision !== ifRevision) {
      throw new ProbeStoreConflictError(
        "revision_conflict",
        `expected revision ${ifRevision}, found ${state.session.revision}`,
        state.session.revision,
      );
    }
    const nowMs = (deps.now_ms ?? Date.now)();
    const events = listProbeEvents(db, sessionId).map((event) =>
      JSON.parse(event.event_json),
    );
    const bundle = createProbeRenderBundle({
      state,
      events,
      exported_at_ms: nowMs,
      generator_version: VERSION,
      targets,
    });
    const protectedInputPaths = state.session.input_refs.flatMap((input) =>
      input.repo_relative_path === undefined
        ? []
        : [resolve(repoRoot, input.repo_relative_path)],
    );
    const written = await writeProbeRenderBundle({
      repo_root: repoRoot,
      out_dir: outDir,
      bundle,
      protected_input_paths: protectedInputPaths,
    });
    const result = {
      command: "probe.render",
      session: state.session,
      artifact: {
        out_dir: outDir,
        manifest_path: `${outDir}/render-manifest.json`,
        ledger_sha256: bundle.ledger_sha256,
        manifest: bundle.manifest,
      },
      readiness: bundle.ledger.readiness,
    };
    try {
      const stored = recordProbeArtifact(db, {
        receipt_id: (deps.create_id ?? createIdDefault)("par"),
        session_id: sessionId,
        exported_revision: ifRevision,
        idempotency_key: idempotencyKey,
        actor,
        manifest_json: bundle.manifest_content,
        rendered_at_ms: nowMs,
        request_sha256: requestSha,
        result_json: JSON.stringify(result),
      });
      emitResult(
        deps,
        format,
        JSON.parse(stored.result_json) as Record<string, unknown>,
      );
      return 0;
    } catch (error) {
      await rm(written.manifest_path, { force: true });
      throw error;
    }
  } finally {
    db.close();
  }
}

async function handleGate(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = parseFlags(args, {
    value_flags: ["--session", "--ledger", "--config", "--format"],
    boolean_flags: ["--json"],
  });
  const format = parseFormat(flags);
  const sessionId = one(flags, "--session");
  const ledgerPath = one(flags, "--ledger");
  if ((sessionId === undefined) === (ledgerPath === undefined)) {
    throw new ProbeUsageError(
      "gate requires exactly one of --session or --ledger",
    );
  }
  const repoRoot = await realpath(deps.cwd());
  const loadedPolicy = await loadProbeGatePolicy(
    repoRoot,
    one(flags, "--config"),
  );
  let source: { kind: "session" | "ledger"; ref: string };
  let state: ProbeDomainStateV1;
  let events: ProbeEventV1[];
  if (sessionId !== undefined) {
    const db = await openProbeDb(deps);
    try {
      state = loadDomainState(db, sessionId);
      events = listProbeEvents(db, sessionId).map((event) =>
        JSON.parse(event.event_json),
      );
    } finally {
      db.close();
    }
    source = { kind: "session", ref: sessionId };
  } else {
    const portable = await readPortableProbeLedger(
      repoRoot,
      ledgerPath ?? "",
    );
    state = {
      session: portable.ledger.session,
      items: portable.ledger.items,
    };
    events = portable.ledger.events;
    source = { kind: "ledger", ref: ledgerPath ?? "" };
  }
  const destinationContent = await collectProbeDestinationContent(
    repoRoot,
    state.items,
  );
  const gate = evaluateProbeGate({
    session: state.session,
    items: state.items,
    events,
    policy: loadedPolicy.policy,
    now_ms: (deps.now_ms ?? Date.now)(),
    destination_content: destinationContent,
  });
  const result = {
    command: "probe.gate",
    source,
    policy_source: loadedPolicy.source,
    enforcement: gate.enforcement,
    eligible: gate.readiness.eligible,
    readiness: gate.readiness,
  };
  if (gate.blocked) {
    emitBlocked(deps, format, result);
    return 1;
  }
  emitResult(deps, format, result);
  return 0;
}

async function requireRepositoryRevision(
  repoRoot: string,
  deps: ProbeCommandDependencies,
): Promise<ProbeRepositoryInspectionV1 & { source_revision: string }> {
  const inspection = await (
    deps.inspect_repository ?? inspectRepositoryDefault
  )(repoRoot);
  if (inspection.source_revision === undefined) {
    throw new ProbeUsageError(
      "dynamic probe inputs require a Git repository source revision",
    );
  }
  return { ...inspection, source_revision: inspection.source_revision };
}

async function handleAdd(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = commonExistingSessionFlags(args, {
    value_flags: [
      "--if-revision",
      "--from",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
    ],
  });
  const format = parseFormat(flags);
  const sessionId = required(flags, "--session");
  const ifRevision = parseInteger(
    required(flags, "--if-revision"),
    "--if-revision",
    { min: 1, max: Number.MAX_SAFE_INTEGER },
  );
  const actor = parseActor(flags);
  const idempotencyKey = required(flags, "--idempotency-key");
  const repoRoot = await realpath(deps.cwd());
  const batch = await readProbeQuestionBatch(
    repoRoot,
    required(flags, "--from"),
  );
  const inspection = await requireRepositoryRevision(repoRoot, deps);
  for (const question of batch.questions) {
    rejectSensitiveAnswer(question.prompt);
    for (const option of question.options) {
      rejectSensitiveAnswer(`${option.label}\n${option.description}`);
    }
  }
  const requestSha = digest({
    command: "probe.add",
    session_id: sessionId,
    if_revision: ifRevision,
    batch,
    actor,
  });
  const db = await openProbeDb(deps);
  try {
    const replay = replayProbeCommand(db, {
      scope_key: `session:${sessionId}`,
      idempotency_key: idempotencyKey,
      request_sha256: requestSha,
    });
    if (replay !== undefined) {
      emitResult(
        deps,
        format,
        JSON.parse(replay.result_json) as Record<string, unknown>,
      );
      return 0;
    }
    const state = loadDomainState(db, sessionId);
    const nowMs = (deps.now_ms ?? Date.now)();
    const dynamic = await materializeProbeQuestionBatch({
      batch,
      session_id: sessionId,
      source_revision: inspection.source_revision,
      actor,
      existing_items: state.items,
      created_at_ms: nowMs,
      create_item_id: () => (deps.create_id ?? createIdDefault)("pi"),
      verify_evidence: (evidence) =>
        verifyProbeDynamicEvidence(repoRoot, evidence),
    });
    const result = await persistMutation(
      db,
      state,
      {
        type: "add",
        items: dynamic.items,
        batch_id: batch.batch_id,
        origin: batch.origin,
        source_revision: batch.source_revision,
        if_revision: ifRevision,
        actor,
        idempotency_key: idempotencyKey,
        event_id: (deps.create_id ?? createIdDefault)("pe"),
        occurred_at_ms: nowMs,
      },
      requestSha,
      "probe.add",
      nowMs,
    );
    emitResult(deps, format, result);
    return 0;
  } finally {
    db.close();
  }
}

async function handleRestate(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = parseFlags(args, {
    value_flags: [
      "--spec",
      "--restatement",
      "--findings",
      "--repo",
      "--repo-id",
      "--session",
      "--if-revision",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
      "--format",
    ],
    boolean_flags: ["--json"],
  });
  const format = parseFormat(flags);
  const actor = parseActor(flags);
  if (actor.type !== "agent") {
    throw new ProbeUsageError("restate findings must be registered by an agent");
  }
  const idempotencyKey = required(flags, "--idempotency-key");
  const sessionId = one(flags, "--session");
  const rawRevision = one(flags, "--if-revision");
  if ((sessionId === undefined) !== (rawRevision === undefined)) {
    throw new ProbeUsageError(
      "attached restate requires both --session and --if-revision",
    );
  }
  const ifRevision =
    rawRevision === undefined
      ? undefined
      : parseInteger(rawRevision, "--if-revision", {
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
        });
  const repoRoot = await realpath(
    resolve(deps.cwd(), one(flags, "--repo") ?? "."),
  );
  const spec = await buildInputRef(
    required(flags, "--spec"),
    "input",
    repoRoot,
    deps,
  );
  const restatement = await buildInputRef(
    required(flags, "--restatement"),
    "reference",
    repoRoot,
    deps,
  );
  const findings = await readProbeRestatementFindings(
    repoRoot,
    required(flags, "--findings"),
  );
  const evidenceRefs = verifyProbeRestatementEvidence(
    findings,
    {
      label: "spec",
      content: spec.content,
      ...(spec.ref.repo_relative_path === undefined
        ? {}
        : { repo_relative_path: spec.ref.repo_relative_path }),
    },
    {
      label: "restatement",
      content: restatement.content,
      ...(restatement.ref.repo_relative_path === undefined
        ? {}
        : { repo_relative_path: restatement.ref.repo_relative_path }),
    },
  );
  for (const finding of findings) {
    rejectSensitiveAnswer(
      `${finding.explanation}\n${finding.proposed_question}`,
    );
  }
  const inspection = await requireRepositoryRevision(repoRoot, deps);
  const batch = createRestatementQuestionBatch({
    findings,
    generated_by: actor,
    source_revision: inspection.source_revision,
    evidence_refs: evidenceRefs,
  });
  const repoId = await resolveRepoId(
    repoRoot,
    one(flags, "--repo-id"),
    deps,
  );
  const requestSha = digest({
    command: "probe.restate",
    repo_id: repoId,
    session_id: sessionId,
    if_revision: ifRevision,
    spec_ref: spec.ref,
    restatement_ref: restatement.ref,
    findings,
    actor,
  });
  const nowMs = (deps.now_ms ?? Date.now)();
  const createId = deps.create_id ?? createIdDefault;

  if (sessionId !== undefined && ifRevision !== undefined) {
    const db = await openProbeDb(deps);
    try {
      const replay = replayProbeCommand(db, {
        scope_key: `session:${sessionId}`,
        idempotency_key: idempotencyKey,
        request_sha256: requestSha,
      });
      if (replay !== undefined) {
        emitResult(
          deps,
          format,
          JSON.parse(replay.result_json) as Record<string, unknown>,
        );
        return 0;
      }
      const state = loadDomainState(db, sessionId);
      if (state.session.repo_id !== repoId) {
        throw new ProbeUsageError(
          "attached restate repository does not match the session",
        );
      }
      const dynamic = await materializeProbeQuestionBatch({
        batch,
        session_id: sessionId,
        source_revision: inspection.source_revision,
        actor,
        existing_items: state.items,
        created_at_ms: nowMs,
        create_item_id: () => createId("pi"),
        verify_evidence: async () => ({ verifiable: true }),
      });
      const result = await persistMutation(
        db,
        state,
        {
          type: "add",
          items: dynamic.items,
          batch_id: batch.batch_id,
          origin: batch.origin,
          source_revision: batch.source_revision,
          restatement_findings: findings,
          if_revision: ifRevision,
          actor,
          idempotency_key: idempotencyKey,
          event_id: createId("pe"),
          occurred_at_ms: nowMs,
        },
        requestSha,
        "probe.restate",
        nowMs,
      );
      emitResult(deps, format, result);
      return 0;
    } finally {
      db.close();
    }
  }

  const newSessionId = createId("probe");
  const dynamic = await materializeProbeQuestionBatch({
    batch,
    session_id: newSessionId,
    source_revision: inspection.source_revision,
    actor,
    existing_items: [],
    created_at_ms: nowMs,
    create_item_id: () => createId("pi"),
    verify_evidence: async () => ({ verifiable: true }),
  });
  const current = sortProbeItems(dynamic.items)[0];
  if (current === undefined) {
    throw new ProbeUsageError("restate produced no questions");
  }
  const { policy } = await loadProbeGatePolicy(repoRoot);
  const session = ProbeSessionV1.parse({
    schema_version: "1",
    session_id: newSessionId,
    repo_id: repoId,
    source_revision: inspection.source_revision,
    worktree_state: inspection.worktree_state,
    input_refs: [spec.ref, restatement.ref],
    doc_types: ["tech"],
    question_pack_refs: [],
    selected_question_ids: dynamic.items.map((item) => item.question_id),
    unselected_required_question_ids: [],
    depth: "standard",
    question_budget: policy.budgets.standard,
    questions_presented: 1,
    revision: 1,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    state: "active",
    current_question_id: current.item_id,
  });
  const event: ProbeEventV1 = {
    schema_version: "1",
    event_id: createId("pe"),
    session_id: newSessionId,
    revision: 1,
    type: "session_started",
    actor,
    idempotency_key: idempotencyKey,
    occurred_at_ms: nowMs,
    payload: {
      source: "skill_restatement_findings",
      finding_ids: findings.map((finding) => finding.finding_id),
      restatement_findings: findings,
      selected_question_ids: session.selected_question_ids,
      metric_facts: {
        item_facts: dynamic.items.map(toProbeMetricItemFact),
      },
    },
  };
  const state = { session, items: dynamic.items };
  const result = resultForState("probe.restate", state, nowMs);
  const db = await openProbeDb(deps);
  try {
    const stored = createProbeSession(db, {
      session: {
        session_id: session.session_id,
        repo_id: session.repo_id,
        state: session.state,
        revision: session.revision,
        snapshot_json: JSON.stringify(session),
        created_at_ms: session.created_at_ms,
        updated_at_ms: session.updated_at_ms,
      },
      items: storedItems(dynamic.items),
      event: {
        event_id: event.event_id,
        revision: event.revision,
        type: event.type,
        idempotency_key: event.idempotency_key,
        event_json: JSON.stringify(event),
        occurred_at_ms: event.occurred_at_ms,
      },
      receipt: {
        scope_key: `repo:${repoId}`,
        idempotency_key: idempotencyKey,
        request_sha256: requestSha,
        result_json: JSON.stringify(result),
        created_at_ms: nowMs,
      },
    });
    emitResult(
      deps,
      format,
      JSON.parse(stored.result_json) as Record<string, unknown>,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function handleCompile(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const flags = commonExistingSessionFlags(args, {
    value_flags: [
      "--if-revision",
      "--from",
      "--out",
      "--actor-kind",
      "--actor-id",
      "--idempotency-key",
    ],
  });
  const format = parseFormat(flags);
  const sessionId = required(flags, "--session");
  const ifRevision = parseInteger(
    required(flags, "--if-revision"),
    "--if-revision",
    { min: 1, max: Number.MAX_SAFE_INTEGER },
  );
  const actor = parseActor(flags);
  if (actor.type !== "agent") {
    throw new ProbeUsageError("evaluation compilation requires an agent actor");
  }
  const idempotencyKey = required(flags, "--idempotency-key");
  const fromPath = required(flags, "--from");
  const outPath =
    one(flags, "--out") ??
    `docs/probe/evaluations/${sessionId}-r${ifRevision}.json`;
  const repoRoot = await realpath(deps.cwd());
  const batch = await readProbeCompilationBatch(repoRoot, fromPath);
  for (const request of batch.requests) {
    if (request.template_id === "manual-acceptance.v1") {
      rejectSensitiveAnswer(
        `${request.params.acceptance}\n${request.params.reason}`,
      );
    } else {
      rejectSensitiveAnswer(request.params.description);
    }
  }
  const requestSha = digest({
    command: "probe.compile",
    session_id: sessionId,
    if_revision: ifRevision,
    batch,
    out_path: outPath,
    actor,
  });
  const db = await openProbeDb(deps);
  try {
    const replay = replayProbeCommand(db, {
      scope_key: `session:${sessionId}`,
      idempotency_key: idempotencyKey,
      request_sha256: requestSha,
    });
    if (replay !== undefined) {
      const result = JSON.parse(replay.result_json) as Record<string, unknown>;
      const artifact = result["artifact"] as
        | { path?: string; sha256?: string }
        | undefined;
      if (artifact?.path === undefined || artifact.sha256 === undefined) {
        throw new ProbeCompileFileError(
          "artifact_conflict",
          "compile receipt is missing its artifact identity",
        );
      }
      await verifyProbeCompilationDelta(
        repoRoot,
        artifact.path,
        artifact.sha256,
      );
      emitResult(deps, format, result);
      return 0;
    }
    const state = loadDomainState(db, sessionId);
    if (state.session.revision !== ifRevision) {
      throw new ProbeStoreConflictError(
        "revision_conflict",
        `expected revision ${ifRevision}, found ${state.session.revision}`,
        state.session.revision,
      );
    }
    const nowMs = (deps.now_ms ?? Date.now)();
    const delta = await compileProbeEvaluations({
      batch,
      session_id: sessionId,
      exported_revision: ifRevision,
      generated_at_ms: nowMs,
      spec_ref: outPath,
      items: state.items,
      environment: createProbeCompilerEnvironment(repoRoot),
    });
    const written = await writeProbeCompilationDelta(
      repoRoot,
      outPath,
      delta,
      [fromPath],
    );
    try {
      const result = await persistMutation(
        db,
        state,
        {
          type: "compile",
          compilations: delta.compilations.map((entry) => ({
            item_id: entry.item_id,
            compilation: entry.compilation,
          })),
          if_revision: ifRevision,
          actor,
          idempotency_key: idempotencyKey,
          event_id: (deps.create_id ?? createIdDefault)("pe"),
          occurred_at_ms: nowMs,
        },
        requestSha,
        "probe.compile",
        nowMs,
        {
          evaluation_delta: delta,
          artifact: {
            path: written.portable_path,
            sha256: written.sha256,
          },
        },
      );
      emitResult(deps, format, result);
      return 0;
    } catch (error) {
      if (written.created) await rm(written.path, { force: true });
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function handleProbeCommand(
  args: readonly string[],
  deps: ProbeCommandDependencies,
): Promise<number> {
  const json = wantsJson(args);
  try {
    const command = args[0];
    if (command === undefined || command === "--help" || command === "-h") {
      deps.stdout(renderProbeHelp());
      return 0;
    }
    const rest = args.slice(1);
    if (command === "start") return await handleStart(rest, deps);
    if (command === "next") return await handleNext(rest, deps);
    if (command === "resume") return await handleResume(rest, deps);
    if (command === "status") return await handleStatus(rest, deps);
    if (command === "ledger" && rest[0] === "destination") {
      return await handleLedgerDestination(rest.slice(1), deps);
    }
    if (command === "ledger") return await handleLedger(rest, deps);
    if (command === "render") return await handleRender(rest, deps);
    if (command === "gate") return await handleGate(rest, deps);
    if (command === "add") return await handleAdd(rest, deps);
    if (command === "restate") return await handleRestate(rest, deps);
    if (command === "compile") return await handleCompile(rest, deps);
    throw new ProbeUsageError(`unknown subcommand: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProbeStoreConflictError || error instanceof ProbeReducerError) {
      const isConflict =
        error instanceof ProbeStoreConflictError || error.code === "conflict";
      emitError(
        deps,
        json,
        isConflict ? "conflict" : "bad_request",
        message,
        isConflict,
      );
      return isConflict ? 3 : 2;
    }
    if (error instanceof ProbeNotFoundError) {
      emitError(deps, json, "not_found", message, false);
      return 2;
    }
    if (error instanceof ProbeRenderWriteError) {
      const conflict = error.code === "artifact_conflict";
      emitError(
        deps,
        json,
        conflict ? "conflict" : "bad_request",
        message,
        conflict,
      );
      return conflict ? 3 : 2;
    }
    if (error instanceof ProbeGateInputError) {
      emitError(deps, json, "bad_request", message, false);
      return 2;
    }
    if (
      error instanceof ProbeDynamicInputError ||
      error instanceof ProbeDynamicFileError
    ) {
      emitError(deps, json, "bad_request", message, false);
      return 2;
    }
    if (error instanceof ProbeEvaluationCompilerError) {
      emitError(deps, json, "bad_request", message, false);
      return 2;
    }
    if (error instanceof ProbeCompileFileError) {
      const conflict = error.code === "artifact_conflict";
      emitError(
        deps,
        json,
        conflict ? "conflict" : "bad_request",
        message,
        conflict,
      );
      return conflict ? 3 : 2;
    }
    if (
      error instanceof ProbeUsageError ||
      (error instanceof Error && error.name === "ZodError")
    ) {
      emitError(deps, json, "bad_request", message, false);
      return 2;
    }
    emitError(deps, json, "internal", message, true);
    return 3;
  }
}
