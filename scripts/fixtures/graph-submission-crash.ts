// Real public submit reservation before its deferred driver construction.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '@osstack/core';
import type { AgentAdapter } from '@osstack/agents';
import { GraphDelegationStatus } from '@osstack/protocol';
import { graphRpcFixture } from '../../packages/cli/src/graph-test-fixture.js';
import { GraphRpcService, type GraphHostRegistration } from '../../packages/cli/src/graph-rpc.js';

const root = resolve(process.argv[2]!); const file = join(root, 'submission.json');
if (process.argv[3] === 'submit') {
  const f = await graphRpcFixture();
  const status = GraphDelegationStatus.parse(await f.service.handle(f.connection, 'graph.submit', f.request));
  const { writer: _writer, reviewer: _reviewer, verifyReviewer: _verify, ...delivery } = f.registration.delivery;
  writeFileSync(file, JSON.stringify({ root: f.root, request: f.request, status, delivery }));
  process.kill(process.pid, 'SIGSTOP');
  // This executes before setImmediate constructs a driver. After cancellation,
  // the original deferred continuation must observe cancelled and return.
  setImmediate(() => process.send?.({ kind: 'resumed', writes: f.writes() }));
} else {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const db = openDb({ path: join(data.root, 'control.sqlite') }); let execute = true; let invoked = 0;
  const adapter: AgentAdapter = { id: 'writer', display_name: 'forbidden', cost_tier: 'low', capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: async function* () { invoked++; throw Error('unexpected replay invocation'); } };
  const registration: GraphHostRegistration = { id: 'local', scope: data.request.scope, product: 'osstack', repositoryRef: 'repo', taskRef: 'task', inputArtifactRef: 'input',
    authorize: operation => { if (!execute && operation !== 'read' && operation !== 'cancel') throw Error('GRANT_EXPIRED'); },
    delivery: { ...data.delivery, writer: { identity: 'writer', adapter, capabilityId: 'write' },
      reviewer: { identity: 'reviewer', adapter: { ...adapter, id: 'reviewer' }, capabilityId: 'review' }, verifyReviewer: async () => {} } };
  const connection = {}; const service = new GraphRpcService({ db, root: join(data.root, 'delivery'), registrations: [registration],
    resolveCaller: caller => caller === connection ? 'local' : null, acquire: async () => { throw Error('unexpected replay admission'); } });
  const replay = GraphDelegationStatus.parse(await service.handle(connection, 'graph.submit', data.request));
  let cancelled;
  if (process.argv[3] === 'cancel') {
    execute = false;
    cancelled = await service.handle(connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: replay.scope,
      graphRunId: replay.graphRunId, expectedRevision: replay.revision, idempotencyKey: 'cancel-after-crash' });
  }
  await service.close();
  process.send?.({ replay, cancelled, invoked,
    actions: db.prepare('SELECT count(*) n FROM graph_actions').get(), launches: db.prepare('SELECT count(*) n FROM graph_worker_launches').get(),
    runs: db.prepare('SELECT count(*) n FROM graph_runs').get() });
  db.close(); process.disconnect();
}
