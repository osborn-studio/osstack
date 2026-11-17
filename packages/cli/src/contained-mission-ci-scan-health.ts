// Scan health is observation-only. It never changes Mission or CI chain state.
import type Database from 'better-sqlite3';
import type { ContainedMissionStore } from '@osstack/core';
import { z } from 'zod';
import type { CiReadFailureReason } from './contained-mission-local-failure-reader.js';

const reason = z.enum(['network', 'auth', 'rate_limited', 'incomplete_read', 'unexpected_response']);
const step = z.enum(['pr_read', 'held_push_ref_read', 'ci_jobs_read', 'merge_readback', 'scan']);
export type CiScanStep = z.infer<typeof step>;
const integer = z.number().int().nonnegative().safe();
const binding = { pr: integer.positive(), head: z.string().regex(/^[a-f0-9]{40}$/) };
const failureSchema = z.object({ reason, step, consecutive: integer.positive(), since: integer, ...binding }).strict();
const recoverySchema = z.object({ failed_since: integer, consecutive: integer.positive(), ...binding }).strict();
type Streak = { reason: CiReadFailureReason; step: CiScanStep; consecutive: number; since: number };

export function shouldRecordCiScanFailure(previousRecorded: Pick<Streak, 'reason' | 'step'> | null, next: Pick<Streak, 'reason' | 'step' | 'consecutive'>): boolean {
  const n = next.consecutive;
  return n === 1 || previousRecorded?.reason !== next.reason || previousRecorded?.step !== next.step
    || (n <= 64 && n > 0 && (n & (n - 1)) === 0) || (n > 64 && n % 120 === 0);
}

export function readCiScanHealth(db: Database.Database, missionId: string): (Streak & { failing: true; recorded_at: number }) | null {
  const event = db.prepare("SELECT kind,payload_json,created_at FROM engineering_contained_events WHERE mission_id=? AND kind IN ('ci_scan_failed','ci_scan_recovered') ORDER BY seq DESC LIMIT 1")
    .get(missionId) as { kind: string; payload_json: string; created_at: number } | undefined;
  if (event?.kind !== 'ci_scan_failed') return null;
  let value: unknown;
  try { value = JSON.parse(event.payload_json); } catch { return null; }
  const parsed = failureSchema.safeParse(value);
  if (!parsed.success) return null;
  const { reason, step, since, consecutive } = parsed.data;
  return { failing: true, reason, step, since, consecutive, recorded_at: event.created_at };
}

/** Counts resume from the last recorded event after restart. Consecutive is therefore
 * a lower bound across restarts; within one process recovery records the full count. */
export function createCiScanHealth(store: ContainedMissionStore, now: () => number) {
  const streaks = new Map<string, { current: Streak; recorded: Streak } | null>();
  const get = (missionId: string) => {
    if (!streaks.has(missionId)) {
      const prior = readCiScanHealth(store.db, missionId);
      streaks.set(missionId, prior ? { current: prior, recorded: prior } : null);
    }
    return streaks.get(missionId) ?? null;
  };
  return {
    failed(missionId: string, facts: { reason: CiReadFailureReason; step: CiScanStep; pr: number; head: string }): void {
      const previous = get(missionId);
      const at = now();
      const next = failureSchema.parse({ reason: facts.reason, step: facts.step, pr: facts.pr, head: facts.head, consecutive: (previous?.current.consecutive ?? 0) + 1, since: previous?.current.since ?? at });
      const record = shouldRecordCiScanFailure(previous?.recorded ?? null, next);
      if (record) store.record(missionId, 'ci_scan_failed', next, at);
      streaks.set(missionId, { current: next, recorded: record ? next : previous!.recorded });
    },
    succeeded(missionId: string, facts: { pr: number; head: string }): void {
      const previous = get(missionId);
      if (!previous) return;
      const payload = recoverySchema.parse({ pr: facts.pr, head: facts.head, failed_since: previous.current.since, consecutive: previous.current.consecutive });
      store.record(missionId, 'ci_scan_recovered', payload, now());
      streaks.set(missionId, null);
    },
  };
}
