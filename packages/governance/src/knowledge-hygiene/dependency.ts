import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  redactSemanticEvidenceSourcesV1,
} from "./semantic-evidence.js";
import {
  SemanticDecisionV1,
  SemanticEvidencePackV1,
  SemanticJudgeRequestV1,
  invokeSemanticJudge,
  jsonSha256,
  type SemanticJudgeBudgetV1,
  type SemanticJudgePort,
  type SemanticJudgeResponseV1,
} from "./semantic-judge.js";
import { KnowledgeHygieneEvidenceRefV2 } from "./types-v2.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const candidateId = z.string().regex(/^khc_[a-f0-9]{64}$/);
const obligationId = z.string().regex(/^kho_[a-f0-9]{64}$/);
const edgeId = z.string().regex(/^khe_[a-f0-9]{64}$/);

export const KnowledgeHygieneDependencyKindV2 = z.enum([
  "api",
  "sdk",
  "env_name",
  "url",
  "symbol",
  "path",
]);
export type KnowledgeHygieneDependencyKindV2 = z.infer<
  typeof KnowledgeHygieneDependencyKindV2
>;

const dependencyKinds = z.array(KnowledgeHygieneDependencyKindV2).min(1)
  .superRefine((kinds, context) => {
    if (
      new Set(kinds).size !== kinds.length
      || kinds.some((kind, index) => index > 0 && kinds[index - 1]! >= kind)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dependency kinds must be unique and sorted",
      });
    }
  });

const candidateObject = z.object({
  candidate_id: candidateId,
  registry_scope: sha256,
  source_repo_id: z.string().min(1),
  upstream_repo_id: z.string().min(1),
  downstream_repo_id: z.string().min(1),
  kinds: dependencyKinds,
  evidence_refs: z.array(KnowledgeHygieneEvidenceRefV2).min(1),
}).strict();

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEvidence(
  evidenceRefs: readonly z.infer<typeof KnowledgeHygieneEvidenceRefV2>[],
) {
  return [...evidenceRefs].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function candidateIdentity(candidate: z.input<typeof candidateObject>): string {
  return `khc_${digest(JSON.stringify({
    registry_scope: candidate.registry_scope,
    source_repo_id: candidate.source_repo_id,
    upstream_repo_id: candidate.upstream_repo_id,
    downstream_repo_id: candidate.downstream_repo_id,
    kinds: candidate.kinds,
    evidence_refs: canonicalEvidence(candidate.evidence_refs),
  }))}`;
}

export const DependencyCandidateV2 = candidateObject.superRefine(
  (candidate, context) => {
    if (candidate.upstream_repo_id === candidate.downstream_repo_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["downstream_repo_id"],
        message: "dependency candidate cannot be a self-edge",
      });
    }
    if (candidate.candidate_id !== candidateIdentity(candidate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidate_id"],
        message: "candidate_id does not match candidate evidence identity",
      });
    }
  },
);
export type DependencyCandidateV2 = z.infer<typeof DependencyCandidateV2>;

export function createDependencyCandidateV2(
  input: Omit<z.input<typeof candidateObject>, "candidate_id">,
): DependencyCandidateV2 {
  const body = {
    ...input,
    kinds: [...input.kinds].sort(),
    evidence_refs: canonicalEvidence(input.evidence_refs),
  };
  return DependencyCandidateV2.parse({
    ...body,
    candidate_id: candidateIdentity({
      ...body,
      candidate_id: `khc_${"0".repeat(64)}`,
    }),
  });
}

