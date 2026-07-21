import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { userInfo } from "node:os";
import {
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createBuiltInSemanticJudge } from "@osstack/agents";
import {
  appendDependencyObligationEventV2,
  appendDeclaredDependencyEdgeEventV2,
  getDeclaredDependencyEdgeProjectionV2,
  getDependencyObligationProjectionV2,
  getDependencyRegistryPathV2,
  getKnowledgeHygienePlanProjectionV1,
  listDeclaredDependencyEdgeProjectionsV2,
  listDependencyObligationInboxV2,
  registerDependencyRegistryScopeV2,
} from "@osstack/core";
import {
  applyKnowledgeHygieneTransactionPlanV1,
  approveKnowledgeHygieneTransactionPlanV1,
  buildKnowledgeHygieneTransactionPlanV1,
  createDependencyObligationV2,
  createDeclaredDependencyEdgeIdV2,
  DependencyObligationV2,
  KnowledgeHygieneSimulatedCrashV1,
  KnowledgeHygieneTransactionErrorV1,
  KnowledgeHygieneTransactionPlanV1,
  judgeDependencyCandidateV2,
  parseKnowledgeHygieneConfigV2,
  scanKnowledgeHygieneDependencyCandidatesV2,
  transitionDependencyObligationV2,
  recoverKnowledgeHygieneTransactionPlanV1,
  type DeclaredDependencyV2,
  type DependencyObligationV2 as DependencyObligation,
  type KnowledgeHygieneTransactionApplyHooksV1,
  type SemanticJudgePort,
} from "@osstack/governance";
import { readRepoRegistry } from "@osstack/supervisor";
import { parseDocument } from "yaml";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import {
  assertRootFingerprints,
  gitIdentity,
  loadPlan,
  recordEvent as recordTransactionEvent,
  requireTty,
  savePlan,
} from "./neat-transaction-command.js";
import { osstackHome } from "./paths.js";

export interface NeatDependencyCommandDependencies {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  home?: () => string;
  now?: () => Date;
  min_free_bytes?: number;
  is_tty?: () => boolean;
  local_user_id?: () => string;
  apply_hooks?: KnowledgeHygieneTransactionApplyHooksV1;
  judge_factory?: (judgeId: string) => SemanticJudgePort;
  after_config_apply_before_core?: () => void | Promise<void>;
}

class NeatDependencyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatDependencyUsageError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventId(body: object): string {
  return `khoe_${digest(JSON.stringify(body))}`;
}

function edgeEventId(body: object): string {
  return `khee_${digest(JSON.stringify(body))}`;
}

function option(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new NeatDependencyUsageError(`duplicate option ${name}`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new NeatDependencyUsageError(`${name} requires a value`);
  }
  return value;
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.trim().length === 0) {
    throw new NeatDependencyUsageError(`${name} is required`);
  }
  return value;
}

function validateOptions(
  args: readonly string[],
  allowedValues: ReadonlySet<string>,
  allowedFlags: ReadonlySet<string>,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (allowedFlags.has(value)) continue;
    if (!allowedValues.has(value)) {
      throw new NeatDependencyUsageError(`unknown option ${value}`);
    }
    index += 1;
  }
}

async function registryIdentity(path: string): Promise<{
  path: string;
  scope: string;
}> {
  const canonical = await realpath(path);
  return { path: canonical, scope: digest(canonical) };
}

function stateDatabase(
  deps: NeatDependencyCommandDependencies,
  home: string,
) {
  return openDb({
    path: join(home, "state.db"),
    ...(deps.min_free_bytes === undefined ? {} : { minFreeBytes: deps.min_free_bytes }),
  });
}

