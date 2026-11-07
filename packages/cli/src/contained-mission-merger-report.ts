// Comparison report for the shadow merger (merger design §4.3): classifies each PR's shadow decisions against what really happened.
// Read-only by construction: it receives a `prepare` that must only ever see SELECT statements (checked on every call), and it renders
// ids, hashes, counts and fixed codes only. It states no conclusion about enabling real merges (that is a later ADR).

export interface ReportDb { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } }

export const REPORT_CATEGORIES = [
  'merged_other_head', 'merged_unobserved', 'agree_merge', 'merged_while_refused', 'merged_unevaluated',
  'closed_expired', 'closed_unobserved', 'would_merge_closed', 'closed_unevaluated', 'agree_no_merge',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

const SCAN_INTERVAL_MS = 5 * 60_000;
const CLOSED_WINDOW_MS = 15 * 60_000;
const MAX_PRS = 500;

interface Decision { seq: number; mission_id: string; observation_seq: number; head_sha: string; verdict: 'would_merge' | 'refused' | 'unevaluated'; codes_json: string; observed_at: number }
interface Outcome {
  seq: number; mission_id: string; observation_seq: number; outcome: 'merged' | 'closed_unmerged' | 'reopened' | 'observation_expired'; head_at_close: string;
  merged_at: string | null; merged_by_actor_id: number | null; merged_by_type: string | null; owner_approved_head: number | null; facts_json: string; observed_at: number; created_at: number;
}
interface Cycle { seq: number; started_at: number; finished_at: number }

export interface ReportPr {
  repository: string; pr_number: number; mission_id: string; category: ReportCategory; ever_would_merge: boolean; head_at_close: string;
  last_decision: { verdict: string; codes: string[] } | null;
  merged_by_class: string | null; merged_by_actor_id: number | null; owner_approved_head: boolean | null;
  /** merged_at minus the observation time of the last would_merge on head_at_close, in ms (reference only: local clock against GitHub's). */
  would_merge_to_merged_ms: number | null;
}
export interface ReportOpenPr { repository: string; pr_number: number; mission_id: string; latest: { verdict: string; head: string; codes: string[]; observed_at: number } | null; decisions: number; ever_would_merge: boolean; reopened: boolean }
export interface MergerReport {
  schema_version: 1; generated_at: number;
  /** No judgement: whether and when to enable real merges, and how many agreeing merges that takes, belong to a later ADR. */
  note: string;
  counts: Record<ReportCategory | 'open', number>;
  ever_would_merge: number;
  prs: ReportPr[]; open: ReportOpenPr[];
  totals: { decisions: number; outcomes: number };
  truncated: boolean;
}

const codesOf = (json: string): string[] => { try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : []; } catch { return []; } };
const factsOf = (json: string): Record<string, unknown> => { try { const v = JSON.parse(json) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; } };

