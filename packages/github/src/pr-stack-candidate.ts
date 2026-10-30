import { z } from 'zod';
import { defaultDeliveryCommandRunner, type DeliveryCommandRunner } from './delivery.js';
import { inspectPrCandidate, validatePrCandidateInput, type PrCandidateObservation, type PrCandidateSnapshot } from './pr-candidate-snapshot.js';

const planSchema = z.object({
  schema_version: z.literal(1),
  repo: z.string(),
  target_base: z.string().min(1).max(256).refine(value => ![...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })),
  prs: z.array(z.object({
    pr: z.number(), expectedHead: z.string().optional(), expectedBase: z.string().optional(),
    requiredChecks: z.array(z.string()).optional(),
  }).strict()).min(1).max(3),
}).strict();
export type PrStackCandidateInput = z.infer<typeof planSchema>;
export function validatePrStackCandidateInput(input: unknown): PrStackCandidateInput {
  try {
    const plan = planSchema.parse(input);
    if (new Set(plan.prs.map(row => row.pr)).size !== plan.prs.length) throw new Error('duplicate_pr');
    for (const row of plan.prs) validatePrCandidateInput({ repo: plan.repo, ...row });
    return plan;
  } catch { throw new Error('invalid_stack_input'); }
}
export interface PrStackObservation {
  pr: number;
  observation: PrCandidateObservation | null;
  issue: 'stack_budget_exhausted' | 'collector_failed' | null;
}
export interface PrStackRelation {
  status: 'target_matches' | 'parent_matches' | 'retarget_review_needed' | 'inconsistent' | 'unconfirmed' | 'not_applicable';
  expected_base: string | null;
  observed_base: string | null;
}
export interface PrStackCandidateRow {
  pr: number;
  role: 'merged_prefix' | 'frontier' | 'upstack';
  observation_status: 'observed' | 'not_observed';
  issue: PrStackObservation['issue'];
  candidate_summary: PrCandidateSnapshot['summary'] | null;
  relation: PrStackRelation;
  blockers: string[];
  waiting: string[];
  unknowns: string[];
}
export interface PrStackCandidateReport {
  schema_version: 1;
  repo: string;
  target_base: string;
  order: number[];
  started_at: string;
  finished_at: string;
  status: 'frontier_observed' | 'frontier_unknown' | 'closed_unmerged' | 'observed_all_merged';
  frontier_pr: number | null;
  rows: PrStackCandidateRow[];
  requests: number;
  limits: { max_prs: 3; max_requests: 24; collection_budget_ms: 270000 };
  merge_authorized: false;
  limitations: string[];
}
export interface PrStackCandidateDispatch {
  pr: number; query_index: number; timeout_ms: number; started_at: string; finished_at: string;
}
export interface PrStackCandidateResult { report: PrStackCandidateReport; observations: PrStackObservation[]; dispatches: PrStackCandidateDispatch[] }

// A stable SHA bracket alone does not make an OPEN -> MERGED state transition stable.
function stableState(row: PrStackObservation | undefined): string | null {
  if (row?.issue) return null;
  const snapshot = row?.observation?.snapshot;
  if (!snapshot || snapshot.binding.status !== 'stable' || !snapshot.initial || !snapshot.final) return null;
  return snapshot.initial.state === snapshot.final.state ? snapshot.final.state : null;
}
function relationAt(index: number, frontier: number, observations: PrStackObservation[], target: string): PrStackRelation {
  const snapshot = observations[index]?.observation?.snapshot;
  const base = snapshot?.final?.baseRefName ?? null;
  if (index < frontier) return { status: 'not_applicable', expected_base: null, observed_base: base };
  if (stableState(observations[index]) !== 'OPEN') return { status: 'unconfirmed', expected_base: null, observed_base: base };
  if (index === frontier) return { status: base === target ? 'target_matches' : 'retarget_review_needed', expected_base: target, observed_base: base };
  const previous = observations[index - 1]?.observation?.snapshot;
  if (stableState(observations[index - 1]) !== 'OPEN') return { status: 'unconfirmed', expected_base: null, observed_base: base };
  const expected = previous?.final?.headRefName ?? null;
  return { status: base === expected ? 'parent_matches' : 'inconsistent', expected_base: expected, observed_base: base };
}

