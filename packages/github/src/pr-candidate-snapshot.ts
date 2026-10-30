import { z } from 'zod';
import { defaultDeliveryCommandRunner, type DeliveryCommandRunner } from './delivery.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hasAsciiControl = (value: string) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
};
const inputSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  pr: z.number().int().positive().max(2147483647),
  expectedHead: sha.optional(), expectedBase: sha.optional(),
  requiredChecks: z.array(z.string().min(1).max(256).refine(v => !hasAsciiControl(v))).max(100).optional(),
}).strict().refine(v => (v.expectedHead === undefined) === (v.expectedBase === undefined))
  .refine(v => new Set(v.requiredChecks ?? []).size === (v.requiredChecks ?? []).length);
export type PrCandidateInput = z.infer<typeof inputSchema>;
export function validatePrCandidateInput(input: unknown): PrCandidateInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid_input');
  return parsed.data;
}
const factsSchema = z.object({
  number: z.number().int(), url: z.string().url(), state: z.string(), isDraft: z.boolean(),
  headRefOid: sha, baseRefOid: sha, headRefName: z.string().min(1), baseRefName: z.string().min(1),
  mergeable: z.string(), mergeStateStatus: z.string(), reviewDecision: z.string().nullable(),
});
export type PrCandidateFacts = z.infer<typeof factsSchema>;
const threadSchema = z.object({ id: z.string().min(1), isResolved: z.boolean(), isOutdated: z.boolean(), path: z.string(), line: z.number().int().nullable() });
const checkSchema = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('CheckRun'), id: z.string().min(1), name: z.string().min(1), status: z.string(), conclusion: z.string().nullable(), detailsUrl: z.string().nullable() }),
  z.object({ __typename: z.literal('StatusContext'), id: z.string().min(1), context: z.string().min(1), state: z.string(), targetUrl: z.string().nullable() }),
]);
type CheckWire = z.infer<typeof checkSchema>;
export type PrCandidateCheckState = 'success' | 'failure' | 'pending' | 'cancelled' | 'timed_out' | 'skipped' | 'neutral' | 'action_required' | 'unknown';
export interface PrCandidateCheck { id: string; name: string; state: PrCandidateCheckState; raw: CheckWire }
export interface PrCandidateQuery {
  label: string; command: 'gh'; args: string[]; started_at: string; finished_at: string;
  timeout_ms: number; exit_code: number | null; issue: string | null;
}
export interface PrCandidateRaw { label: string; stdout: string; stderr: string }
interface Facet<T> { rows: T[]; complete: boolean; issue: string | null }
export interface PrCandidateSnapshot {
  schema_version: 1; repo: string; pr: number; started_at: string; finished_at: string;
  initial: PrCandidateFacts | null; final: PrCandidateFacts | null;
  binding: { status: 'stable' | 'changed' | 'unknown'; head: string | null; base: string | null; expected_head: string | null; expected_base: string | null };
  checks: Facet<PrCandidateCheck> & { head: string | null; required: string[]; missing_required: string[]; ambiguous_required: string[] };
  review: { decision: string | null; threads: Facet<z.infer<typeof threadSchema>>; unresolved: z.infer<typeof threadSchema>[]; approval_commit_binding: 'not_collected' };
  blockers: string[]; waiting: string[]; unknowns: string[];
  summary: 'blocked' | 'waiting' | 'no_observed_blocker' | 'unknown' | 'candidate_changed' | 'merged' | 'closed';
  merge_authorized: false; requirements_basis: 'caller_declared' | 'unspecified';
  forge_policy_coverage: 'not_collected'; evaluated_merge_commit: 'unknown';
  limits: { max_requests: 8; pages_per_connection: 3; items_per_page: 100; request_timeout_ms: 10000; total_budget_ms: 90000; runner_stream_bytes: 16777216; accepted_json_bytes: 1048576 };
  limitations: string[];
}
export interface PrCandidateObservation { snapshot: PrCandidateSnapshot; queries: PrCandidateQuery[]; raw: PrCandidateRaw[] }

