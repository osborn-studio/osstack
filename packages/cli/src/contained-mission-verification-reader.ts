// Shadow reader. The caller supplies authenticated, bounded GET transport and installation proof.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@osstack/protocol/source';
import {
  checkFreshness, checkTransportConclusion, matchVerificationProducer, parseVerificationResultV1,
  type VerificationProducerPolicyV1, type VerificationReasonCode, type VerificationSourceObservation,
} from '@osstack/core/verification-intake';
import { z } from 'zod';

export interface VerificationReadTarget {
  /** Exact host-registered Mission PR. Never discovered from GitHub. */
  readonly repository: string; readonly repository_id: number; readonly pr: number;
  readonly head: string; readonly base_sha: string; readonly base_ref: string; readonly branch: string;
}
export interface VerificationReadLimits { readonly maxPages: number; readonly maxRequests: number; readonly maxResults: number }
export interface VerificationReadDeps {
  /** Authenticated GET only. The transport must bound response bytes and time. */
  readonly rest: (path: string, options: { signal: AbortSignal }) => Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }>;
  /** Independent authenticated proof from the App's own installation context, never the payload. */
  readonly installationFor?: (query: { app_id: number; repository_id: number }, options: { signal: AbortSignal }) => Promise<{ readonly installation_id: number } | null>;
  readonly now?: () => Date;
}
export type VerificationReadResult =
  | { readonly status: 'closed' }
  | { readonly status: 'waiting_source'; readonly code: 'verify_read_incomplete' }
  | { readonly status: 'target_changed'; readonly code: 'verify_stale_head' | 'verify_base_changed' | 'verify_scope_unregistered' }
  | { readonly status: 'read'; readonly observed_at: number; readonly pending: number; readonly observations: readonly VerificationSourceObservation[] };

const id = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const repository = z.string().max(200).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const ref = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u).refine(v =>
  !v.includes('..') && !v.includes('//') && !v.endsWith('/') && !v.endsWith('.') && !v.split('/').some(p => p.endsWith('.lock')));
const targetSchema = z.object({ repository, repository_id: id, pr: id, head: sha, base_sha: sha, base_ref: ref, branch: ref });
const limitsSchema = z.object({ maxPages: id.max(100), maxRequests: id.max(1000), maxResults: id.max(100) });
const defaults: VerificationReadLimits = { maxPages: 10, maxRequests: 120, maxResults: 50 };
const prSide = z.object({ sha, ref, repo: z.object({ id, full_name: repository }) });
const prSchema = z.object({ number: id, state: z.literal('open'), head: prSide, base: prSide });
const suiteSchema = z.object({ id, head_sha: sha });
const runSchema = z.object({
  id, name: z.string(), app: z.object({ id }), head_sha: sha, check_suite: z.object({ id }),
  status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']),
  conclusion: z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']).nullable(),
  external_id: z.string().nullable(), started_at: z.string().datetime().nullable(), completed_at: z.string().datetime().nullable(),
}).refine(v => (v.status === 'completed') === (v.conclusion !== null));
type CheckRun = z.infer<typeof runSchema>;
const matchingName = /^osstack\/verify-intake\/[a-z][a-z0-9_-]{0,127}$/u;
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
function requireRead(value: unknown): asserts value {
  if (!value) throw new Error('verify_read_incomplete');
}
const registeredApp = (policy: VerificationProducerPolicyV1, appId: number): boolean =>
  policy.producers.some(p => p.type === 'App' && p.app_id === appId);

/** Pure classification. Raw detail remains unknown at this boundary; only allowlisted
 * identifiers, digests and a parsed ExternalReference can leave it. Null means pending.
 * The response digest covers the canonical JSON projection of run identity, status,
 * conclusion, external id, timestamps and output title/summary/text, not raw response bytes.
 * The installation id must be independently proven by the caller.
 */