const obligationObject = z.object({
  schema_version: z.literal("2"),
  obligation_id: obligationId,
  registry_scope: sha256,
  source_repo_id: z.string().min(1),
  upstream_repo_id: z.string().min(1),
  downstream_repo_id: z.string().min(1),
  kinds: dependencyKinds,
  state: z.enum(["candidate", "advisory", "promoted", "dismissed", "expired"]),
  revision: z.number().int().positive(),
  evidence_refs: z.array(KnowledgeHygieneEvidenceRefV2).min(1),
  rationale: z.string().trim().min(1).optional(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  promoted_edge_id: edgeId.optional(),
});

function obligationIdentity(obligation: z.input<typeof obligationObject>): string {
  const identityEvidence = obligation.evidence_refs.filter((reference) =>
    reference.kind !== "evidence_pack"
  );
  return `kho_${digest(JSON.stringify({
    registry_scope: obligation.registry_scope,
    source_repo_id: obligation.source_repo_id,
    upstream_repo_id: obligation.upstream_repo_id,
    downstream_repo_id: obligation.downstream_repo_id,
    kinds: obligation.kinds,
    evidence_refs: canonicalEvidence(identityEvidence),
  }))}`;
}

export const DependencyObligationV2 = obligationObject.strict().superRefine(
  (obligation, context) => {
    if (Date.parse(obligation.expires_at) <= Date.parse(obligation.created_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "obligation expiry must follow creation",
      });
    }
    if (
      (obligation.state === "promoted")
      !== (obligation.promoted_edge_id !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["promoted_edge_id"],
        message: "only promoted obligations require promoted_edge_id",
      });
    }
    if (obligation.state === "advisory" && obligation.rationale === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rationale"],
        message: "advisory obligation requires an evidence-bound rationale",
      });
    }
    if (obligation.obligation_id !== obligationIdentity(obligation)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["obligation_id"],
        message: "obligation_id does not match immutable evidence identity",
      });
    }
  },
);
export type DependencyObligationV2 = z.infer<typeof DependencyObligationV2>;

export function createDependencyObligationV2(
  rawCandidate: DependencyCandidateV2,
  input: { created_at: string; expires_at: string },
): DependencyObligationV2 {
  const candidate = DependencyCandidateV2.parse(rawCandidate);
  const body = {
    schema_version: "2" as const,
    registry_scope: candidate.registry_scope,
    source_repo_id: candidate.source_repo_id,
    upstream_repo_id: candidate.upstream_repo_id,
    downstream_repo_id: candidate.downstream_repo_id,
    kinds: candidate.kinds,
    state: "candidate" as const,
    revision: 1,
    evidence_refs: candidate.evidence_refs,
    created_at: input.created_at,
    expires_at: input.expires_at,
  };
  return DependencyObligationV2.parse({
    ...body,
    obligation_id: obligationIdentity({
      ...body,
      obligation_id: `kho_${"0".repeat(64)}`,
    }),
  });
}

export interface DependencyObligationTransitionV2 {
  to_state: "advisory" | "promoted" | "dismissed" | "expired";
  actor: string;
  reason: string;
  if_revision: number;
  occurred_at: string;
  rationale?: string;
  evidence_refs?: z.infer<typeof KnowledgeHygieneEvidenceRefV2>[];
  promoted_edge_id?: string;
}

export function transitionDependencyObligationV2(
  rawObligation: DependencyObligationV2,
  input: DependencyObligationTransitionV2,
): DependencyObligationV2 {
  const obligation = DependencyObligationV2.parse(rawObligation);
  if (input.if_revision !== obligation.revision) {
    throw new Error(
      `obligation revision conflict: expected ${obligation.revision}, received ${input.if_revision}`,
    );
  }
  const allowed = obligation.state === "candidate"
    ? new Set(["advisory", "dismissed", "expired"])
    : obligation.state === "advisory"
    ? new Set(["promoted", "dismissed", "expired"])
    : new Set<string>();
  if (!allowed.has(input.to_state)) {
    throw new Error(`obligation cannot transition ${obligation.state} -> ${input.to_state}`);
  }
  if (input.actor.trim().length === 0 || input.reason.trim().length === 0) {
    throw new Error("obligation transition requires actor and reason");
  }
  const evidenceRefs = input.evidence_refs === undefined
    ? obligation.evidence_refs
    : canonicalEvidence([...obligation.evidence_refs, ...input.evidence_refs]);
  return DependencyObligationV2.parse({
    ...obligation,
    state: input.to_state,
    revision: obligation.revision + 1,
    evidence_refs: evidenceRefs,
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    ...(input.promoted_edge_id === undefined
      ? {}
      : { promoted_edge_id: input.promoted_edge_id }),
  });
}

