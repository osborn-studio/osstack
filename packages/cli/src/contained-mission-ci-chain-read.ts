// Read-only CI chain projection. The event sequence, not the bounded status tail, is authoritative.
import type Database from 'better-sqlite3';
import type { ContainedMission } from '@osstack/core';
import { readCiScanHealth, type CiScanStep } from './contained-mission-ci-scan-health.js';
import type { CiReadFailureReason } from './contained-mission-local-failure-reader.js';
import { readMissionPublication } from './contained-mission-publication.js';

type Event = { seq: number; kind: string; created_at: number; payload_json: string };
export type CiChainState = 'initial_ci_waiting' | 'repair_permission_waiting' | 'repair_in_progress' | 'repair_ci_waiting' | 'approval_and_handoff_waiting' | 'merge_reserved' | 'merge_reconciling' | 'merge_held' | 'closed' | 'stopped' | 'result_unknown';
export interface CiChainRow {
  mission_id: string; scope_id: string; repository: string; pr: number; state: CiChainState; since: number;
  head_before: string | null; head_after: string | null; merge_commit_sha: string | null; stop_reason: string | null;
  repair_refused?: { reason: string; holder: string; since: number };
  scan?: { failing: true; reason: CiReadFailureReason; step: CiScanStep; since: number; consecutive: number };
  reason?: string; head?: string; app_id?: number; handoff_comment_id?: number;
}
const payload = (event: Event | undefined): Record<string, unknown> => {
  if (!event) return {};
  try { return JSON.parse(event.payload_json) as Record<string, unknown>; } catch { return {}; }
};
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function readCiChain(db: Database.Database, mission: ContainedMission): CiChainRow | null {
  const publication = readMissionPublication({ db }, mission.mission_id);
  if (publication?.kind !== 'github_ci_opened') return null;
  const events = db.prepare('SELECT seq,kind,created_at,payload_json FROM engineering_contained_events WHERE mission_id=? ORDER BY seq')
    .all(mission.mission_id) as Event[];
  const last = (kind: string) => [...events].reverse().find(event => event.kind === kind);
  const dispatch = last('ci_repair_dispatched');
  const childId = string(payload(dispatch)['child']);
  const child = childId ? db.prepare('SELECT * FROM engineering_contained_missions WHERE mission_id=?').get(childId) as ContainedMission | undefined : undefined;
  const childEvents = child ? db.prepare('SELECT seq,kind,created_at,payload_json FROM engineering_contained_events WHERE mission_id=? ORDER BY seq')
    .all(child.mission_id) as Event[] : [];
  const childLast = (kind: string) => [...childEvents].reverse().find(event => event.kind === kind);
  // halt() persists its reason in the halted event, not in the mission row.
  const childPermissionWaiting = child?.state === 'awaiting_decision'
    && string(payload(childLast('halted'))['reason']) === 'publication_pending'
    && !childLast('ci_repair_approval') && !childLast('ci_repair_push_intent');
  const repaired = child ? readMissionPublication({ db }, child.mission_id) : null;
  const headAfter = repaired?.kind === 'github_ci_opened' ? repaired.pushed_commit : null;
  const merged = last('ci_pr_merged_observed');
  const held = last('ci_pr_merge_unverified');
  const reserved = last('ci_app_e_merge_reserved');
  const released = last('ci_app_e_merge_released');
  const closedUnmerged = last('ci_closed_unmerged');
  const failure = last('ci_failure_observed');
  const repairFailed = last('ci_repair_failed');
  const repairVerified = last('ci_repair_verified');
  const initialVerified = last('ci_initial_verified');
  const waiting = last('ci_repair_verification_waiting') ?? last('ci_initial_verification_waiting');
  let marker: Event | undefined;
  let state: CiChainState;
  if (merged) { marker = merged; state = 'closed'; }
  else if (closedUnmerged) { marker = closedUnmerged; state = 'stopped'; }
  else if (held) { marker = held; state = 'merge_held'; }
  else if (released) { marker = released; state = 'merge_reconciling'; }
  else if (reserved) { marker = reserved; state = 'merge_reserved'; }
  else if (repairVerified && (!waiting || repairVerified.created_at >= waiting.created_at) && (!repairFailed || repairVerified.created_at >= repairFailed.created_at)) { marker = repairVerified; state = 'approval_and_handoff_waiting'; }
  else if (initialVerified && (!waiting || initialVerified.created_at >= waiting.created_at)) { marker = initialVerified; state = 'approval_and_handoff_waiting'; }
  else if (repairFailed && (!waiting || repairFailed.created_at >= waiting.created_at)) { marker = repairFailed; state = 'stopped'; }
  else if (headAfter || childLast('ci_repair_push_confirmed')) { marker = waiting?.kind === 'ci_repair_verification_waiting' && repairVerified && waiting.created_at > repairVerified.created_at
    ? waiting : childLast('ci_repair_push_confirmed') ?? dispatch; state = 'repair_ci_waiting'; }
  else if (dispatch && !child) { marker = dispatch; state = 'result_unknown'; }
  else if (childLast('ci_repair_approval')) { marker = childLast('ci_repair_approval'); state = 'repair_in_progress'; }
  else if (dispatch || failure) { marker = failure ?? dispatch; state = 'repair_permission_waiting'; }
  else { marker = waiting?.kind === 'ci_initial_verification_waiting' && initialVerified && waiting.created_at > initialVerified.created_at
    ? waiting : last('pr_opened'); state = 'initial_ci_waiting'; }
  // A child waiting only for push permission can continue when permission arrives.
  if (!merged && !reserved && !released && !held && child && ['cancelled', 'abandoned', 'failed', 'stop_unknown', 'needs_reconciliation', 'awaiting_decision'].includes(child.state)) {
    state = childPermissionWaiting ? 'repair_permission_waiting' : 'stopped'; marker = childEvents.at(-1) ?? dispatch;
  }
  // Neither CI verification event records approval or handoff observation.
  const reason = state === 'approval_and_handoff_waiting'
    ? 'CI is green; waiting for Watcher approval and Merger handoff. Approval has no separate ledger event.'
    : state === 'repair_permission_waiting' && childPermissionWaiting ? 'publication_pending'
    : string(payload(marker)['reason']) ?? (state === 'repair_ci_waiting' && waiting?.kind === 'ci_repair_verification_waiting'
    ? string(payload(waiting)['reason']) : null) ?? (state === 'stopped' ? repairFailed ? 'repair_ci_failed' : child?.state ?? 'pr_closed_unmerged' : state === 'result_unknown' ? 'repair_child_missing' : null);
  const spec = JSON.parse(mission.spec_json) as { publication?: { repository?: string } };
  const mergedFacts = payload(merged);
  const heldFacts = payload(held);
  const reservedFacts = payload(reserved);
  const binding = reservedFacts['binding'] as Record<string, unknown> | undefined;
  const health = readCiScanHealth(db, mission.mission_id);
  const scan = health ? { failing: true as const, reason: health.reason, step: health.step, since: health.since, consecutive: health.consecutive } : undefined;
  const refused = state === 'repair_permission_waiting' && !dispatch ? last('ci_repair_dispatch_refused') : undefined;
  const refusal = payload(refused);
  return {
    ...(refused && failure && refused.seq >= failure.seq && typeof refusal?.['reason'] === 'string' && typeof refusal['holder'] === 'string'
      ? { repair_refused: { reason: refusal['reason'], holder: refusal['holder'], since: refused.created_at } } : {}),
    ...(scan ? { scan } : {}),
    mission_id: mission.mission_id, scope_id: mission.scope_id, repository: spec.publication?.repository ?? '',
    pr: state === 'closed' ? number(mergedFacts['pr']) ?? publication.pr.number
      : state === 'merge_held' ? number(heldFacts['pr']) ?? publication.pr.number
      : state === 'merge_reserved' || state === 'merge_reconciling' ? number(binding?.['pr']) ?? publication.pr.number
      : publication.pr.number,
    state, since: marker?.created_at ?? mission.created_at, head_before: publication.pushed_commit, head_after: headAfter,
    merge_commit_sha: string(mergedFacts['merge_commit_sha']), stop_reason: state === 'stopped' || state === 'merge_held' || state === 'result_unknown' ? reason : null,
    ...(reason ? { reason } : {}),
    ...(state === 'closed' || state === 'merge_held' || state === 'merge_reserved' || state === 'merge_reconciling'
      ? { head: string(mergedFacts['head'] ?? heldFacts['head'] ?? binding?.['head']) ?? publication.pushed_commit } : {}),
    ...(number(mergedFacts['app_id']) ? { app_id: number(mergedFacts['app_id'])! } : {}),
    ...(number(mergedFacts['handoff_comment_id']) ? { handoff_comment_id: number(mergedFacts['handoff_comment_id'])! } : {}),
  };
}