export function classifyVerificationCheckRun(
  detail: unknown, policy: VerificationProducerPolicyV1, target: VerificationReadTarget,
  installationId: number | null, now: number,
): VerificationSourceObservation | null {
  const run = runSchema.parse(detail);
  requireRead(matchingName.test(run.name));
  if (run.status !== 'completed') return null;
  const output = z.object({ output: z.unknown().optional() }).parse(detail).output;
  const parsedOutput = z.object({ title: z.unknown().optional(), summary: z.unknown().optional(), text: z.unknown().optional() }).safeParse(output);
  const text = parsedOutput.success && typeof parsedOutput.data.text === 'string' ? parsedOutput.data.text : null;
  const projection = {
    id: run.id, name: run.name, app_id: run.app.id, head_sha: run.head_sha, check_suite_id: run.check_suite.id,
    status: run.status, conclusion: run.conclusion, external_id: run.external_id,
    started_at: run.started_at, completed_at: run.completed_at,
    output_title: parsedOutput.success && typeof parsedOutput.data.title === 'string' ? parsedOutput.data.title : null,
    output_summary: parsedOutput.success && typeof parsedOutput.data.summary === 'string' ? parsedOutput.data.summary : null,
    output_text: text,
  };
  const observation: VerificationSourceObservation = {
    source_kind: 'check_run', object_id: run.id, repository_id: target.repository_id, repository: target.repository, pr: target.pr,
    observed_head_sha: run.head_sha, app_id: run.app.id, check_name: run.name,
    response_digest: digest(canonicalJson(projection)), contract_digest: text === null ? null : digest(text),
    verdict: { ok: true }, result: null,
  };
  const reject = (code: VerificationReasonCode): VerificationSourceObservation => ({ ...observation, verdict: { ok: false, code } });
  if (!registeredApp(policy, run.app.id)) return reject('verify_producer_untrusted');
  if (!id.safeParse(installationId).success || !policy.producers.some(p => p.type === 'App'
    && p.app_id === run.app.id && p.installation_id === installationId)) return reject('verify_producer_untrusted');
  if (text === null) return reject('verify_contract_invalid');
  const parsed = parseVerificationResultV1(text);
  if (!parsed.ok) return reject(parsed.code);
  const result = parsed.result;
  if (run.name !== `osstack/verify-intake/${result.skill_id}` || run.external_id !== result.result_id
    || result.producer.type !== 'App' || result.producer.app_id !== run.app.id || result.producer.installation_id !== installationId
    || !checkTransportConclusion(result, run).ok) return reject('verify_contract_invalid');
  if (result.repository !== target.repository || result.repository_id !== target.repository_id || result.pr !== target.pr
    || result.branch !== target.branch || result.base_ref !== target.base_ref) return reject('verify_scope_unregistered');
  const matched = matchVerificationProducer(policy, {
    type: 'App', app_id: run.app.id, installation_id: installationId!, repository_id: target.repository_id, carrier: 'check-run',
    skill_id: result.skill_id, skill_manifest_digest: result.skill_manifest_digest, profile_id: result.profile_id,
    profile_digest: result.profile_digest, failure_code: result.failure_code,
  });
  if (!matched.ok) return reject(matched.code);
  observation.result = result;
  if (result.head_sha !== target.head || result.head_sha !== run.head_sha) return reject('verify_stale_head');
  if (result.base_sha !== target.base_sha) return reject('verify_base_changed');
  if (!checkFreshness(result, now).ok || now - Date.parse(result.generated_at) > matched.producer.ttl_ms) return reject('verify_result_expired');
  return observation;
}