/** One declared list, observed sequentially. This does not discover dependencies or authorize mutations. */
export async function inspectPrStackCandidate(
  input: PrStackCandidateInput,
  runner: DeliveryCommandRunner = defaultDeliveryCommandRunner,
  clock: () => number = Date.now,
): Promise<PrStackCandidateResult> {
  const plan = validatePrStackCandidateInput(input);
  const start = clock(), deadline = start + 270000;
  let requests = 0, currentPr = 0, queryIndex = 0;
  const dispatches: PrStackCandidateDispatch[] = [];
  const boundedRunner: DeliveryCommandRunner = { async run(command, args, options) {
    const began = clock(), remaining = deadline - began;
    const index = queryIndex++;
    if (requests >= 24 || remaining <= 0) throw new Error('budget_exhausted');
    requests += 1;
    const timeoutMs = Math.min(options.timeoutMs, remaining);
    const dispatch = { pr: currentPr, query_index: index, timeout_ms: timeoutMs, started_at: new Date(began).toISOString(), finished_at: '' };
    dispatches.push(dispatch);
    try { return await runner.run(command, args, { ...options, timeoutMs }); }
    finally { dispatch.finished_at = new Date(clock()).toISOString(); }
  } };
  const observations: PrStackObservation[] = [];
  for (const row of plan.prs) {
    if (requests >= 24 || clock() >= deadline) {
      observations.push({ pr: row.pr, observation: null, issue: 'stack_budget_exhausted' });
      continue;
    }
    try {
      currentPr = row.pr; queryIndex = 0;
      const observation = await inspectPrCandidate({ repo: plan.repo, ...row }, boundedRunner, clock);
      observations.push({ pr: row.pr, observation, issue: clock() > deadline ? 'stack_budget_exhausted' : null });
    } catch {
      // An unexpected collector failure cannot erase previous candidates or promote a later one.
      observations.push({ pr: row.pr, observation: null, issue: 'collector_failed' });
    }
  }
  let frontier = 0;
  while (frontier < observations.length && stableState(observations[frontier]) === 'MERGED') frontier += 1;
  const state = stableState(observations[frontier]);
  const status: PrStackCandidateReport['status'] = frontier === observations.length ? 'observed_all_merged'
    : state === 'CLOSED' ? 'closed_unmerged' : state === 'OPEN' ? 'frontier_observed' : 'frontier_unknown';
  const rows: PrStackCandidateRow[] = observations.map((row, index) => {
    const snapshot = row.observation?.snapshot;
    return {
      pr: row.pr, role: index < frontier ? 'merged_prefix' : index === frontier ? 'frontier' : 'upstack',
      observation_status: row.observation === null ? 'not_observed' : 'observed', issue: row.issue,
      candidate_summary: snapshot?.summary ?? null,
      relation: relationAt(index, frontier, observations, plan.target_base),
      blockers: snapshot?.blockers ?? [], waiting: snapshot?.waiting ?? [],
      unknowns: [...(snapshot?.unknowns ?? []), ...(row.issue ? [row.issue] : []), ...(stableState(row) === null ? ['candidate_state_unconfirmed'] : [])],
    };
  });
  return { report: {
    schema_version: 1, repo: plan.repo, target_base: plan.target_base, order: plan.prs.map(row => row.pr),
    started_at: new Date(start).toISOString(), finished_at: new Date(clock()).toISOString(), status,
    frontier_pr: observations[frontier]?.pr ?? null, rows, requests,
    limits: { max_prs: 3, max_requests: 24, collection_budget_ms: 270000 }, merge_authorized: false,
    limitations: [
      'Caller-declared order; branch-name equality is not ancestry or dependency proof.',
      'Sequential non-atomic observations; facts can change after each read. No automatic re-read.',
      'A frontier is not Ready or merge authorization. Original per-PR policy and unknowns remain in snapshots.',
      'No watcher, retry, retarget, approval, merge, candidate execution or database refresh.',
      'Collection budgets use wall time. The runner must honor timeoutMs; injected runners are not forcibly cancelled.',
    ],
  }, observations, dispatches };
}
