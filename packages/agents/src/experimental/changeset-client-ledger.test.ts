import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDb } from '@osstack/core/dist/state/db.js';
import { GraphRunStore } from '@osstack/core/dist/state/graph-runs.js';
import { GraphActionStore } from '@osstack/core/dist/state/graph-actions.js';
import { GraphAdmissionStore } from '@osstack/core/graph-recovery';
import { changesetPolicyDigest } from './changeset.js';
import { createChangesetProposalClient, type PreparedChangesetRequest } from './changeset-client.js';

it('retains the durable gate across client and SQLite reopen and records response without settling apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'changeset gate-'));
  let db = openDb({ path: join(dir, 'state.db') });
  try {
    const scope = { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' };
    const program = { executionModel: 'langgraph-functional-v1' as const, durability: 'sync' as const, engineVersion: '1', checkpointVersion: '1',
      templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) };
    const runs = new GraphRunStore(db);
    let run = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'start', inputArtifactRef: 'input',
      source: { product: 'osstack', requestId: 'r', parentRunId: 'p' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
        input: { taskRef: 't', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'a' },
        limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
          maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 2000 } } }, program, 100);
    const fence = () => ({ scope, graphRunId: run.graphRunId, expectedGeneration: run.generation, expectedOwner: run.leaseOwner,
      expectedRevision: run.revision, identity: run.identity, now: 110 });
    run = runs.acquireLease({ ...fence(), owner: 'worker', leaseExpiresAt: 100000 });
    let actions = new GraphActionStore(db);
    const reserved = actions.reserve(fence(), { epoch: 0, nodeId: 'implement', effectSlot: 'invoke', reservationTokens: 1100,
      action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' } });
    run = reserved.run; const key = reserved.action.effectKey; new GraphAdmissionStore(db).hold(key, 110);
    const policy = { exactPaths: ['src/a.ts'], directoryPrefixes: [], denyPaths: [], denyPrefixes: [] };
    const binding = { runId: run.graphRunId, effectKey: key, generation: run.generation, baseRevision: 'a'.repeat(40), treeRevision: 'c'.repeat(40),
      profileDigest: 'd'.repeat(64), grantDigest: 'e'.repeat(64), programDigest: program.compiledProgramDigest, policyDigest: changesetPolicyDigest(policy) };
    const input = { task: 'Create', manifest: { schemaVersion: 1, binding, entries: [{ path: 'src/a.ts', state: 'absent' }] }, policy, binding,
      inputTokenUpperBound: 1000, maxOutputTokens: 100, tokenBoundEvidenceRef: 'fixture-bound' };
    // Trusted fixture gate only; no real tokenizer/grant authorization is claimed.
    const gate = (p: PreparedChangesetRequest) => {
      expect(p.reservationTokens).toBe(reserved.action.reservationTokens);
      const result = actions.beginInvocation(fence(), key, 'execution', { schemaVersion: 1, profile: 'bounded-changeset-v1', ...p.binding,
        manifestDigest: p.manifestDigest, requestDigest: p.requestDigest, provider: p.provider, model: p.model,
        inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' });
      run = result.run; return result.changed;
    };
    let respond!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
    const options = { provider: 'anthropic' as const, model: 'fixture', apiKey: 'fixture', fetch: fetcher };
    const first = createChangesetProposalClient(options); const request = first.prepare(input);
    const pending = first.invoke(request, gate);
    db.close(); db = openDb({ path: join(dir, 'state.db') }); actions = new GraphActionStore(db);
    const second = createChangesetProposalClient(options);
    expect(await second.invoke(second.prepare(input), gate)).toMatchObject({ kind: 'not_authorized', reason: 'gate_denied' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    respond(new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ kind: 'propose', changes: [{ kind: 'create', path: 'src/a.ts', content: 'new' }] }) }],
      usage: { input_tokens: 10, output_tokens: 10 } })));
    const result = await pending;
    if (result.kind !== 'terminal' || result.disposition !== 'proposal' || !result.validated) throw Error('fixture result');
    run = actions.recordInvocationResponse(fence(), key, { schemaVersion: 1, requestDigest: result.requestDigest, responseDigest: result.responseDigest,
      disposition: 'proposal', proposalDigest: result.validated.proposalDigest, evidenceRef: 'fixture-response', stopEvidenceRef: 'fixture-stop' }).run;
    expect(actions.get(fence(), key)).toMatchObject({ action: { state: 'running', actualTokens: null }, budget: { reservedTokens: '1100', chargedTokens: '0', actionStarts: 1 } });
    expect(actions.getApply(fence(), key).apply).toBeNull();
  } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});
