import { describe, expect, it, vi } from 'vitest';
import { APP_E_SANDBOX, executeSandboxAppEMerge, type SandboxAppEPorts, type SandboxMergeObservation } from './contained-mission-sandbox-app-e.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), squash = 'c'.repeat(40);
const binding = { repository: APP_E_SANDBOX.repository, repositoryId: APP_E_SANDBOX.repositoryId,
  pr: 31, branch: 'osstack/mission/fixture', head, base };
const handoff = { id: 'existing-grok-record', binding, expiresAt: 200 };
function fixture() {
  const observation: SandboxMergeObservation = {
    binding: { ...binding }, complete: true, open: true, draft: false, publisherId: APP_E_SANDBOX.publisherId,
    headRepositoryId: APP_E_SANDBOX.repositoryId, baseRef: 'main', baseTip: base, mergeable: true,
    reviewDecision: 'APPROVED', labels: ['verified'], blockers: [], unresolvedThreads: 0, currentChangesRequested: false,
    watcher: { userId: 243772068, type: 'User', state: 'APPROVED', head, counted: true },
    quality: { id: 26575831, active: true, appliesToMain: true, bypassActors: [], requiredChecksEnforced: true,
      approvalEnforced: true, threadsEnforced: true, lastPushApprovalEnforced: true },
    update: { id: 26577634, active: true, appliesToMain: true, restrictsUpdates: true,
      bypassActors: [{ actorId: 5620091, actorType: 'Integration', mode: 'pull_request' }] },
  };
  const reservations = new Set<string>();
  const ports = {
    now: () => 100,
    authenticateHandoff: vi.fn(async () => true),
    observe: vi.fn(async () => structuredClone(observation)),
    verifyCurrentPublicationAndCi: vi.fn(async () => true),
    reserveOnce: vi.fn(async (key: string) => {
      if (reservations.has(key)) return false;
      reservations.add(key); return true;
    }),
    merge: vi.fn(async () => ({ merged: true, sha: squash })),
    readback: vi.fn(async () => ({ binding: { ...binding }, merged: true, actorAppId: 5620091,
      actorType: 'Bot', actorVerified: true, actorUserId: 352681958, sha: squash, parents: [base] })),
  } satisfies SandboxAppEPorts;
  return { ports, observation };
}