const factsQuery = `query CandidateFacts($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){number url state isDraft headRefOid baseRefOid headRefName baseRefName mergeable mergeStateStatus reviewDecision}}}`;
const checksQuery = `query CandidateChecks($owner:String!,$name:String!,$oid:GitObjectID!,$after:String){repository(owner:$owner,name:$name){nameWithOwner object(oid:$oid){... on Commit{oid statusCheckRollup{contexts(first:100,after:$after){nodes{__typename ... on CheckRun{id name status conclusion detailsUrl} ... on StatusContext{id context state targetUrl}} pageInfo{hasNextPage endCursor}}}}}}}`;
const threadsQuery = `query CandidateThreads($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){number reviewThreads(first:100,after:$after){nodes{id isResolved isOutdated path line} pageInfo{hasNextPage endCursor}}}}}`;
const pageSchema = z.object({ nodes: z.array(z.unknown()).max(100), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) });
const record = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid_response');
  return v as Record<string, unknown>;
};
function checkState(row: CheckWire): PrCandidateCheckState {
  if (row.__typename === 'StatusContext') {
    if (row.state === 'SUCCESS') return 'success';
    if (row.state === 'FAILURE' || row.state === 'ERROR') return 'failure';
    return row.state === 'PENDING' ? 'pending' : 'unknown';
  }
  if (['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'].includes(row.status) && row.conclusion === null) return 'pending';
  if (row.status !== 'COMPLETED') return 'unknown';
  switch (row.conclusion) {
    case 'SUCCESS': return 'success';
    case 'FAILURE': case 'STARTUP_FAILURE': case 'STALE': return 'failure';
    case 'CANCELLED': return 'cancelled';
    case 'TIMED_OUT': return 'timed_out';
    case 'SKIPPED': return 'skipped';
    case 'NEUTRAL': return 'neutral';
    case 'ACTION_REQUIRED': return 'action_required';
    default: return 'unknown';
  }
}