export function createDeclaredDependencyEdgeIdV2(input: {
  registry_scope: string;
  upstream_repo_id: string;
  downstream_repo_id: string;
  kinds: readonly KnowledgeHygieneDependencyKindV2[];
}): string {
  const registryScope = sha256.parse(input.registry_scope);
  const kinds = dependencyKinds.parse([...input.kinds].sort());
  return `khe_${digest(JSON.stringify({
    registry_scope: registryScope,
    upstream_repo_id: input.upstream_repo_id,
    downstream_repo_id: input.downstream_repo_id,
    direction: "depends_on",
    kinds,
  }))}`;
}

export interface DependencyScanRepositoryV2 {
  repo_id: string;
  root_realpath: string;
}

export interface DependencyScanResultV2 {
  schema_version: "2";
  registry_scope: string;
  repositories_scanned: number;
  files_scanned: number;
  files_skipped: number;
  candidates: DependencyCandidateV2[];
}

interface RepoSignals {
  repo_id: string;
  root: string;
  package_name?: string;
  package_dependencies: Map<string, z.infer<typeof KnowledgeHygieneEvidenceRefV2>>;
  env_names: Map<string, z.infer<typeof KnowledgeHygieneEvidenceRefV2>>;
  references: Map<string, {
    ref: z.infer<typeof KnowledgeHygieneEvidenceRefV2>;
    url: boolean;
  }>;
  url_hosts: Map<string, z.infer<typeof KnowledgeHygieneEvidenceRefV2>>;
  exported_symbols: Map<string, z.infer<typeof KnowledgeHygieneEvidenceRefV2>>;
  imported_symbols: Map<string, Map<string, z.infer<typeof KnowledgeHygieneEvidenceRefV2>>>;
}

const ALLOWED_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const MAX_REPOSITORIES = 100;
const MAX_FILES_PER_REPOSITORY = 2_000;
const MAX_FILE_BYTES = 1024 * 1024;

function portable(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function evidence(
  repoId: string,
  path: string,
  content: Buffer,
): z.infer<typeof KnowledgeHygieneEvidenceRefV2> {
  return {
    kind: "proof",
    ref: `${repoId}:${path}`,
    sha256: digest(content),
  };
}

async function readSafeFile(path: string): Promise<Buffer | undefined> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_FILE_BYTES) {
    return undefined;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_FILE_BYTES) {
      return undefined;
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function repoFiles(root: string): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".env" || entry.name.startsWith(".env.")) {
        skipped += 1;
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) skipped += 1;
        else queue.push(path);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      if (entry.name !== ".gitmodules" && !ALLOWED_EXTENSIONS.has(extname(entry.name))) {
        skipped += 1;
        continue;
      }
      if (files.length >= MAX_FILES_PER_REPOSITORY) {
        skipped += 1;
        continue;
      }
      files.push(path);
    }
  }
  return { files, skipped };
}

function packageSignals(
  content: string,
  ref: z.infer<typeof KnowledgeHygieneEvidenceRefV2>,
): Pick<RepoSignals, "package_name" | "package_dependencies"> {
  const dependencies = new Map<string, z.infer<typeof KnowledgeHygieneEvidenceRefV2>>();
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const packageName = typeof parsed["name"] === "string" ? parsed["name"] : undefined;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const values = parsed[field];
      if (typeof values !== "object" || values === null || Array.isArray(values)) continue;
      for (const name of Object.keys(values).sort()) dependencies.set(name, ref);
    }
    return {
      ...(packageName === undefined ? {} : { package_name: packageName }),
      package_dependencies: dependencies,
    };
  } catch {
    return { package_dependencies: dependencies };
  }
}

