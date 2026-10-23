import type { HomeObservation } from './home-inventory.js';

export function upgradeFixture() {
  const now = 100000; const id = (n: number) => `home_${String(n).padStart(32, '0')}`;
  const observations: HomeObservation[] = [1, 2].map(n => ({ desired: { home_id: id(n), socket: `/home-${n}/socket`, enabled: true, desired: { version: '2.0.0' } },
    observed: { schema_version: 1, home_id: id(n), generation: `instance_${String(n).padStart(32, '0')}`, version: '1.0.0',
      protocol_version: 1, database_schema: 40, started_at_ms: 1, deployment_kind: 'npm', build_digest: 'a'.repeat(64), build_evidence: 'host_manifest' },
    observed_at_ms: now, status: 'drift', reason: null }));
  const request = { schema_version: 1, expires_at_ms: now + 200000,
    target: { version: '2.0.0', build_digest: 'b'.repeat(64), protocol_version: 2, database_schema: 41, readable_schema_min: 40, readable_schema_max: 41 },
    budget: { max_total_ms: 100000, max_step_ms: 5000, max_steps: 32 },
    groups: [{ group_id: 'group', installation_id: 'shared-npm-global', deployment_kind: 'npm', home_ids: observations.map(o => o.desired.home_id) }] };
  return { request, observations, now };
}