/** A bracketed observation, not an atomic forge transaction or merge authorization. */
export async function inspectPrCandidate(
  input: PrCandidateInput,
  runner: DeliveryCommandRunner = defaultDeliveryCommandRunner,
  clock: () => number = Date.now,
): Promise<PrCandidateObservation> {
  const validated = validatePrCandidateInput(input);
  const required = validated.requiredChecks ?? [];
  const start = clock(), deadline = start + 90000;
  const queries: PrCandidateQuery[] = [], raw: PrCandidateRaw[] = [];
  const [owner, name] = validated.repo.split('/') as [string, string];
  const iso = (time: number) => new Date(time).toISOString();
  const read = async (label: string, query: string, variables: string[]): Promise<Record<string, unknown>> => {
    const began = clock();
    if (queries.length >= 8 || began >= deadline) throw new Error('budget_exhausted');
    const timeout = Math.min(10000, deadline - began);
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...variables];
    const receipt: PrCandidateQuery = { label, command: 'gh', args, started_at: iso(began), finished_at: iso(began), timeout_ms: timeout, exit_code: null, issue: null };
    queries.push(receipt);
    try {
      const result = await runner.run('gh', args, { cwd: process.cwd(), timeoutMs: timeout });
      receipt.exit_code = result.exitCode;
      raw.push({ label, stdout: result.stdout, stderr: result.stderr });
      if (result.exitCode !== 0) throw new Error('command_failed');
      if (clock() > deadline) throw new Error('budget_exhausted');
      if (Buffer.byteLength(result.stdout) > 1048576) throw new Error('response_size');
      let parsed: Record<string, unknown>;
      try { parsed = record(JSON.parse(result.stdout)); } catch { throw new Error('invalid_json'); }
      if (parsed.errors !== undefined) throw new Error('graphql_errors');
      const repository = record(record(parsed.data).repository);
      if (repository.nameWithOwner !== validated.repo) throw new Error('repository_mismatch');
      return repository;
    } catch (error) {
      const allowed = ['command_failed', 'budget_exhausted', 'response_size', 'invalid_json', 'graphql_errors', 'repository_mismatch', 'invalid_response'];
      receipt.issue = error instanceof Error && allowed.includes(error.message) ? error.message : 'runner_failed';
      throw new Error(receipt.issue);
    } finally { receipt.finished_at = iso(clock()); }
  };
  const readFacts = async (label: string) => {
    const repository = await read(label, factsQuery, ['-F', `number=${validated.pr}`]);
    const parsed = factsSchema.safeParse(repository.pullRequest);
    if (!parsed.success || parsed.data.number !== validated.pr) throw new Error('pr_identity_unavailable');
    return parsed.data;
  };
  const collect = async <T>(kind: 'checks' | 'threads', head: string, schema: z.ZodType<T>): Promise<Facet<T>> => {
    const facet: Facet<T> = { rows: [], complete: false, issue: null };
    const cursors = new Set<string>(), ids = new Set<string>();
    let after: string | null = null;
    try {
      for (let i = 1; i <= 3; i++) {
        const vars = kind === 'checks' ? ['-f', `oid=${head}`] : ['-F', `number=${validated.pr}`];
        if (after !== null) vars.push('-f', `after=${after}`);
        const repo = await read(`${kind}-${i}`, kind === 'checks' ? checksQuery : threadsQuery, vars);
        let connection: unknown;
        if (kind === 'checks') {
          const commit = record(repo.object);
          if (commit.oid !== head) throw new Error('head_mismatch');
          connection = record(commit.statusCheckRollup).contexts;
        } else {
          const pr = record(repo.pullRequest);
          if (pr.number !== validated.pr) throw new Error('pr_mismatch');
          connection = pr.reviewThreads;
        }
        const parsed = pageSchema.safeParse(connection);
        if (!parsed.success) throw new Error('invalid_page');
        for (const item of parsed.data.nodes) {
          const node = schema.safeParse(item);
          if (!node.success) throw new Error('invalid_row');
          const id = String(record(node.data).id);
          if (ids.has(id)) throw new Error('duplicate_id');
          ids.add(id); facet.rows.push(node.data);
        }
        if (!parsed.data.pageInfo.hasNextPage) { facet.complete = true; return facet; }
        after = parsed.data.pageInfo.endCursor;
        if (!after || cursors.has(after)) throw new Error('cursor_progress');
        cursors.add(after);
      }
      facet.issue = 'page_limit';
    } catch (error) { facet.issue = error instanceof Error ? error.message : 'collection_failed'; }
    return facet;
  };
  let initial: PrCandidateFacts | null = null, final: PrCandidateFacts | null = null;
  const unknowns: string[] = [], blockers: string[] = [], waiting: string[] = [];
  let checkRows: Facet<CheckWire> = { rows: [], complete: false, issue: 'not_collected' };
  let threadRows: Facet<z.infer<typeof threadSchema>> = { rows: [], complete: false, issue: 'not_collected' };
  try { initial = await readFacts('initial'); } catch { unknowns.push('initial_identity_unavailable'); }
  if (initial !== null) {
    checkRows = await collect('checks', initial.headRefOid, checkSchema);
    threadRows = await collect('threads', initial.headRefOid, threadSchema);
    try { final = await readFacts('final'); } catch { unknowns.push('final_identity_unavailable'); }
  }
  let binding: 'stable' | 'changed' | 'unknown' = 'unknown';
  if (initial && final) {
    binding = ['headRefOid', 'baseRefOid', 'headRefName', 'baseRefName'].every(key => initial[key as keyof PrCandidateFacts] === final[key as keyof PrCandidateFacts]) ? 'stable' : 'changed';
  }
  if (initial && validated.expectedHead && (initial.headRefOid !== validated.expectedHead || initial.baseRefOid !== validated.expectedBase)) binding = 'changed';
  const rows: PrCandidateCheck[] = checkRows.rows.map(row => ({ id: row.id, name: row.__typename === 'CheckRun' ? row.name : row.context, state: checkState(row), raw: row }));
  const missing = required.filter(n => !rows.some(r => r.name === n));
  const ambiguous = required.filter(n => rows.filter(r => r.name === n).length > 1);
  if (!checkRows.complete) unknowns.push('checks_incomplete');
  if (!threadRows.complete) unknowns.push('threads_incomplete');
  if (missing.length) unknowns.push('required_checks_missing');
  if (ambiguous.length) unknowns.push('required_checks_ambiguous');
  if (!required.length) unknowns.push('requirements_unspecified');
  // Non-required observed failures remain visible; they are not inferred required gates.
  if (rows.some(r => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(r.state))) blockers.push('check_failure');
  if (rows.some(r => r.state === 'pending')) waiting.push('checks_pending');
  if (rows.some(r => ['unknown', 'skipped', 'neutral'].includes(r.state))) unknowns.push('checks_not_success');
  const unresolved = threadRows.rows.filter(t => !t.isResolved);
  if (unresolved.length) blockers.push('unresolved_threads');
  if (final) {
    if (final.reviewDecision === 'CHANGES_REQUESTED') blockers.push('changes_requested');
    else if (final.reviewDecision === 'REVIEW_REQUIRED') waiting.push('review_required');
    else if (final.reviewDecision !== 'APPROVED') unknowns.push('review_decision_unknown');
    if (final.mergeable === 'CONFLICTING' || final.mergeStateStatus === 'DIRTY') blockers.push('merge_conflict');
    else if (final.mergeable !== 'MERGEABLE') unknowns.push('mergeability_unknown');
    if (final.mergeStateStatus === 'BLOCKED') blockers.push('forge_blocked');
    else if (['BEHIND', 'DRAFT'].includes(final.mergeStateStatus)) waiting.push('forge_waiting');
    else if (!['CLEAN', 'DIRTY'].includes(final.mergeStateStatus)) unknowns.push('merge_state_unknown');
    if (final.isDraft) waiting.push('draft');
    if (!['OPEN', 'MERGED', 'CLOSED'].includes(final.state)) unknowns.push('pr_state_unknown');
  }
  let summary: PrCandidateSnapshot['summary'];
  if (binding === 'changed') summary = 'candidate_changed';
  else if (binding === 'unknown') summary = 'unknown';
  else if (final?.state === 'MERGED') summary = 'merged';
  else if (final?.state === 'CLOSED') summary = 'closed';
  else if (blockers.length) summary = 'blocked';
  else if (unknowns.length) summary = 'unknown';
  else if (waiting.length) summary = 'waiting';
  else summary = 'no_observed_blocker';
  return { snapshot: {
    schema_version: 1, repo: validated.repo, pr: validated.pr, started_at: iso(start), finished_at: iso(clock()), initial, final,
    binding: { status: binding, head: initial?.headRefOid ?? null, base: initial?.baseRefOid ?? null, expected_head: validated.expectedHead ?? null, expected_base: validated.expectedBase ?? null },
    checks: { rows, complete: checkRows.complete, issue: checkRows.issue, head: initial?.headRefOid ?? null, required, missing_required: missing, ambiguous_required: ambiguous },
    review: { decision: final?.reviewDecision ?? null, threads: threadRows, unresolved, approval_commit_binding: 'not_collected' },
    blockers, waiting, unknowns, summary, merge_authorized: false,
    requirements_basis: required.length ? 'caller_declared' : 'unspecified', forge_policy_coverage: 'not_collected', evaluated_merge_commit: 'unknown',
    limits: { max_requests: 8, pages_per_connection: 3, items_per_page: 100, request_timeout_ms: 10000, total_budget_ms: 90000, runner_stream_bytes: 16777216, accepted_json_bytes: 1048576 },
    limitations: ['Non-atomic observations; checks and reviews may change after collection.', 'No branch protection, rulesets, merge queue or individual approval-commit qualification.', 'Read-only argv requests; no candidate execution, watcher, retries or merge authorization.', 'Runner injection is a test seam, not authenticated evidence. Raw metadata may be private.'],
  }, queries, raw };
}
