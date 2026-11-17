import { describe, expect, it } from 'vitest';
import { MissionDecideRequest } from './mission-decide.js';

const base = { credential: 'c'.repeat(32), mission_id: 'cm_00000000-0000-4000-8000-000000000000', decision: 'abandon' };

describe('MissionDecideRequest', () => {
  it('accepts an optional bounded decision ID and positive expected revision', () => {
    expect(MissionDecideRequest.safeParse(base).success).toBe(true);
    expect(MissionDecideRequest.safeParse({ ...base, decision_id: 'client:1', expected_revision: 2 }).success).toBe(true);
    for (const input of [{ decision_id: '!bad' }, { decision_id: 'x'.repeat(129) }, { expected_revision: 0 }, { expected_revision: 1.5 }]) {
      expect(MissionDecideRequest.safeParse({ ...base, ...input }).success).toBe(false);
    }
  });
});