/** Complete two-pass read only. No observation is consumed on partial reads or cancellation. */
export async function readVerificationResults(
  deps: VerificationReadDeps, policy: VerificationProducerPolicyV1, target: VerificationReadTarget,
  options: { signal: AbortSignal; limits?: Partial<VerificationReadLimits> },
): Promise<VerificationReadResult> {
  try {
    const { signal } = options;
    requireRead(targetSchema.safeParse(target).success);
    const limits = limitsSchema.parse({ ...defaults, ...options.limits });
    if (!policy.producers.some(p => p.type === 'App' && p.carrier === 'check-run' && p.repository_id === target.repository_id)) return { status: 'closed' };
    const checkAbort = (): void => requireRead(!signal.aborted);
    let used = 0;
    const take = (): void => { checkAbort(); requireRead(++used <= limits.maxRequests); };
    // Race cancellation even when a supplied transport does not settle on abort.
    const wait = async <T,>(action: () => Promise<T>): Promise<T> => {
      checkAbort();
      let abort = (): void => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('verify_read_incomplete'));
        signal.addEventListener('abort', abort, { once: true });
      });
      try { const result = await Promise.race([action(), cancelled]); checkAbort(); return result; }
      finally { signal.removeEventListener('abort', abort); }
    };
    const get = async (path: string): Promise<unknown> => {
      take(); const response = await wait(() => deps.rest(path, { signal }));
      requireRead(response?.ok === true); return response.body;
    };
    const base = `repos/${target.repository}`;
    const readPr = async () => prSchema.parse(await get(`${base}/pulls/${target.pr}`));
    const firstPr = await readPr();
    if (firstPr.number !== target.pr || firstPr.head.repo.id !== target.repository_id || firstPr.base.repo.id !== target.repository_id
      || firstPr.head.repo.full_name !== target.repository || firstPr.base.repo.full_name !== target.repository
      || firstPr.head.ref !== target.branch || firstPr.base.ref !== target.base_ref) return { status: 'target_changed', code: 'verify_scope_unregistered' };
    if (firstPr.head.sha !== target.head) return { status: 'target_changed', code: 'verify_stale_head' };
    if (firstPr.base.sha !== target.base_sha) return { status: 'target_changed', code: 'verify_base_changed' };
    const list = async <T,>(path: string, key: string, schema: z.ZodType<T>): Promise<T[]> => {
      const pageSchema = z.object({ total_count: z.number().int().nonnegative().safe() }).and(z.object({ [key]: z.array(schema).max(100) }));
      const items: T[] = []; let total: number | undefined;
      for (let page = 1; page <= limits.maxPages; page++) {
        const body = pageSchema.parse(await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
        requireRead(total === undefined || total === body.total_count); total = body.total_count;
        requireRead(total <= limits.maxPages * 100);
        const rows = body[key] as T[];
        requireRead(rows.length === Math.min(100, total - items.length)); items.push(...rows);
        if (items.length === total) return items;
      }
      throw new Error('verify_read_incomplete');
    };
    const listRuns = async (): Promise<CheckRun[]> => {
      const suites = await list(`${base}/commits/${target.head}/check-suites`, 'check_suites', suiteSchema);
      const suiteIds = new Set<number>(); const runIds = new Set<number>(); const matching: CheckRun[] = [];
      for (const suite of suites) {
        requireRead(suite.head_sha === target.head && !suiteIds.has(suite.id)); suiteIds.add(suite.id);
        for (const run of await list(`${base}/check-suites/${suite.id}/check-runs?filter=all`, 'check_runs', runSchema)) {
          requireRead(run.head_sha === target.head && run.check_suite.id === suite.id && !runIds.has(run.id)); runIds.add(run.id);
          if (!matchingName.test(run.name)) continue;
          matching.push(run); requireRead(matching.length <= limits.maxResults);
        }
      }
      return matching.sort((a, b) => a.id - b.id);
    };
    const first = await listRuns();
    const details: unknown[] = [];
    for (const row of first) {
      const detail = await get(`${base}/check-runs/${row.id}`); const run = runSchema.parse(detail);
      requireRead(run.id === row.id && run.name === row.name && run.app.id === row.app.id && run.head_sha === row.head_sha
        && run.check_suite.id === row.check_suite.id && run.status === row.status && run.conclusion === row.conclusion && run.external_id === row.external_id);
      details.push(detail);
    }
    const second = await listRuns();
    const identity = (rows: CheckRun[]) => rows.map(r => [r.id, r.name, r.app.id, r.status, r.conclusion, r.external_id, r.started_at, r.completed_at]);
    requireRead(canonicalJson(identity(first)) === canonicalJson(identity(second)));
    requireRead(canonicalJson(firstPr) === canonicalJson(await readPr()));
    const installations = new Map<number, number | null>();
    for (const run of first) {
      if (run.status !== 'completed' || !registeredApp(policy, run.app.id) || installations.has(run.app.id)) continue;
      let installation: number | null = null;
      if (deps.installationFor) {
        take();
        try {
          const proof = await wait(() => deps.installationFor!({ app_id: run.app.id, repository_id: target.repository_id }, { signal }));
          if (proof && id.safeParse(proof.installation_id).success) installation = proof.installation_id;
        } catch { checkAbort(); } // Unavailable independent proof rejects this producer; budget and abort fail the read.
      }
      installations.set(run.app.id, installation);
    }
    checkAbort();
    const observedAt = (deps.now?.() ?? new Date()).getTime(); requireRead(Number.isSafeInteger(observedAt) && observedAt >= 0);
    const observations: VerificationSourceObservation[] = []; let pending = 0;
    for (let i = 0; i < first.length; i++) {
      const observation = classifyVerificationCheckRun(details[i], policy, target, installations.get(first[i]!.app.id) ?? null, observedAt);
      if (observation) observations.push(observation); else pending++;
    }
    checkAbort();
    return { status: 'read', observed_at: observedAt, pending, observations: observations.sort((a, b) => a.app_id - b.app_id || a.object_id - b.object_id) };
  } catch { return { status: 'waiting_source', code: 'verify_read_incomplete' }; }
}