describe('independent sandbox App E', () => {
  it('sends only expected-head squash and verifies readback', async () => {
    const { ports } = fixture();
    expect(await executeSandboxAppEMerge(handoff, ports)).toEqual({ kind: 'merged', sha: squash });
    expect(ports.merge).toHaveBeenCalledExactlyOnceWith({ appId: 5620091, installationId: 178742757,
      repository: binding.repository, pr: binding.pr, sha: head, merge_method: 'squash' });
  });
  it.each([
    ['foreign repository', { ...handoff, binding: { ...binding, repository: 'owner/production' } }],
    ['foreign ID', { ...handoff, binding: { ...binding, repositoryId: 1 } }],
    ['unbound extra authority', { ...handoff, approved: true }],
    ['invalid PR', { ...handoff, binding: { ...binding, pr: -1 } }],
    ['expired', { ...handoff, expiresAt: 100 }],
  ])('refuses %s before any write', async (_name, input) => {
    const { ports } = fixture();
    expect((await executeSandboxAppEMerge(input, ports)).kind).toBe('refused');
    expect(ports.merge).not.toHaveBeenCalled();
  });
  const failures: [string, (s: SandboxMergeObservation) => void][] = [
    ['head moved', s => { s.binding.head = squash; }],
    ['PR swapped', s => { s.binding.pr++; }],
    ['base moved', s => { s.baseTip = squash; }],
    ['fork', s => { s.headRepositoryId = 1; }],
    ['publisher', s => { s.publisherId = 1; }],
    ['closed', s => { s.open = false; }],
    ['draft', s => { s.draft = true; }],
    ['incomplete pagination', s => { s.complete = false; }],
    ['conflict', s => { s.mergeable = false; }],
    ['missing label', s => { s.labels = []; }],
    ['blocker', s => { s.blockers = ['hold']; }],
    ['thread', s => { s.unresolvedThreads = 1; }],
    ['changes requested', s => { s.currentChangesRequested = true; }],
    ['uncounted', s => { s.watcher.counted = false; }],
    ['old approval', s => { s.watcher.head = base; }],
    ['wrong watcher', s => { s.watcher.userId = 1; }],
    ['App approval', s => { s.watcher.type = 'Bot'; }],
    ['dismissed', s => { s.watcher.state = 'DISMISSED'; }],
    ['GitHub approval missing', s => { s.reviewDecision = 'REVIEW_REQUIRED'; }],
    ['quality bypass', s => { s.quality.bypassActors = [5620091]; }],
    ['quality disabled', s => { s.quality.active = false; }],
    ['quality not applicable', s => { s.quality.appliesToMain = false; }],
    ['checks unenforced', s => { s.quality.requiredChecksEnforced = false; }],
    ['approval unenforced', s => { s.quality.approvalEnforced = false; }],
    ['threads unenforced', s => { s.quality.threadsEnforced = false; }],
    ['last push unenforced', s => { s.quality.lastPushApprovalEnforced = false; }],
    ['update disabled', s => { s.update.active = false; }],
    ['unrestricted update', s => { s.update.restrictsUpdates = false; }],
    ['publisher bypass', s => { s.update.bypassActors = [{ actorId: 5620012, actorType: 'Integration', mode: 'pull_request' }]; }],
    ['always bypass', s => { s.update.bypassActors[0]!.mode = 'always'; }],
    ['extra bypass', s => { s.update.bypassActors = [...s.update.bypassActors, { actorId: 1, actorType: 'RepositoryRole', mode: 'always' }]; }],
  ];
  it.each(failures)('refuses %s', async (_name, mutate) => {
    const { ports, observation } = fixture(); mutate(observation);
    expect((await executeSandboxAppEMerge(handoff, ports)).kind).toBe('refused');
    expect(ports.merge).not.toHaveBeenCalled();
  });
  it('rejects historical CI success when current attempt is pending', async () => {
    const { ports } = fixture();
    ports.verifyCurrentPublicationAndCi.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await executeSandboxAppEMerge(handoff, ports)).kind).toBe('refused');
    expect(ports.merge).not.toHaveBeenCalled();
  });
  it('rechecks moved reviews after reservation', async () => {
    const { ports, observation } = fixture();
    ports.reserveOnce.mockImplementation(async () => { observation.watcher.head = base; return true; });
    expect((await executeSandboxAppEMerge(handoff, ports)).kind).toBe('refused');
    expect(ports.merge).not.toHaveBeenCalled();
  });
  it('requires authenticated handoff, including revocation after reservation', async () => {
    const { ports } = fixture(); ports.authenticateHandoff.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await executeSandboxAppEMerge(handoff, ports)).kind).toBe('refused');
    expect(ports.merge).not.toHaveBeenCalled();
  });
  it('retains durable reservation after timeout, including different handoff IDs', async () => {
    const { ports } = fixture(); ports.merge.mockRejectedValue(Error('timeout'));
    expect(await executeSandboxAppEMerge(handoff, ports)).toEqual({ kind: 'unknown' });
    expect(await executeSandboxAppEMerge({ ...handoff, id: 'replacement' }, ports)).toEqual({ kind: 'refused', reason: 'already_reserved' });
    expect(ports.merge).toHaveBeenCalledTimes(1);
  });
  it('allows one write across concurrent invocations', async () => {
    const { ports } = fixture();
    const results = await Promise.all([executeSandboxAppEMerge(handoff, ports), executeSandboxAppEMerge(handoff, ports)]);
    expect(results.map(r => r.kind).sort()).toEqual(['merged', 'refused']);
    expect(ports.merge).toHaveBeenCalledTimes(1);
  });
  it.each(['actor', 'sha', 'parent', 'binding', 'identity'] as const)('does not claim merge for bad readback %s', async field => {
    const { ports } = fixture(); const back = await ports.readback();
    if (field === 'actor') back.actorAppId = 5620012;
    if (field === 'sha') back.sha = base;
    if (field === 'parent') back.parents = [head];
    if (field === 'binding') back.binding.pr++;
    if (field === 'identity') back.actorVerified = false;
    ports.readback.mockResolvedValue(back);
    expect(await executeSandboxAppEMerge(handoff, ports)).toEqual({ kind: 'unknown' });
  });
  it('fails closed on read failure without leaking errors', async () => {
    const { ports } = fixture(); ports.observe.mockRejectedValue(Error('private transport details'));
    expect(await executeSandboxAppEMerge(handoff, ports)).toEqual({ kind: 'refused', reason: 'evidence_unavailable' });
  });
});