function defaultJudgeFactory(judgeId: string): SemanticJudgePort {
  try {
    return createBuiltInSemanticJudge(judgeId);
  } catch (error) {
    throw new NeatDependencyUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function scan(
  args: readonly string[],
  deps: NeatDependencyCommandDependencies,
): Promise<number> {
  validateOptions(
    args,
    new Set(["--registry", "--judge", "--format"]),
    new Set(["--record", "--json"]),
  );
  const judgeId = option(args, "--judge");
  if (judgeId !== undefined && !args.includes("--record")) {
    throw new NeatDependencyUsageError(
      "--judge requires --record so verified advisory transitions are auditable",
    );
  }
  const registryArg = required(args, "--registry");
  const registryPath = resolve(deps.cwd(), registryArg);
  const registry = await registryIdentity(registryPath);
  const entries = (await readRepoRegistry(registry.path))
    .filter((entry) => entry.enabled);
  if (entries.length === 0) {
    throw new NeatDependencyUsageError("registry has no enabled repositories");
  }
  const repositories = [];
  for (const entry of entries) {
    const configured = isAbsolute(entry.path)
      ? entry.path
      : resolve(dirname(registry.path), entry.path);
    repositories.push({
      repo_id: entry.repo_id,
      root_realpath: await realpath(configured),
    });
  }
  const result = await scanKnowledgeHygieneDependencyCandidatesV2({
    registry_scope: registry.scope,
    repositories,
  });
  const semanticJudge = judgeId === undefined || result.candidates.length === 0
    ? undefined
    : (deps.judge_factory ?? defaultJudgeFactory)(judgeId);
  let obligationsRecorded = 0;
  let advisoriesRecorded = 0;
  let dismissedRecorded = 0;
  let semanticCandidatesSkipped = 0;
  let semanticUsage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let reconciledEdges = 0;
  if (args.includes("--record")) {
    const home = (deps.home ?? osstackHome)();
    await mkdir(home, { recursive: true, mode: 0o700 });
    const database = stateDatabase(deps, home);
    try {
      const now = (deps.now ?? (() => new Date()))();
      registerDependencyRegistryScopeV2(database, {
        registry_scope: registry.scope,
        registry_path: registry.path,
        updated_at: now.toISOString(),
      });
      reconciledEdges = await reconcileRegistryConfig(
        database,
        registry.scope,
        repositories,
        now,
      );
      for (const projection of listDependencyObligationInboxV2(database, {
        registry_scope: registry.scope,
      })) {
        const current = DependencyObligationV2.parse(JSON.parse(projection.snapshot_json));
        if (Date.parse(current.expires_at) > now.getTime()) continue;
        const expired = transitionDependencyObligationV2(current, {
          to_state: "expired",
          actor: "system:clock",
          reason: "Dependency obligation TTL elapsed.",
          if_revision: current.revision,
          occurred_at: now.toISOString(),
        });
        await persistObligationTransition(
          database,
          current,
          expired,
          "system:clock",
          "Dependency obligation TTL elapsed.",
          now.toISOString(),
        );
      }
      for (const candidate of result.candidates) {
        const obligation = createDependencyObligationV2(candidate, {
          created_at: now.toISOString(),
          expires_at: new Date(
            now.getTime() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });
        let projection = getDependencyObligationProjectionV2(
          database,
          obligation.obligation_id,
        );
        if (projection === undefined) {
          const body = {
            schema_version: "2" as const,
            obligation_id: obligation.obligation_id,
            registry_scope: obligation.registry_scope,
            downstream_repo_id: obligation.downstream_repo_id,
            revision: obligation.revision,
            from_state: null,
            to_state: obligation.state,
            snapshot_json: JSON.stringify(obligation),
            actor: "system:dependency-scan",
            reason: "Recorded deterministic cross-repository candidate evidence.",
            occurred_at: now.toISOString(),
          };
          const appended = appendDependencyObligationEventV2(database, {
            ...body,
            event_id: eventId(body),
          });
          if (appended.inserted) obligationsRecorded += 1;
          projection = getDependencyObligationProjectionV2(
            database,
            obligation.obligation_id,
          );
        }
        if (projection !== undefined) {
          const expectedEdgeId = createDeclaredDependencyEdgeIdV2({
            registry_scope: candidate.registry_scope,
            upstream_repo_id: candidate.upstream_repo_id,
            downstream_repo_id: candidate.downstream_repo_id,
            kinds: candidate.kinds,
          });
          const edgeProjection = getDeclaredDependencyEdgeProjectionV2(
            database,
            expectedEdgeId,
          );
          if (edgeProjection !== undefined && edgeProjection.state !== "revoked") {
            const current = DependencyObligationV2.parse(
              JSON.parse(projection.snapshot_json),
            );
            if (current.state === "advisory") {
              const promoted = transitionDependencyObligationV2(current, {
                to_state: "promoted",
                actor: "system:config-reconciliation",
                reason: "Authoritative ConfigV2 already contains this declared edge.",
                if_revision: current.revision,
                occurred_at: now.toISOString(),
                promoted_edge_id: expectedEdgeId,
              });
              await persistObligationTransition(
                database,
                current,
                promoted,
                "system:config-reconciliation",
                "Authoritative ConfigV2 already contains this declared edge.",
                now.toISOString(),
              );
            } else if (current.state === "candidate") {
              const dismissed = transitionDependencyObligationV2(current, {
                to_state: "dismissed",
                actor: "system:config-reconciliation",
                reason: "Candidate is already covered by authoritative ConfigV2.",
                if_revision: current.revision,
                occurred_at: now.toISOString(),
              });
              await persistObligationTransition(
                database,
                current,
                dismissed,
                "system:config-reconciliation",
                "Candidate is already covered by authoritative ConfigV2.",
                now.toISOString(),
              );
            }
            continue;
          }
        }
        if (semanticJudge === undefined || projection?.state !== "candidate") continue;
        if (semanticUsage.calls >= 8) {
          semanticCandidatesSkipped += 1;
          continue;
        }
        const runId = `khdr_${digest(JSON.stringify([
          registry.scope,
          candidate.candidate_id,
          now.toISOString(),
          semanticJudge.id,
        ]))}`;
        const judged = await judgeDependencyCandidateV2({
          candidate,
          repositories,
          run_id: runId,
          budget: {
            max_input_tokens: 16_000,
            max_output_tokens: 2_000,
            max_calls: 1,
          },
        }, semanticJudge);
        semanticUsage = {
          input_tokens: semanticUsage.input_tokens + judged.response.usage.input_tokens,
          output_tokens: semanticUsage.output_tokens + judged.response.usage.output_tokens,
          calls: semanticUsage.calls + judged.response.usage.calls,
        };
        const current = DependencyObligationV2.parse(
          JSON.parse(projection.snapshot_json),
        );
        if (judged.decision.verdict === "uncertain") continue;
        const next = transitionDependencyObligationV2(current, {
          to_state: judged.decision.verdict === "issue" ? "advisory" : "dismissed",
          actor: `judge:${semanticJudge.id}`,
          reason: "Recorded schema- and citation-verified dependency verdict.",
          if_revision: current.revision,
          occurred_at: now.toISOString(),
          ...(judged.decision.verdict === "issue"
            ? { rationale: judged.decision.rationale }
            : {}),
          evidence_refs: [{
            kind: "evidence_pack",
            ref: judged.evidence_pack.pack_id,
            sha256: judged.evidence_pack.pack_sha256,
            run_id: runId,
          }],
        });
        await persistObligationTransition(
          database,
          current,
          next,
          `judge:${semanticJudge.id}`,
          judged.decision.rationale,
          now.toISOString(),
        );
        if (next.state === "advisory") advisoriesRecorded += 1;
        else dismissedRecorded += 1;
      }
    } finally {
      database.close();
    }
  }
  const json = args.includes("--json") || option(args, "--format") === "json";
  if (json) {
    deps.stdout(JSON.stringify({
      ...result,
      registry_path: registry.path,
      obligations_recorded: obligationsRecorded,
      advisories_recorded: advisoriesRecorded,
      dismissed_recorded: dismissedRecorded,
      semantic_candidates_skipped: semanticCandidatesSkipped,
      semantic_usage: semanticUsage,
      reconciled_edges: reconciledEdges,
    }, null, 2));
  } else {
    deps.stdout(
      `Dependency scan: ${result.candidates.length} candidate(s), ${obligationsRecorded} recorded, ${advisoriesRecorded} advisory, ${reconciledEdges} edge projection(s) reconciled.`,
    );
  }
  return 0;
}

async function inbox(
  args: readonly string[],
  deps: NeatDependencyCommandDependencies,
): Promise<number> {
  validateOptions(
    args,
    new Set(["--registry", "--repo-id", "--format"]),
    new Set(["--json"]),
  );
  const registryPath = resolve(deps.cwd(), required(args, "--registry"));
  const registry = await registryIdentity(registryPath);
  const repoId = required(args, "--repo-id");
  const entries = await readRepoRegistry(registry.path);
  if (!entries.some((entry) => entry.enabled && entry.repo_id === repoId)) {
    throw new NeatDependencyUsageError(`repo is not enabled in registry: ${repoId}`);
  }
  const home = (deps.home ?? osstackHome)();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const database = stateDatabase(deps, home);
  let obligations: DependencyObligation[];
  try {
    obligations = listDependencyObligationInboxV2(database, {
      registry_scope: registry.scope,
      downstream_repo_id: repoId,
    }).map((projection) => DependencyObligationV2.parse(
      JSON.parse(projection.snapshot_json),
    ));
  } finally {
    database.close();
  }
  const json = args.includes("--json") || option(args, "--format") === "json";
  if (json) {
    deps.stdout(JSON.stringify({
      registry_scope: registry.scope,
      repo_id: repoId,
      obligations,
    }, null, 2));
  } else {
    deps.stdout([
      `Dependency inbox for ${repoId}: ${obligations.length} open`,
      ...obligations.map((obligation) =>
        `${obligation.obligation_id}  ${obligation.state}  ${obligation.upstream_repo_id}  ${obligation.kinds.join(",")}`
      ),
    ].join("\n"));
  }
  return 0;
}

function positiveRevision(args: readonly string[]): number {
  const value = required(args, "--if-revision");
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new NeatDependencyUsageError("--if-revision must be a positive integer");
  }
  return Number.parseInt(value, 10);
}

async function validatedDownstreamRepo(
  database: ReturnType<typeof openDb>,
  registryScope: string,
  downstreamRepoId: string,
  rawRepo: string,
  cwd: string,
): Promise<string> {
  const registryPath = getDependencyRegistryPathV2(database, registryScope);
  if (registryPath === undefined) {
    throw new NeatDependencyUsageError(
      "registry scope is unknown; rerun dependencies scan --record",
    );
  }
  const entry = (await readRepoRegistry(registryPath)).find((candidate) =>
    candidate.enabled && candidate.repo_id === downstreamRepoId
  );
  if (entry === undefined) {
    throw new NeatDependencyUsageError(
      `downstream repo is not enabled in recorded registry: ${downstreamRepoId}`,
    );
  }
  const registered = await realpath(
    isAbsolute(entry.path) ? entry.path : resolve(dirname(registryPath), entry.path),
  );
  const requested = await realpath(resolve(cwd, rawRepo));
  if (registered !== requested) {
    throw new NeatDependencyUsageError(
      "--repo realpath does not match the downstream registry entry",
    );
  }
  return requested;
}

async function configSnapshot(repo: string): Promise<{
  path: string;
  content: string;
  mode: number;
}> {
  const path = ".osstack/neat.yaml";
  const absolute = join(repo, ".osstack", "neat.yaml");
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) {
    throw new NeatDependencyUsageError("downstream .osstack/neat.yaml is unsafe or oversized");
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return {
      path,
      content: await handle.readFile("utf8"),
      mode: metadata.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function appendEdgeState(
  database: ReturnType<typeof openDb>,
  input: {
    edge: DeclaredDependencyV2;
    registry_scope: string;
    downstream_repo_id: string;
    source_config_sha256: string;
    to_state: "confirmed" | "review_due" | "revoked";
    actor: string;
    reason: string;
    occurred_at: string;
  },
): Promise<boolean> {
  const projection = getDeclaredDependencyEdgeProjectionV2(database, input.edge.edge_id);
  if (
    projection?.state === input.to_state
    && projection.source_config_sha256 === input.source_config_sha256
    && projection.edge_json === JSON.stringify(input.edge)
  ) {
    return false;
  }
  const body = {
    schema_version: "2" as const,
    edge_id: input.edge.edge_id,
    registry_scope: input.registry_scope,
    downstream_repo_id: input.downstream_repo_id,
    revision: (projection?.revision ?? 0) + 1,
    from_state: projection?.state ?? null,
    to_state: input.to_state,
    source_config_sha256: input.source_config_sha256,
    edge_json: JSON.stringify(input.edge),
    actor: input.actor,
    reason: input.reason,
    occurred_at: input.occurred_at,
  };
  appendDeclaredDependencyEdgeEventV2(database, {
    ...body,
    event_id: edgeEventId(body),
  });
  return true;
}

async function reconcileRegistryConfig(
  database: ReturnType<typeof openDb>,
  registryScope: string,
  repositories: readonly { repo_id: string; root_realpath: string }[],
  now: Date,
): Promise<number> {
  let reconciled = 0;
  for (const repository of repositories) {
    let snapshot: Awaited<ReturnType<typeof configSnapshot>>;
    try {
      snapshot = await configSnapshot(repository.root_realpath);
    } catch {
      continue;
    }
    const config = parseKnowledgeHygieneConfigV2(snapshot.content);
    const configSha = digest(snapshot.content);
    const declared = new Set(config.dependencies.map((edge) => edge.edge_id));
    for (const edge of config.dependencies) {
      const expectedEdgeId = createDeclaredDependencyEdgeIdV2({
        registry_scope: registryScope,
        upstream_repo_id: edge.upstream_repo_id,
        downstream_repo_id: repository.repo_id,
        kinds: edge.kinds,
      });
      if (expectedEdgeId !== edge.edge_id) {
        throw new NeatDependencyUsageError(
          `declared edge identity does not match registry scope: ${edge.edge_id}`,
        );
      }
      let projection = getDeclaredDependencyEdgeProjectionV2(database, edge.edge_id);
      if (projection === undefined || projection.state === "revoked") {
        if (await appendEdgeState(database, {
          edge,
          registry_scope: registryScope,
          downstream_repo_id: repository.repo_id,
          source_config_sha256: configSha,
          to_state: "confirmed",
          actor: "system:config-reconciliation",
          reason: "Rebuilt declared dependency projection from authoritative ConfigV2.",
          occurred_at: now.toISOString(),
        })) reconciled += 1;
        projection = getDeclaredDependencyEdgeProjectionV2(database, edge.edge_id);
      }
      const desired = Date.parse(edge.review_after) <= now.getTime()
        ? "review_due" as const
        : "confirmed" as const;
      if (
        projection?.state !== desired
        || projection.source_config_sha256 !== configSha
        || projection.edge_json !== JSON.stringify(edge)
      ) {
        if (await appendEdgeState(database, {
          edge,
          registry_scope: registryScope,
          downstream_repo_id: repository.repo_id,
          source_config_sha256: configSha,
          to_state: desired,
          actor: "system:config-reconciliation",
          reason: desired === "review_due"
            ? "Declared dependency review date elapsed."
            : "Reconciled declared dependency projection from authoritative ConfigV2.",
          occurred_at: now.toISOString(),
        })) reconciled += 1;
      }
    }
    for (const projection of listDeclaredDependencyEdgeProjectionsV2(database, {
      registry_scope: registryScope,
      downstream_repo_id: repository.repo_id,
    })) {
      if (declared.has(projection.edge_id) || projection.state === "revoked") continue;
      if (await appendEdgeState(database, {
        edge: JSON.parse(projection.edge_json) as DeclaredDependencyV2,
        registry_scope: registryScope,
        downstream_repo_id: repository.repo_id,
        source_config_sha256: configSha,
        to_state: "revoked",
        actor: "system:config-reconciliation",
        reason: "Authoritative ConfigV2 no longer declares this dependency.",
        occurred_at: now.toISOString(),
      })) reconciled += 1;
    }
  }
  return reconciled;
}

function renderDependencies(
  source: string,
  dependencies: DeclaredDependencyV2[],
): string {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new NeatDependencyUsageError(
      `invalid downstream config YAML: ${document.errors[0]!.message}`,
    );
  }
  document.set("dependencies", dependencies);
  const rendered = String(document);
  parseKnowledgeHygieneConfigV2(rendered);
  return rendered;
}

async function persistObligationTransition(
  database: ReturnType<typeof openDb>,
  previous: DependencyObligation,
  next: DependencyObligation,
  actor: string,
  reason: string,
  occurredAt: string,
): Promise<void> {
  const body = {
    schema_version: "2" as const,
    obligation_id: next.obligation_id,
    registry_scope: next.registry_scope,
    downstream_repo_id: next.downstream_repo_id,
    revision: next.revision,
    from_state: previous.state,
    to_state: next.state,
    snapshot_json: JSON.stringify(next),
    actor,
    reason,
    occurred_at: occurredAt,
  };
  appendDependencyObligationEventV2(database, {
    ...body,
    event_id: eventId(body),
  });
}

async function persistConfirmedEdge(
  database: ReturnType<typeof openDb>,
  input: {
    edge: DeclaredDependencyV2;
    registry_scope: string;
    downstream_repo_id: string;
    config_sha256: string;
    actor: string;
    reason: string;
    occurred_at: string;
  },
): Promise<void> {
  await appendEdgeState(database, {
    edge: input.edge,
    registry_scope: input.registry_scope,
    downstream_repo_id: input.downstream_repo_id,
    source_config_sha256: input.config_sha256,
    to_state: "confirmed",
    actor: input.actor,
    reason: input.reason,
    occurred_at: input.occurred_at,
  });
}

async function buildConfigPlan(input: {
  repo: string;
  repo_id: string;
  entity_revision: number;
  before: Awaited<ReturnType<typeof configSnapshot>>;
  after: string;
  evidence_refs: DependencyObligation["evidence_refs"];
  now: Date;
}) {
  const git = await gitIdentity(input.repo);
  const endLine = input.before.content.split(/\r?\n/).length
    - (input.before.content.endsWith("\n") ? 1 : 0);
  return buildKnowledgeHygieneTransactionPlanV1({
    kind: "dependency",
    revision: input.entity_revision,
    created_at: input.now.toISOString(),
    expires_at: new Date(input.now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    repo: {
      repo_id: input.repo_id,
      root_realpath: input.repo,
      base_revision: git.base_revision,
      fingerprint: git.fingerprint,
    },
    snapshots: [{
      root_id: "repo",
      path: input.before.path,
      content_utf8: input.before.content,
      mode: input.before.mode,
    }],
    drafts: [{
      kind: "compress",
      sources: [{
        root_id: "repo",
        path: input.before.path,
        start_line: 1,
        end_line: endLine,
      }],
      target: {
        root_id: "repo",
        path: input.before.path,
        placement: "replace",
        purpose: "governance_config",
      },
      replacement_utf8: input.after,
    }],
    evidence_refs: input.evidence_refs,
  });
}

async function ensureDraftRecorded(
  deps: NeatDependencyCommandDependencies,
  home: string,
  stored: Awaited<ReturnType<typeof savePlan>>,
  actor: string,
  reason: string,
): Promise<void> {
  const database = stateDatabase(deps, home);
  let projection: ReturnType<typeof getKnowledgeHygienePlanProjectionV1>;
  try {
    projection = getKnowledgeHygienePlanProjectionV1(database, stored.plan.plan_id);
  } finally {
    database.close();
  }
  if (projection === undefined) {
    await recordTransactionEvent(deps, home, stored, actor, reason);
  }
}

async function executeConfigPlan(
  deps: NeatDependencyCommandDependencies,
  home: string,
  plan: Awaited<ReturnType<typeof buildConfigPlan>>,
  actor: string,
  reason: string,
): Promise<string> {
  requireTty(deps, "dependencies --execute");
  if (process.env["OSSTACK_NEAT_APPLY_DISABLED"] === "1") {
    throw new NeatDependencyUsageError(
      "dependency apply is disabled by OSSTACK_NEAT_APPLY_DISABLED=1",
    );
  }
  let stored = await savePlan(home, plan);
  await ensureDraftRecorded(
    deps,
    home,
    stored,
    actor,
    "Created dependency config plan.",
  );
  const approved = approveKnowledgeHygieneTransactionPlanV1(plan, {
    action_ids: [plan.actions[0]!.action_id],
    actor,
    reason,
    if_revision: plan.revision,
    local_user_id: (deps.local_user_id ?? (() => String(userInfo().uid)))(),
    tty_consented_at: (deps.now ?? (() => new Date()))().toISOString(),
  });
  stored = await savePlan(home, approved);
  await recordTransactionEvent(deps, home, stored, actor, reason);
  try {
    await assertRootFingerprints(approved);
  } catch (error) {
    const stale = KnowledgeHygieneTransactionPlanV1.parse({
      ...approved,
      state: "stale",
    });
    stored = await savePlan(home, stale);
    await recordTransactionEvent(
      deps,
      home,
      stored,
      actor,
      "Dependency config changed after planning.",
    );
    throw error;
  }
  const applying = { ...approved, state: "applying" as const };
  stored = await savePlan(home, applying);
  await recordTransactionEvent(deps, home, stored, actor, "Started dependency config apply.");
  let result: Awaited<ReturnType<typeof applyKnowledgeHygieneTransactionPlanV1>>;
  try {
    result = await applyKnowledgeHygieneTransactionPlanV1(approved, {
      state_root: join(home, "neat"),
      execute: true,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.apply_hooks === undefined ? {} : { hooks: deps.apply_hooks }),
    });
  } catch (error) {
    if (
      error instanceof KnowledgeHygieneSimulatedCrashV1
      || (error instanceof KnowledgeHygieneTransactionErrorV1
        && error.code === "recovery_required")
    ) {
      const recoveryRequired = KnowledgeHygieneTransactionPlanV1.parse({
        ...approved,
        state: "recovery_required",
      });
      stored = await savePlan(home, recoveryRequired);
      await recordTransactionEvent(
        deps,
        home,
        stored,
        actor,
        "Dependency config apply requires recovery.",
      );
    } else if (
      error instanceof KnowledgeHygieneTransactionErrorV1
      && error.code === "apply_failed_recovered"
    ) {
      const recoveryRequired = KnowledgeHygieneTransactionPlanV1.parse({
        ...approved,
        state: "recovery_required",
      });
      stored = await savePlan(home, recoveryRequired);
      await recordTransactionEvent(
        deps,
        home,
        stored,
        actor,
        "Dependency config apply failed and was automatically recovered.",
      );
      const recovered = KnowledgeHygieneTransactionPlanV1.parse({
        ...recoveryRequired,
        state: "recovered",
      });
      stored = await savePlan(home, recovered);
      await recordTransactionEvent(
        deps,
        home,
        stored,
        actor,
        "Recorded automatic dependency config recovery.",
      );
    } else {
      const cancelled = KnowledgeHygieneTransactionPlanV1.parse({
        ...approved,
        state: "cancelled",
      });
      stored = await savePlan(home, cancelled);
      await recordTransactionEvent(
        deps,
        home,
        stored,
        actor,
        "Dependency config apply stopped before a recoverable journal existed.",
      );
    }
    throw error;
  }
  stored = await savePlan(home, result.plan);
  await recordTransactionEvent(deps, home, stored, actor, "Applied dependency config.");
  return result.plan.write_set[0]!.after_utf8;
}

async function recover(
  args: readonly string[],
  deps: NeatDependencyCommandDependencies,
): Promise<number> {
  validateOptions(args, new Set(["--plan"]), new Set(["--json"]));
  const home = (deps.home ?? osstackHome)();
  let stored = await loadPlan(home, required(args, "--plan"));
  if (stored.plan.kind !== "dependency") {
    throw new NeatDependencyUsageError(
      `plan kind is ${stored.plan.kind}; expected dependency`,
    );
  }
  let recoverable = stored.plan;
  if (recoverable.state === "applying") {
    recoverable = KnowledgeHygieneTransactionPlanV1.parse({
      ...recoverable,
      state: "recovery_required",
    });
    stored = await savePlan(home, recoverable);
    await recordTransactionEvent(
      deps,
      home,
      stored,
      "system",
      "Detected interrupted dependency apply.",
    );
  }
  const result = await recoverKnowledgeHygieneTransactionPlanV1(recoverable, {
    state_root: join(home, "neat"),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.apply_hooks === undefined ? {} : { hooks: deps.apply_hooks }),
  });
  stored = await savePlan(home, result.plan);
  await recordTransactionEvent(
    deps,
    home,
    stored,
    "system",
    "Recovered dependency config transaction.",
  );
  deps.stdout(JSON.stringify({
    plan_id: result.plan.plan_id,
    state: result.plan.state,
    receipt: result.receipt,
  }, null, 2));
  return 0;
}

function transactionMode(args: readonly string[]): "dry_run" | "execute" {
  if (args.includes("--dry-run") && args.includes("--execute")) {
    throw new NeatDependencyUsageError("--dry-run and --execute are mutually exclusive");
  }
  return args.includes("--execute") ? "execute" : "dry_run";
}

async function confirm(
  args: readonly string[],
  deps: NeatDependencyCommandDependencies,
): Promise<number> {
  validateOptions(
    args,
    new Set(["--obligation", "--repo", "--actor", "--reason", "--if-revision"]),
    new Set(["--dry-run", "--execute", "--json"]),
  );
  const obligationId = required(args, "--obligation");
  const actor = required(args, "--actor");
  const reason = option(args, "--reason")
    ?? "Confirmed cross-repository dependency evidence.";
  const revision = positiveRevision(args);
  const mode = transactionMode(args);
  const home = (deps.home ?? osstackHome)();
  await mkdir(home, { recursive: true, mode: 0o700 });
  let database = stateDatabase(deps, home);
  const projection = getDependencyObligationProjectionV2(database, obligationId);
  if (projection === undefined) {
    database.close();
    throw new NeatDependencyUsageError(`obligation not found: ${obligationId}`);
  }
  const obligation = DependencyObligationV2.parse(
    JSON.parse(projection.snapshot_json),
  );
  if (revision !== obligation.revision) {
    database.close();
    throw new NeatDependencyUsageError(
      `obligation revision conflict: expected ${obligation.revision}, received ${revision}`,
    );
  }
  if (!new Set(["advisory", "promoted"]).has(obligation.state)) {
    database.close();
    throw new NeatDependencyUsageError(
      obligation.state === "candidate"
        ? "candidate requires a citation-verified advisory verdict; rerun scan --record --judge"
        : `obligation cannot be confirmed from ${obligation.state}`,
    );
  }
  const repo = await validatedDownstreamRepo(
    database,
    obligation.registry_scope,
    obligation.downstream_repo_id,
    required(args, "--repo"),
    deps.cwd(),
  );
  database.close();
  const edgeId = createDeclaredDependencyEdgeIdV2({
    registry_scope: obligation.registry_scope,
    upstream_repo_id: obligation.upstream_repo_id,
    downstream_repo_id: obligation.downstream_repo_id,
    kinds: obligation.kinds,
  });
  const now = (deps.now ?? (() => new Date()))();
  const edge: DeclaredDependencyV2 = {
    edge_id: edgeId,
    upstream_repo_id: obligation.upstream_repo_id,
    direction: "depends_on",
    kinds: [...obligation.kinds],
    owner: actor,
    evidence_refs: [{
      kind: "obligation",
      ref: obligation.obligation_id,
      sha256: obligation.registry_scope,
    }],
    confirmed_at: now.toISOString(),
    review_after: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const before = await configSnapshot(repo);
  const config = parseKnowledgeHygieneConfigV2(before.content);
  const existing = config.dependencies.find((candidate) => candidate.edge_id === edgeId);
  const dependencies = existing === undefined
    ? [...config.dependencies, edge].sort((left, right) =>
        left.edge_id.localeCompare(right.edge_id)
      )
    : config.dependencies;
  const after = renderDependencies(before.content, dependencies);
  const plan = await buildConfigPlan({
    repo,
    repo_id: obligation.downstream_repo_id,
    entity_revision: obligation.revision,
    before,
    after,
    evidence_refs: [{
      kind: "obligation",
      ref: obligation.obligation_id,
      sha256: obligation.registry_scope,
    }],
    now,
  });
  if (mode === "dry_run") {
    const stored = await savePlan(home, plan);
    await ensureDraftRecorded(
      deps,
      home,
      stored,
      actor,
      "Created dependency confirmation preview.",
    );
    deps.stdout(JSON.stringify({
      mode,
      obligation_id: obligation.obligation_id,
      edge,
      plan_id: plan.plan_id,
      artifact_path: stored.artifact_path,
      write_set: plan.write_set,
    }, null, 2));
    return 0;
  }
  const appliedConfig = existing === undefined
    ? await executeConfigPlan(deps, home, plan, actor, reason)
    : before.content;
  const verified = parseKnowledgeHygieneConfigV2(appliedConfig);
  const verifiedEdge = verified.dependencies.find((candidate) =>
    candidate.edge_id === edgeId
  );
  if (verifiedEdge === undefined) {
    throw new Error("declared dependency is absent after approved config apply");
  }
  await deps.after_config_apply_before_core?.();

  database = stateDatabase(deps, home);
  try {
    await persistConfirmedEdge(database, {
      edge: verifiedEdge,
      registry_scope: obligation.registry_scope,
      downstream_repo_id: obligation.downstream_repo_id,
      config_sha256: digest(appliedConfig),
      actor,
      reason,
      occurred_at: now.toISOString(),
    });
    let current = DependencyObligationV2.parse(
      JSON.parse(
        getDependencyObligationProjectionV2(database, obligation.obligation_id)
          ?.snapshot_json ?? projection.snapshot_json,
      ),
    );
    if (current.state === "advisory") {
      const promoted = transitionDependencyObligationV2(current, {
        to_state: "promoted",
        actor,
        reason,
        if_revision: current.revision,
        occurred_at: now.toISOString(),
        promoted_edge_id: edgeId,
      });
      await persistObligationTransition(
        database,
        current,
        promoted,
        actor,
        reason,
        now.toISOString(),
      );
      current = promoted;
    }
    deps.stdout(JSON.stringify({
      mode,
      obligation_id: obligation.obligation_id,
      obligation_state: current.state,
      edge: verifiedEdge,
      config_sha256: digest(appliedConfig),
    }, null, 2));
  } finally {
    database.close();
  }
  return 0;
}

async function revoke(
  args: readonly string[],
  deps: NeatDependencyCommandDependencies,
): Promise<number> {
  validateOptions(
    args,
    new Set(["--edge", "--repo", "--actor", "--reason", "--if-revision"]),
    new Set(["--dry-run", "--execute", "--json"]),
  );
  const edgeId = required(args, "--edge");
  const actor = required(args, "--actor");
  const reason = option(args, "--reason") ?? "Revoked declared dependency.";
  const revision = positiveRevision(args);
  const mode = transactionMode(args);
  const home = (deps.home ?? osstackHome)();
  await mkdir(home, { recursive: true, mode: 0o700 });
  let database = stateDatabase(deps, home);
  const projection = getDeclaredDependencyEdgeProjectionV2(database, edgeId);
  if (projection === undefined) {
    database.close();
    throw new NeatDependencyUsageError(`declared edge not found: ${edgeId}`);
  }
  if (projection.revision !== revision) {
    database.close();
    throw new NeatDependencyUsageError(
      `edge revision conflict: expected ${projection.revision}, received ${revision}`,
    );
  }
  const repo = await validatedDownstreamRepo(
    database,
    projection.registry_scope,
    projection.downstream_repo_id,
    required(args, "--repo"),
    deps.cwd(),
  );
  database.close();
  const before = await configSnapshot(repo);
  const config = parseKnowledgeHygieneConfigV2(before.content);
  const edge = config.dependencies.find((candidate) => candidate.edge_id === edgeId)
    ?? JSON.parse(projection.edge_json) as DeclaredDependencyV2;
  const after = renderDependencies(
    before.content,
    config.dependencies.filter((candidate) => candidate.edge_id !== edgeId),
  );
  const now = (deps.now ?? (() => new Date()))();
  const plan = await buildConfigPlan({
    repo,
    repo_id: projection.downstream_repo_id,
    entity_revision: projection.revision,
    before,
    after,
    evidence_refs: edge.evidence_refs,
    now,
  });
  if (mode === "dry_run") {
    const stored = await savePlan(home, plan);
    await ensureDraftRecorded(
      deps,
      home,
      stored,
      actor,
      "Created dependency revocation preview.",
    );
    deps.stdout(JSON.stringify({
      mode,
      edge_id: edgeId,
      plan_id: plan.plan_id,
      artifact_path: stored.artifact_path,
      write_set: plan.write_set,
    }, null, 2));
    return 0;
  }
  const appliedConfig = config.dependencies.some((candidate) =>
      candidate.edge_id === edgeId
    )
    ? await executeConfigPlan(deps, home, plan, actor, reason)
    : before.content;
  if (
    parseKnowledgeHygieneConfigV2(appliedConfig).dependencies.some((candidate) =>
      candidate.edge_id === edgeId
    )
  ) {
    throw new Error("declared dependency remains after approved revocation");
  }
  database = stateDatabase(deps, home);
  try {
    await appendEdgeState(database, {
      edge,
      registry_scope: projection.registry_scope,
      downstream_repo_id: projection.downstream_repo_id,
      source_config_sha256: digest(appliedConfig),
      to_state: "revoked",
      actor,
      reason,
      occurred_at: now.toISOString(),
    });
  } finally {
    database.close();
  }
  deps.stdout(JSON.stringify({
    mode,
    edge_id: edgeId,
    state: "revoked",
    config_sha256: digest(appliedConfig),
  }, null, 2));
  return 0;
}

export function renderNeatDependencyHelp(): string {
  return `osstack neat dependencies — cross-repository dependency obligations

Usage:
  osstack neat dependencies scan --registry <path> [--record] [--judge <id>] [--json]
  osstack neat dependencies inbox --registry <path> --repo-id <id> [--json]
  osstack neat dependencies confirm --obligation <id> --repo <path>
    --actor <id> --if-revision <n> [--dry-run | --execute]
  osstack neat dependencies revoke --edge <id> --repo <path>
    --actor <id> --if-revision <n> [--dry-run | --execute]
  osstack neat dependencies recover --plan <id>`;
}

export async function handleNeatDependencyCommand(
  args: readonly string[],
  deps: NeatDependencyCommandDependencies,
): Promise<number> {
  try {
    const command = args[0];
    if (command === undefined || command === "help" || command === "--help") {
      deps.stdout(renderNeatDependencyHelp());
      return 0;
    }
    if (command === "scan") return await scan(args.slice(1), deps);
    if (command === "inbox") return await inbox(args.slice(1), deps);
    if (command === "confirm") return await confirm(args.slice(1), deps);
    if (command === "revoke") return await revoke(args.slice(1), deps);
    if (command === "recover") return await recover(args.slice(1), deps);
    throw new NeatDependencyUsageError(`unknown dependencies command: ${command}`);
  } catch (error) {
    deps.stderr(
      `osstack neat dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
    return error instanceof NeatDependencyUsageError ? 2 : 3;
  }
}
