// The PR a contained Mission opened, read from its ledger events (W11 publication, bridge phase 3). Read-only and
// dependency-light: the host's status view and the bridge shadow reconciler both use it.
import type { ContainedMissionStore } from '@osstack/core';
import { redactSecrets } from '@osstack/governance';

const EVIDENCE_PAGE = 20; const EVIDENCE_PAGES = 10;
type PrRef = { number: number; url: string; reused: boolean };
export type MissionPublication =
  | { kind: 'opened'; pr: PrRef; evidence_digest: string; pushed_commit: string; base_head: string | null }
  | { kind: 'github_ci_opened'; pr: PrRef; evidence_digest: string; pushed_commit: string; base_head: string | null }
  | { kind: 'opened_before_cancel'; pr: PrRef; pushed_commit: string | null; base_head: string | null }
  | { kind: 'evidence_missing'; pr: PrRef; evidence_digest: string };

/** The PR this Mission opened, read by event kind so it never depends on the bounded event tail. Only reads `store.db`. */
export function readMissionPublication(store: Pick<ContainedMissionStore, 'db'>, missionId: string): MissionPublication | null {
  const last = (kind: string, beforeSeq = Number.MAX_SAFE_INTEGER) => store.db.prepare(
    'SELECT seq,payload_json FROM engineering_contained_events WHERE mission_id=? AND kind=? AND seq<? ORDER BY seq DESC LIMIT 1')
    .get(missionId, kind, beforeSeq) as { seq: number; payload_json: string } | undefined;
  // Parse the stored JSON and redact only the strings returned: redacting the raw payload can break the JSON.
  const text = (x: unknown) => typeof x === 'string' ? redactSecrets(x) : null;
  const prRef = (x: unknown): PrRef => { const r = (x ?? {}) as Record<string, unknown>; return { number: Number(r['number']), url: text(r['url']) ?? '', reused: r['reused'] === true }; };
  const evidenceOf = (row: { payload_json: string }) => { const e = JSON.parse(row.payload_json) as Record<string, unknown>; return { head: text(e['head']), base_head: text(e['base_head']), digest: e['evidence_digest'] }; };
  const opened = last('pr_opened');
  if (opened) {
    const p = JSON.parse(opened.payload_json) as { pr: unknown; evidence_digest: unknown; verification_kind?: unknown };
    const githubCi = p.verification_kind === 'github_actions';
    const evidenceKind = githubCi ? 'ci_delivery_evidence' : 'delivery_evidence';
    const digest = text(p.evidence_digest) ?? '';
    // delivery_evidence is recorded just before pr_opened; look back a bounded number of pages.
    let before = opened.seq; let match: ReturnType<typeof evidenceOf> | undefined;
    for (let page = 0; page < EVIDENCE_PAGES && !match; page++) {
      const rows = store.db.prepare("SELECT seq,payload_json FROM engineering_contained_events WHERE mission_id=? AND kind=? AND seq<? ORDER BY seq DESC LIMIT ?")
        .all(missionId, evidenceKind, before, EVIDENCE_PAGE) as Array<{ seq: number; payload_json: string }>;
      match = rows.map(evidenceOf).find(e => e.digest === p.evidence_digest);
      if (rows.length < EVIDENCE_PAGE) break;
      before = rows.at(-1)!.seq;
    }
    return match?.head
      ? { kind: githubCi ? 'github_ci_opened' : 'opened', pr: prRef(p.pr), evidence_digest: digest, pushed_commit: match.head, base_head: match.base_head }
      : { kind: 'evidence_missing', pr: prRef(p.pr), evidence_digest: digest };
  }
  const cancelled = last('pr_opened_before_cancel');
  if (!cancelled) return null;
  const facts = JSON.parse(cancelled.payload_json) as { pr: unknown; verification_kind?: unknown };
  const prior = last(facts.verification_kind === 'github_actions' ? 'ci_delivery_evidence' : 'delivery_evidence', cancelled.seq);
  const evidence = prior ? evidenceOf(prior) : undefined;
  return { kind: 'opened_before_cancel', pr: prRef(facts.pr), pushed_commit: evidence?.head ?? null, base_head: evidence?.base_head ?? null };
}