/** `readScopes`: when given, only PRs of Missions in those scopes appear (an RPC caller sees what its read scopes allow); omitted means every scope. */
export function buildMergerReport(rawDb: ReportDb, now: number, readScopes?: readonly string[]): MergerReport {
  // Defence in depth: whatever object is handed in, this module can only run SELECT.
  const db: ReportDb = { prepare: (sql) => { if (!/^\s*SELECT\b/iu.test(sql)) throw new Error('merger_report_read_only'); return rawDb.prepare(sql); } };
  const all = <T>(sql: string, ...p: unknown[]): T[] => db.prepare(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: unknown[]): T | undefined => db.prepare(sql).get(...p) as T | undefined;

  const scoped = readScopes !== undefined;
  const marks = scoped ? readScopes.map(() => '?').join(',') : '';
  const keys = scoped && readScopes.length === 0 ? [] : all<{ repository: string; pr_number: number }>(
    `SELECT w.repository,w.pr_number FROM engineering_merger_shadow_watermarks w ${scoped ? `WHERE EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE m.scope_id IN (${marks}) AND m.mission_id IN (
      SELECT d.mission_id FROM engineering_merger_shadow_decisions d WHERE d.repository=w.repository AND d.pr_number=w.pr_number
      UNION SELECT o.mission_id FROM engineering_merger_shadow_outcomes o WHERE o.repository=w.repository AND o.pr_number=w.pr_number))` : ''}
    ORDER BY w.repository,w.pr_number LIMIT ?`, ...(scoped ? readScopes : []), MAX_PRS + 1);
  let decisionTotal = 0; let outcomeTotal = 0;
  const truncated = keys.length > MAX_PRS;
  const counts = Object.fromEntries([...REPORT_CATEGORIES, 'open'].map((c) => [c, 0])) as MergerReport['counts'];
  const prs: ReportPr[] = []; const open: ReportOpenPr[] = [];
  let everCount = 0;

  /** True when a cycle row in [from,to] lists this PR. */
  const cycleHas = (repo: string, pr: number, from: number, to: number, seq?: number): boolean => one(
    `SELECT 1 AS x FROM engineering_merger_shadow_cycles c WHERE ${seq !== undefined ? 'c.seq=?' : 'c.finished_at>=? AND c.finished_at<=?'} AND EXISTS (SELECT 1 FROM json_each(c.prs_json) j WHERE json_extract(j.value,'$[0]')=? AND json_extract(j.value,'$[1]')=?) LIMIT 1`,
    ...(seq !== undefined ? [seq] : [from, to]), repo, pr) !== undefined;

  for (const key of keys.slice(0, MAX_PRS)) {
    // Rows of Missions outside the caller's scopes stay out even when they share the PR with a visible Mission.
    const only = scoped ? `AND mission_id IN (SELECT mission_id FROM engineering_contained_missions WHERE scope_id IN (${marks}))` : '';
    const sc = scoped ? readScopes : [];
    const decisions = all<Decision>(`SELECT seq,mission_id,observation_seq,head_sha,verdict,codes_json,observed_at FROM engineering_merger_shadow_decisions WHERE repository=? AND pr_number=? ${only} ORDER BY observation_seq`, key.repository, key.pr_number, ...sc);
    const outcomes = all<Outcome>(`SELECT * FROM engineering_merger_shadow_outcomes WHERE repository=? AND pr_number=? ${only} ORDER BY seq`, key.repository, key.pr_number, ...sc);
    decisionTotal += decisions.length; outcomeTotal += outcomes.length;
    const ever = decisions.some((d) => d.verdict === 'would_merge');
    if (ever) everCount += 1;
    const last = outcomes.at(-1);
    const missionId = last?.mission_id ?? decisions.at(-1)?.mission_id ?? '';
    const before = (o: Outcome): Decision | undefined => decisions.filter((d) => d.observation_seq < o.observation_seq).at(-1);

    let category: ReportCategory | null = null;
    let lastDecision: Decision | undefined;
    let facts: Record<string, unknown> = {};
    if (last?.outcome === 'merged') {
      facts = factsOf(last.facts_json);
      lastDecision = before(last);
      // The scan that detected the merge, then the scans before it. The reconciler stamps `cycle_after` (the newest cycle number when the scan began),
      // so the choice follows cycle numbers and not the local clock; outcomes without the stamp fall back to time. The PR is "watched" when it is listed
      // in any of the three scans before, and the service was not down in between (the last of them ends within two scan intervals of this one).
      const after = typeof facts['cycle_after'] === 'number' ? facts['cycle_after'] : null;
      const detect = after !== null
        ? one<Cycle>('SELECT seq,started_at,finished_at FROM engineering_merger_shadow_cycles WHERE seq>? ORDER BY seq LIMIT 1', after)
        : one<Cycle>('SELECT seq,started_at,finished_at FROM engineering_merger_shadow_cycles WHERE finished_at>=? ORDER BY seq LIMIT 1', last.created_at);
      const prior = detect ? all<Cycle>('SELECT seq,started_at,finished_at FROM engineering_merger_shadow_cycles WHERE seq<? ORDER BY seq DESC LIMIT 3', detect.seq) : [];
      const watched = detect !== undefined && prior.length > 0 && detect.started_at - (prior[0] as Cycle).finished_at <= 2 * SCAN_INTERVAL_MS
        && prior.some((c) => cycleHas(key.repository, key.pr_number, c.started_at, c.finished_at, c.seq));
      if (typeof facts['published_head'] === 'string' && facts['published_head'] !== last.head_at_close) category = 'merged_other_head';
      else if (facts['reopen_unobserved'] === true || !watched) category = 'merged_unobserved';
      else if (lastDecision?.head_sha === last.head_at_close && lastDecision.verdict === 'would_merge') category = 'agree_merge';
      else if (lastDecision?.head_sha === last.head_at_close && lastDecision.verdict === 'refused') category = 'merged_while_refused';
      else category = 'merged_unevaluated';
    } else if (last?.outcome === 'observation_expired') {
      category = 'closed_expired';
      lastDecision = before(last);
    } else if (last?.outcome === 'closed_unmerged') {
      lastDecision = before(last);
      if (!lastDecision || !cycleHas(key.repository, key.pr_number, last.observed_at - CLOSED_WINDOW_MS, last.observed_at)) category = 'closed_unobserved';
      else category = lastDecision.verdict === 'would_merge' ? 'would_merge_closed' : lastDecision.verdict === 'unevaluated' ? 'closed_unevaluated' : 'agree_no_merge';
    }

    if (category === null || !last) {
      const latest = decisions.at(-1);
      counts.open += 1;
      open.push({
        repository: key.repository, pr_number: key.pr_number, mission_id: missionId,
        latest: latest ? { verdict: latest.verdict, head: latest.head_sha, codes: codesOf(latest.codes_json), observed_at: latest.observed_at } : null,
        decisions: decisions.length, ever_would_merge: ever, reopened: last?.outcome === 'reopened',
      });
      continue;
    }
    counts[category] += 1;
    const mergedMs = last.merged_at ? Date.parse(last.merged_at) : NaN;
    const wm = decisions.filter((d) => d.verdict === 'would_merge' && d.head_sha === last.head_at_close).at(-1);
    prs.push({
      repository: key.repository, pr_number: key.pr_number, mission_id: missionId, category, ever_would_merge: ever, head_at_close: last.head_at_close,
      last_decision: lastDecision ? { verdict: lastDecision.verdict, codes: codesOf(lastDecision.codes_json) } : null,
      merged_by_class: typeof facts['merged_by_class'] === 'string' ? facts['merged_by_class'] : null,
      merged_by_actor_id: last.merged_by_actor_id,
      owner_approved_head: last.owner_approved_head === null ? null : last.owner_approved_head === 1,
      would_merge_to_merged_ms: wm && Number.isFinite(mergedMs) ? mergedMs - wm.observed_at : null,
    });
  }
  return {
    schema_version: 1, generated_at: now,
    note: 'Shadow evidence only. This report makes no recommendation about enabling real merges; that needs a later ADR.',
    counts, ever_would_merge: everCount, prs, open,
    totals: { decisions: decisionTotal, outcomes: outcomeTotal },
    truncated,
  };
}