async function collectSignals(
  repo: DependencyScanRepositoryV2,
  allRepoIds: readonly string[],
): Promise<{ signals: RepoSignals; files: number; skipped: number }> {
  const root = await realpath(repo.root_realpath);
  if (root !== repo.root_realpath) throw new Error(`registry realpath changed: ${repo.repo_id}`);
  const { files, skipped: initialSkipped } = await repoFiles(root);
  const signals: RepoSignals = {
    repo_id: repo.repo_id,
    root,
    package_dependencies: new Map(),
    env_names: new Map(),
    references: new Map(),
    url_hosts: new Map(),
    exported_symbols: new Map(),
    imported_symbols: new Map(),
  };
  let scanned = 0;
  let skipped = initialSkipped;
  for (const path of files) {
    const buffer = await readSafeFile(path);
    if (buffer === undefined) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const portablePath = portable(root, path);
    const ref = evidence(repo.repo_id, portablePath, buffer);
    const content = buffer.toString("utf8");
    if (portablePath === "package.json") {
      const packageData = packageSignals(content, ref);
      if (packageData.package_name !== undefined) {
        signals.package_name = packageData.package_name;
      }
      packageData.package_dependencies.forEach((value, key) => {
        signals.package_dependencies.set(key, value);
      });
    }
    for (const match of content.matchAll(
      /(?:process\.env\.|import\.meta\.env\.|Deno\.env\.get\(["'])([A-Z][A-Z0-9_]*)/gu,
    )) {
      if (match[1] !== undefined) signals.env_names.set(match[1], ref);
    }
    for (const match of content.matchAll(/https?:\/\/([a-z0-9.-]+)(?::[0-9]+)?(?:[/?#]|$)/giu)) {
      const host = match[1]?.toLowerCase();
      if (host !== undefined) signals.url_hosts.set(host, ref);
    }
    for (const match of content.matchAll(
      /\bexport\s+(?:async\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu,
    )) {
      if (match[1] !== undefined) signals.exported_symbols.set(match[1], ref);
    }
    for (const match of content.matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu,
    )) {
      const moduleName = match[2];
      if (moduleName === undefined) continue;
      const symbols = signals.imported_symbols.get(moduleName) ?? new Map();
      for (const imported of (match[1] ?? "").split(",")) {
        const name = imported.trim().split(/\s+as\s+/u)[0];
        if (name !== undefined && /^[A-Za-z_$][\w$]*$/u.test(name)) {
          symbols.set(name, ref);
        }
      }
      signals.imported_symbols.set(moduleName, symbols);
    }
    for (const otherRepoId of allRepoIds) {
      if (otherRepoId !== repo.repo_id && content.includes(otherRepoId)) {
        signals.references.set(otherRepoId, {
          ref,
          url: new RegExp(`https?:\\/\\/[^\\s"']*${otherRepoId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "iu")
            .test(content),
        });
      }
    }
  }
  return { signals, files: scanned, skipped };
}

export async function scanKnowledgeHygieneDependencyCandidatesV2(input: {
  registry_scope: string;
  repositories: DependencyScanRepositoryV2[];
}): Promise<DependencyScanResultV2> {
  const registryScope = sha256.parse(input.registry_scope);
  const roots = input.repositories.map((repo) => repo.root_realpath);
  if (
    input.repositories.length === 0
    || input.repositories.length > MAX_REPOSITORIES
    || new Set(input.repositories.map((repo) => repo.repo_id)).size
      !== input.repositories.length
    || new Set(roots).size !== roots.length
  ) {
    throw new Error("dependency scan requires 1-100 uniquely identified repositories");
  }
  const repoIds = input.repositories.map((repo) => repo.repo_id).sort();
  const collected = [];
  for (const repo of [...input.repositories].sort((left, right) =>
    left.repo_id.localeCompare(right.repo_id)
  )) {
    collected.push(await collectSignals(repo, repoIds));
  }
  const byPackageName = new Map(collected.flatMap(({ signals }) =>
    signals.package_name === undefined ? [] : [[signals.package_name, signals] as const]
  ));
  const candidates = new Map<string, {
    upstream: string;
    downstream: string;
    kinds: Set<KnowledgeHygieneDependencyKindV2>;
    evidence: Map<string, z.infer<typeof KnowledgeHygieneEvidenceRefV2>>;
  }>();
  const add = (
    upstream: string,
    downstream: string,
    kind: KnowledgeHygieneDependencyKindV2,
    refs: readonly z.infer<typeof KnowledgeHygieneEvidenceRefV2>[],
  ) => {
    const key = `${upstream}\0${downstream}`;
    const entry = candidates.get(key) ?? {
      upstream,
      downstream,
      kinds: new Set(),
      evidence: new Map(),
    };
    entry.kinds.add(kind);
    refs.forEach((ref) => {
      entry.evidence.set(JSON.stringify(ref), ref);
    });
    candidates.set(key, entry);
  };
  for (const { signals } of collected) {
    signals.package_dependencies.forEach((ref, name) => {
      const upstream = byPackageName.get(name);
      if (upstream !== undefined && upstream.repo_id !== signals.repo_id) {
        add(upstream.repo_id, signals.repo_id, "sdk", [ref]);
        const imports = signals.imported_symbols.get(name);
        if (imports !== undefined) {
          for (const [symbol, importRef] of imports) {
            const exportRef = upstream.exported_symbols.get(symbol);
            if (exportRef !== undefined) {
              add(upstream.repo_id, signals.repo_id, "symbol", [importRef, exportRef]);
            }
          }
        }
      }
    });
    signals.references.forEach((reference, upstreamRepoId) => {
      add(upstreamRepoId, signals.repo_id, "path", [reference.ref]);
      if (reference.url) add(upstreamRepoId, signals.repo_id, "url", [reference.ref]);
    });
  }
  for (let leftIndex = 0; leftIndex < collected.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < collected.length; rightIndex += 1) {
      const left = collected[leftIndex]!.signals;
      const right = collected[rightIndex]!.signals;
      for (const [name, leftRef] of left.env_names) {
        const rightRef = right.env_names.get(name);
        if (rightRef === undefined) continue;
        const forward = candidates.get(`${left.repo_id}\0${right.repo_id}`);
        const reverse = candidates.get(`${right.repo_id}\0${left.repo_id}`);
        if (forward !== undefined) add(left.repo_id, right.repo_id, "env_name", [leftRef, rightRef]);
        else if (reverse !== undefined) add(right.repo_id, left.repo_id, "env_name", [leftRef, rightRef]);
        else add(left.repo_id, right.repo_id, "env_name", [leftRef, rightRef]);
      }
      for (const [host, leftRef] of left.url_hosts) {
        const rightRef = right.url_hosts.get(host);
        if (rightRef === undefined) continue;
        const forward = candidates.get(`${left.repo_id}\0${right.repo_id}`);
        const reverse = candidates.get(`${right.repo_id}\0${left.repo_id}`);
        if (forward !== undefined) add(left.repo_id, right.repo_id, "url", [leftRef, rightRef]);
        else if (reverse !== undefined) add(right.repo_id, left.repo_id, "url", [leftRef, rightRef]);
      }
    }
  }
  return {
    schema_version: "2",
    registry_scope: registryScope,
    repositories_scanned: collected.length,
    files_scanned: collected.reduce((sum, item) => sum + item.files, 0),
    files_skipped: collected.reduce((sum, item) => sum + item.skipped, 0),
    candidates: [...candidates.values()]
      .sort((left, right) =>
        left.upstream.localeCompare(right.upstream)
        || left.downstream.localeCompare(right.downstream)
      )
      .map((candidate) => createDependencyCandidateV2({
        registry_scope: registryScope,
        source_repo_id: candidate.downstream,
        upstream_repo_id: candidate.upstream,
        downstream_repo_id: candidate.downstream,
        kinds: [...candidate.kinds],
        evidence_refs: [...candidate.evidence.values()],
      })),
  };
}

const dependencyDecisionSchema = zodToJsonSchema(SemanticDecisionV1, {
  target: "jsonSchema7",
  $refStrategy: "none",
}) as Record<string, unknown>;
const dependencyDecisionSchemaSha = jsonSha256(dependencyDecisionSchema);

function dependencyExcerpt(content: string): {
  start_line: number;
  end_line: number;
  text: string;
} | undefined {
  const lines = content.split(/\r?\n/u);
  const selected: string[] = [];
  let endLine = 0;
  for (let index = 0; index < lines.length && index < 120; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    const next = [...selected, line].join("\n");
    if (Buffer.byteLength(next, "utf8") > 8 * 1024) break;
    selected.push(line);
    endLine = index + 1;
  }
  return selected.length === 0
    ? undefined
    : { start_line: 1, end_line: endLine, text: selected.join("\n") };
}

function insideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

export interface DependencyAdvisoryJudgeResultV2 {
  decision: z.infer<typeof SemanticDecisionV1>;
  evidence_pack: z.infer<typeof SemanticEvidencePackV1>;
  response: SemanticJudgeResponseV1;
}

export async function judgeDependencyCandidateV2(input: {
  candidate: DependencyCandidateV2;
  repositories: DependencyScanRepositoryV2[];
  run_id: string;
  budget: SemanticJudgeBudgetV1;
}, port: SemanticJudgePort, signal: AbortSignal = new AbortController().signal): Promise<DependencyAdvisoryJudgeResultV2> {
  const candidate = DependencyCandidateV2.parse(input.candidate);
  const repositories = new Map(input.repositories.map((repo) => [repo.repo_id, repo]));
  const rawSources: z.input<typeof SemanticEvidencePackV1>["sources"] = [];
  for (const reference of candidate.evidence_refs) {
    if (reference.kind !== "proof") continue;
    const repo = [...repositories.values()].find((entry) =>
      reference.ref.startsWith(`${entry.repo_id}:`)
    );
    if (repo === undefined) throw new Error(`unknown evidence repository: ${reference.ref}`);
    const portablePath = reference.ref.slice(repo.repo_id.length + 1);
    if (
      portablePath.length === 0
      || portablePath.startsWith("/")
      || portablePath.split("/").includes("..")
    ) {
      throw new Error(`unsafe dependency evidence path: ${reference.ref}`);
    }
    const root = await realpath(repo.root_realpath);
    const path = await realpath(join(root, portablePath));
    if (!insideRoot(root, path)) throw new Error(`dependency evidence escaped root: ${reference.ref}`);
    const content = await readSafeFile(path);
    if (content === undefined) throw new Error(`dependency evidence is unavailable: ${reference.ref}`);
    const blobSha = digest(content);
    if (reference.sha256 !== undefined && reference.sha256 !== blobSha) {
      throw new Error(`dependency evidence changed: ${reference.ref}`);
    }
    const selected = dependencyExcerpt(content.toString("utf8"));
    if (selected === undefined) continue;
    rawSources.push({
      source: {
        kind: "repository",
        repo_id: repo.repo_id,
        path: portablePath,
      },
      blob_sha256: blobSha,
      excerpts: [selected],
    });
  }
  if (rawSources.length === 0) throw new Error("dependency candidate has no readable evidence");
  const redacted = redactSemanticEvidenceSourcesV1(rawSources);
  const packBody = {
    pack_id: `khep_${digest(JSON.stringify([
      "cross_repository",
      candidate.candidate_id,
      redacted.sources,
    ]))}`,
    dimension: "cross_repository" as const,
    source_units_total: candidate.evidence_refs.length,
    candidate_generator: { id: "dependency-candidate-ranking", version: "1" },
    sources: redacted.sources,
    candidates: [{
      candidate_id: candidate.candidate_id,
      source_indexes: redacted.sources.map((_source, index) => index),
      subject: {
        upstream_repo_id: candidate.upstream_repo_id,
        downstream_repo_id: candidate.downstream_repo_id,
        kinds: candidate.kinds,
      },
    }],
    redaction_count: redacted.redaction_count,
    prompt_version: port.prompt_version,
    output_schema_sha256: dependencyDecisionSchemaSha,
    budget: input.budget,
  };
  const evidencePack = SemanticEvidencePackV1.parse({
    ...packBody,
    pack_sha256: jsonSha256(packBody),
  });
  const request = SemanticJudgeRequestV1.parse({
    run_id: input.run_id,
    nonce: `khn_${digest(JSON.stringify([input.run_id, evidencePack.pack_id]))}`,
    evidence_pack: evidencePack,
    output_schema: dependencyDecisionSchema,
    output_schema_sha256: dependencyDecisionSchemaSha,
    budget: input.budget,
  });
  const judged = await invokeSemanticJudge(port, request, signal);
  if (judged.decision.verdict === "issue" && judged.decision.citations.length === 0) {
    throw new Error("dependency issue verdict requires an exact citation");
  }
  const citationsValid = judged.decision.citations.every((citation) =>
    evidencePack.sources.some((source) =>
      JSON.stringify(source.source) === JSON.stringify(citation.source)
      && source.blob_sha256 === citation.blob_sha256
      && source.excerpts.some((excerpt) =>
        excerpt.start_line === citation.start_line
        && excerpt.end_line === citation.end_line
        && excerpt.text === citation.excerpt
        && digest(excerpt.text) === citation.text_sha256
      )
    )
  );
  if (!citationsValid) throw new Error("dependency semantic citation does not match evidence");
  return { decision: judged.decision, evidence_pack: evidencePack, response: judged.response };
}
