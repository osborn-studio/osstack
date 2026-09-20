import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@osstack/agents';
import { loadLocalGraphRegistration } from './graph-rpc.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-host-config-')); roots.push(root);
  const path = join(root, 'host.json');
  const scope = { schemaVersion: 1, tenantId: 'local', principalId: 'owner', workspaceId: 'repo' };
  const config = { schemaVersion: 1, registration: { id: 'local-owner', scope, repositoryRef: 'repo', repositoryPath: root,
    taskRef: 'task', task: 'trusted task', inputArtifactRef: 'input', writer: { agentId: 'writer', capabilityId: 'write' }, reviewer: { agentId: 'reviewer', capabilityId: 'review' },
    acceptanceRegistry: [{ ref: 'test', command: 'node --version', passExitCodes: [0], failExitCodes: [1] }],
    grant: { scope, expiresAt: Date.now() + 60000, operations: ['read', 'execute', 'cancel', 'resume'] } } };
  const adapter = (id: string): AgentAdapter => ({ id, display_name: id, cost_tier: 'low', capabilities: () => [], isAvailable: async () => ({ available: true, last_checked_at: 0 }), invoke: () => { throw Error('NO_EXECUTION_EXPECTED'); } });
  const adapters = new Map([['writer', adapter('writer')], ['reviewer', adapter('reviewer')]]);
  const save = () => writeFileSync(path, JSON.stringify(config), { mode: 0o600 }); save();
  return { path, config, adapters, save };
}
it('requires owner-only regular config and rejects symlink aliases', async () => {
  const f = fixture(); expect((await loadLocalGraphRegistration(f.path, f.adapters)).product).toBe('osstack');
  chmodSync(f.path, 0o644); await expect(loadLocalGraphRegistration(f.path, f.adapters)).rejects.toThrow('GRAPH_CONFIG_OWNER_REQUIRED');
  chmodSync(f.path, 0o600); const alias = `${f.path}.link`; symlinkSync(f.path, alias);
  await expect(loadLocalGraphRegistration(alias, f.adapters)).rejects.toThrow();
});
it('honors expiry, lets the original owner observe/cancel and accepts a same-binding grant renewal', async () => {
  const f = fixture(); const registration = await loadLocalGraphRegistration(f.path, f.adapters);
  f.config.registration.grant.expiresAt = 1; f.save();
  expect(() => registration.authorize('execute')).toThrow('GRANT_EXPIRED');
  expect(() => registration.authorize('resume')).toThrow('GRANT_EXPIRED');
  expect(() => registration.authorize('read')).not.toThrow(); expect(() => registration.authorize('cancel')).not.toThrow();
  await expect(registration.delivery.verifyReviewer({ writerIdentity: 'writer', reviewerIdentity: 'reviewer', adapterId: 'reviewer', capabilityId: 'review' })).resolves.toBeUndefined();
  const restarted = await loadLocalGraphRegistration(f.path, f.adapters);
  expect(() => restarted.authorize('read')).not.toThrow(); expect(() => restarted.authorize('execute')).toThrow('GRANT_EXPIRED');
  f.config.registration.grant.expiresAt = Date.now() + 60000; f.save();
  expect(() => registration.authorize('resume')).not.toThrow();
  f.config.registration.task = 'different business task'; f.save();
  expect(() => registration.authorize('execute')).toThrow('GRANT_EXPIRED');
});
it('does not accept renewed grants for another authorization domain or missing operation', async () => {
  const f = fixture(); const registration = await loadLocalGraphRegistration(f.path, f.adapters);
  f.config.registration.grant = { ...f.config.registration.grant, scope: { ...f.config.registration.scope, principalId: 'other' } }; f.save();
  expect(() => registration.authorize('read')).toThrow('GRANT_EXPIRED');
  f.config.registration.grant = { ...f.config.registration.grant, scope: f.config.registration.scope, operations: ['read'] }; f.save();
  expect(() => registration.authorize('read')).not.toThrow(); expect(() => registration.authorize('cancel')).toThrow('GRANT_EXPIRED');
});
function boundedFixture() {
  const f = fixture();
  const config = { ...f.config, registration: { ...f.config.registration,
    writer: { agentId: 'anthropic-bounded-writer', capabilityId: 'anthropic-bounded-writer.writer' },
    reviewer: { agentId: 'anthropic-bounded-reviewer', capabilityId: 'anthropic-bounded-reviewer.reviewer' },
    boundedMessages: { model: 'test-model', files: ['answer'], acceptance: 'Answer must be 1' } } };
  const save = () => writeFileSync(f.path, JSON.stringify(config), { mode: 0o600 }); save();
  return { ...f, config, save };
}
it('explicit owner config enrolls two separate bounded roles without a CLI credential fallback', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', ''); const f = boundedFixture();
  const registration = await loadLocalGraphRegistration(f.path, new Map());
  const { writer, reviewer } = registration.delivery;
  expect(writer.adapter.id).toBe('anthropic-bounded-writer'); expect(reviewer.adapter.id).toBe('anthropic-bounded-reviewer');
  expect(writer.adapter).not.toBe(reviewer.adapter); expect(typeof writer.adapter.confirmStopped).toBe('function');
  expect(await writer.adapter.isAvailable()).toMatchObject({ available: false, status: 'not_authenticated' });
  f.config.registration.boundedMessages.acceptance = 'silently changed task'; f.save();
  expect(() => registration.authorize('execute')).toThrow('GRANT_EXPIRED');
});
it('fails closed for mismatched bounded identities and host path expansion', async () => {
  const f = boundedFixture(); f.config.registration.writer.agentId = 'claude-code'; f.save();
  await expect(loadLocalGraphRegistration(f.path, new Map())).rejects.toThrow('GRAPH_BOUNDED_IDENTITIES_REQUIRED');
  f.config.registration.writer.agentId = 'anthropic-bounded-writer'; f.config.registration.boundedMessages.files = ['../secrets']; f.save();
  await expect(loadLocalGraphRegistration(f.path, new Map())).rejects.toThrow('BOUNDED_OPTIONS_INVALID');
});
it.each(['apiKey', 'fetch', 'endpoint', 'command'])('never accepts %s as backend config', async field => {
  const f = boundedFixture(); Object.assign(f.config.registration.boundedMessages, { [field]: 'untrusted' }); f.save();
  await expect(loadLocalGraphRegistration(f.path, new Map())).rejects.toThrow();
});