export function listCiChains(db: Database.Database, readScopes: readonly string[], scope?: string): CiChainRow[] {
  if (scope && !readScopes.includes(scope)) throw Error('permission_denied');
  if (readScopes.length === 0) throw Error('permission_denied');
  const rows = db.prepare("SELECT * FROM engineering_contained_missions WHERE json_extract(spec_json,'$.verification_mode')='github_actions' AND json_type(spec_json,'$.ci_repair') IS NULL ORDER BY created_at DESC,mission_id DESC")
    .all() as ContainedMission[];
  return rows.filter(row => readScopes.includes(row.scope_id) && (!scope || row.scope_id === scope))
    .flatMap(row => { const chain = readCiChain(db, row); return chain ? [chain] : []; });
}

export function computeCiChainStats(db: Database.Database) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name='engineering_contained_missions'").get();
  if (!hasTable) return { ci_chain_scan_failing: 0, ci_chain_scan_failing_by_reason: [], ci_chain_available: false, ci_chain_by_state: [], ci_chain_closed: 0, ci_chain_repaired_closed: 0,
    ci_chain_consecutive_normal_closed: 0, ci_chain_registration_to_close_ms: [] };
  const scopes = db.prepare('SELECT DISTINCT scope_id FROM engineering_contained_missions').all() as Array<{ scope_id: string }>;
  const chains = scopes.length ? listCiChains(db, scopes.map(row => row.scope_id)) : [];
  const counts = new Map<string, number>();
  const scanReasons = new Map<string, number>();
  let scanFailing = 0;
  const durations: Array<{ mission_id: string; duration_ms: number | null }> = [];
  let closed = 0; let repairedClosed = 0; let consecutive = 0; let streakOpen = true;
  for (const chain of chains) {
    if (chain.scan) { scanFailing++; scanReasons.set(chain.scan.reason, (scanReasons.get(chain.scan.reason) ?? 0) + 1); }
    counts.set(chain.state, (counts.get(chain.state) ?? 0) + 1);
    if (chain.state === 'closed') {
      closed++;
      const failed = db.prepare("SELECT 1 FROM engineering_contained_events WHERE mission_id=? AND kind='ci_failure_observed' LIMIT 1").get(chain.mission_id);
      const repaired = db.prepare("SELECT 1 FROM engineering_contained_events WHERE mission_id=? AND kind='ci_repair_verified' LIMIT 1").get(chain.mission_id);
      if (failed && repaired) repairedClosed++;
      // Historical manual merges also produce merged observations. Only App E
      // readback carries both the application and authenticated handoff IDs.
      const normal = !!chain.merge_commit_sha && (chain.app_id ?? 0) > 0 && (chain.handoff_comment_id ?? 0) > 0;
      if (!normal) streakOpen = false;
      if (streakOpen) consecutive++;
      const opened = db.prepare("SELECT created_at FROM engineering_contained_events WHERE mission_id=? AND kind='ci_pilot_root_bound' ORDER BY seq LIMIT 1").get(chain.mission_id) as { created_at: number } | undefined;
      durations.push({ mission_id: chain.mission_id, duration_ms: opened && chain.since >= opened.created_at ? chain.since - opened.created_at : null });
    } else streakOpen = false;
  }
  return { ci_chain_scan_failing: scanFailing,
    ci_chain_scan_failing_by_reason: [...scanReasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => a.reason.localeCompare(b.reason)),
    ci_chain_available: true, ci_chain_by_state: [...counts].map(([state, count]) => ({ state, count })).sort((a,b) => a.state.localeCompare(b.state)),
    ci_chain_closed: closed, ci_chain_repaired_closed: repairedClosed, ci_chain_consecutive_normal_closed: consecutive,
    ci_chain_registration_to_close_ms: durations };
}

export type CiChainStats = ReturnType<typeof computeCiChainStats>;
