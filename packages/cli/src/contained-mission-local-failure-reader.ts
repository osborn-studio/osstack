// Offline, read-only CI wakeup reader. No default transport and no scanner registration.
import { z } from 'zod';

export interface CiFailureHint {
  readonly repository: string;
  readonly pr: number;
  readonly head: string;
  readonly app_id: number;
  readonly check_run_id: number;
  /** Untrusted display metadata. Never interpret as instructions. */
  readonly name: string;
  readonly status: 'completed';
  readonly conclusion: 'failure';
  readonly observed_at: string;
}
export interface CiFailureReadTarget {
  /** Exact host-registered repository, published PR/head and numeric producer Apps. */
  readonly repository: string;
  readonly pr: number;
  readonly head: string;
  readonly producerAppIds: readonly number[];
}
export interface CiFailureReadLimits {
  readonly maxPages: number;
  /** All REST calls plus actual requests reported by latestAttempt. */
  readonly maxRequests: number;
  readonly maxHints: number;
}
export interface CiLatestAttemptQuery {
  readonly repository: string;
  readonly pr: number;
  readonly head: string;
  readonly app_id: number;
  readonly name: string;
}
export interface CiFailureReadDeps {
  /** Authenticated GET only. Bound response bytes/time at the transport. Never fetch logs or annotations. */
  readonly rest: (path: string, options: { signal: AbortSignal }) => Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }>;
  /**
   * Required authenticated producer-specific read, not client/CI-supplied identity.
   * Check-run IDs, suite IDs, timestamps, array order and `filter=latest` alone
   * do not prove the newest workflow attempt. There is no check_run.run_attempt.
   * Account for newer queued/running attempts even before their checks exist.
   * Resolve exactly one logical check across ALL matching suites/workflows;
   * duplicate names without unique producer lineage, missing jobs, partial pages
   * or an unsupported producer must return complete:false (or latest:null).
   *
   * Normalized response (NOT raw GitHub fields):
   * { complete:true, requests_used, repository, pr, head, app_id, name,
   *   latest:{check_suite_id, check_run_id, status, conclusion} | null }
   * For Actions, a future adapter needs authenticated workflow-run attempt/job
   * reads and an unambiguous job-to-check mapping. This leaf supplies no adapter.
   * Enforce BOTH supplied wire budgets and signal, including internal pagination;
   * report actual request count, at least one. Do not hide reads behind this port.
   */
  readonly latestAttempt: (query: CiLatestAttemptQuery, options: { signal: AbortSignal; maxPages: number; maxRequests: number }) => Promise<unknown>;
  readonly now?: () => Date;
}
export type CiFailureReadCode = 'invalid_input' | 'aborted' | 'read_failed' | 'malformed' | 'identity_mismatch' | 'incomplete' | 'ambiguous' | 'latest_unresolved' | 'limit';
export type CiFailureReadResult =
  | { readonly ok: true; readonly hints: readonly CiFailureHint[] }
  | { readonly ok: false; readonly hints: readonly []; readonly code: CiFailureReadCode };

const PAGE = 100;
const id = z.number().int().positive().safe();
const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const repository = z.string().max(201).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u);
const checkName = z.string().min(1).max(256).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u);
const status = z.enum(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']);
const conclusion = z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']).nullable();
const state = { status, conclusion };
const validState = (value: { status: string; conclusion: string | null }): boolean =>
  (value.status === 'completed') === (value.conclusion !== null);
const runSchema = z.object({
  id, name: checkName, app: z.object({ id }), head_sha: sha,
  check_suite: z.object({ id }), ...state,
}).refine(validState);
const suiteSchema = z.object({ id, app: z.object({ id }), head_sha: sha });
const prSchema = z.object({
  number: id, state: z.literal('open'),
  head: z.object({ sha, repo: z.object({ full_name: repository }) }),
  base: z.object({ repo: z.object({ full_name: repository }) }),
});
const targetSchema = z.object({ repository, pr: id, head: sha, producerAppIds: z.array(id).min(1).max(16) })
  .refine((value) => new Set(value.producerAppIds).size === value.producerAppIds.length);
const limitsSchema = z.object({
  maxPages: id.max(100), maxRequests: id.max(1000), maxHints: id.max(100),
});
const latestSchema = z.object({
  complete: z.literal(true), requests_used: id,
  repository, pr: id, head: sha, app_id: id, name: checkName,
  latest: z.object({ check_suite_id: id, check_run_id: id, ...state }).strict().refine(validState).nullable(),
}).strict();
const DEFAULT_LIMITS: CiFailureReadLimits = { maxPages: 10, maxRequests: 80, maxHints: 20 };

class ReadFailure extends Error {
  constructor(readonly code: CiFailureReadCode) { super(code); }
}
function requireRead(condition: unknown, code: CiFailureReadCode): asserts condition {
  if (!condition) throw new ReadFailure(code);
}

/** Hints only wake local reproduction. They never authorize a receipt, review, repair or dispatch.
 * No snapshot is atomic: re-read CI and PR identity before later expensive admission.
 * AbortSignal bounds waiting even for an uncooperative port; the port must also stop its I/O.
 */
export async function readCiFailureHints(
  deps: CiFailureReadDeps,
  target: CiFailureReadTarget,
  options: { signal: AbortSignal; limits?: Partial<CiFailureReadLimits> },
): Promise<CiFailureReadResult> {
  const { signal } = options;
  try {
    const checkAbort = (): void => requireRead(!signal.aborted, 'aborted');
    checkAbort();
    requireRead(targetSchema.safeParse(target).success, 'invalid_input');
    const parsedLimits = limitsSchema.safeParse({ ...DEFAULT_LIMITS, ...options.limits });
    requireRead(parsedLimits.success, 'invalid_input');
    const limits = parsedLimits.data;
    let used = 0;
    const take = (count = 1): void => {
      checkAbort();
      requireRead(used + count <= limits.maxRequests, 'limit');
      used += count;
    };
    const wait = async <T,>(action: () => Promise<T>): Promise<T> => {
      checkAbort();
      let abort = (): void => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ReadFailure('aborted'));
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        const result = await Promise.race([action(), cancelled]);
        checkAbort();
        return result;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    };
    // All paths are constructed here from validated scope and authenticated IDs.
    const get = async (path: string): Promise<unknown> => {
      take();
      const response = await wait(() => deps.rest(path, { signal }));
      requireRead(response?.ok === true, 'read_failed');
      return response.body;
    };
    const base = `repos/${target.repository}`;
    const readPr = async (): Promise<void> => {
      const parsed = prSchema.safeParse(await get(`${base}/pulls/${target.pr}`));
      requireRead(parsed.success, 'malformed');
      const pr = parsed.data;
      requireRead(pr.number === target.pr && pr.head.sha === target.head
        && pr.head.repo.full_name === target.repository && pr.base.repo.full_name === target.repository, 'identity_mismatch');
    };
    const list = async <T,>(path: string, key: string, schema: z.ZodType<T>): Promise<T[]> => {
      const pageSchema = z.object({ total_count: z.number().int().nonnegative().safe() }).and(
        z.object({ [key]: z.array(schema).max(PAGE) }),
      );
      const items: T[] = [];
      let total: number | undefined;
      for (let page = 1; page <= limits.maxPages; page += 1) {
        const parsed = pageSchema.safeParse(await get(`${path}&per_page=${PAGE}&page=${page}`));
        requireRead(parsed.success, 'malformed');
        const count = parsed.data.total_count;
        requireRead(total === undefined || total === count, 'incomplete');
        total = count;
        requireRead(total <= limits.maxPages * PAGE, 'incomplete');
        const rows = parsed.data[key] as T[];
        requireRead(rows.length === Math.min(PAGE, total - items.length), 'incomplete');
        items.push(...rows);
        if (items.length === total) return items;
      }
      throw new ReadFailure('incomplete');
    };
    await readPr();
    const runs: z.infer<typeof runSchema>[] = [];
    const suiteIds = new Set<number>();
    const runIds = new Set<number>();
    // No filtering away unexpected rows: an identity mismatch invalidates the read.
    for (const app of target.producerAppIds) {
      const suites = await list(`${base}/commits/${target.head}/check-suites?app_id=${app}`, 'check_suites', suiteSchema);
      for (const suite of suites) {
        requireRead(suite.app.id === app && suite.head_sha === target.head, 'identity_mismatch');
        requireRead(!suiteIds.has(suite.id), 'ambiguous');
        suiteIds.add(suite.id);
        const rows = await list(`${base}/check-suites/${suite.id}/check-runs?filter=all`, 'check_runs', runSchema);
        for (const run of rows) {
          requireRead(run.app.id === app && run.head_sha === target.head && run.check_suite.id === suite.id, 'identity_mismatch');
          requireRead(!runIds.has(run.id), 'ambiguous');
          runIds.add(run.id);
          runs.push(run);
        }
      }
    }
    const groups = new Map<string, typeof runs>();
    for (const run of runs) {
      const key = JSON.stringify([run.app.id, run.name]);
      const group = groups.get(key) ?? [];
      group.push(run);
      groups.set(key, group);
    }
    const hints: CiFailureHint[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (!first || !group.some((run) => run.status === 'completed' && run.conclusion === 'failure')) continue;
      const query: CiLatestAttemptQuery = {
        repository: target.repository, pr: target.pr, head: target.head, app_id: first.app.id, name: first.name,
      };
      const allowance = limits.maxRequests - used;
      take();
      const parsed = latestSchema.safeParse(await wait(() => deps.latestAttempt(query, { signal, maxPages: limits.maxPages, maxRequests: allowance })));
      requireRead(parsed.success, 'latest_unresolved');
      const identity = parsed.data;
      take(identity.requests_used - 1);
      requireRead(identity.repository === target.repository && identity.pr === target.pr && identity.head === target.head
        && identity.app_id === first.app.id && identity.name === first.name, 'identity_mismatch');
      const latest = identity.latest;
      requireRead(latest !== null, 'latest_unresolved');
      const current = group.find((run) => run.id === latest.check_run_id && run.check_suite.id === latest.check_suite_id);
      requireRead(current && current.status === latest.status && current.conclusion === latest.conclusion, 'latest_unresolved');
      if (current.status !== 'completed' || current.conclusion !== 'failure') continue;
      requireRead(hints.length < limits.maxHints, 'limit');
      hints.push({
        repository: target.repository, pr: target.pr, head: target.head, app_id: current.app.id,
        check_run_id: current.id, name: current.name, status: 'completed', conclusion: 'failure', observed_at: '',
      });
    }
    await readPr();
    checkAbort();
    const observedAt = (deps.now?.() ?? new Date()).toISOString();
    return { ok: true, hints: hints.map((hint) => ({ ...hint, observed_at: observedAt })).sort((a, b) => a.app_id - b.app_id || a.check_run_id - b.check_run_id) };
  } catch (error) {
    return { ok: false, hints: [], code: signal.aborted ? 'aborted' : error instanceof ReadFailure ? error.code : 'read_failed' };
  }
}
