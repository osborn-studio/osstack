import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphActionStore } from '@osstack/core';
import { createBoundedMessagesAdapter } from '@osstack/agents';
import { GraphDelegationStatus } from '@osstack/protocol';
import { graphRpcFixture } from '../../packages/cli/src/graph-test-fixture.js';
import { GraphRpcService } from '../../packages/cli/src/graph-rpc.js';
import { GraphProcessJournal } from '../../packages/cli/src/graph-process-journal.js';

const [output, mode = 'before-commit'] = process.argv.slice(2);
if (!output) throw Error('OUTPUT_REQUIRED');
const f = await graphRpcFixture();

const original = GraphActionStore.prototype.recordOutcome;
GraphActionStore.prototype.recordOutcome = function (...args) {
  if (args[2].state === 'confirmed' && args[2].result.kind === 'implementation_complete') {
    if (mode === 'after-commit') original.apply(this, args);
    throw Error('injected stopped implementation ledger ACK failure');
  }
  return original.apply(this, args);
};
if (mode === 'no-worker-exit') {
  const observe = GraphProcessJournal.prototype.observed;
  GraphProcessJournal.prototype.observed = function (...args) { if (args[1].kind !== 'exited') observe.apply(this, args); };
}
const writer = await createBoundedMessagesAdapter({ role: 'writer', provider: 'deepseek', model: 'fixture', files: ['answer'],
  apiKey: 'test-only', acceptance: 'answer must be 1', authorize: () => {}, fetch: async (_url, init) => {
    appendFileSync(join(output, 'invocations'), 'once\n');
    if (mode === 'disconnect') throw Error('disconnected without terminal response');
    const body = JSON.parse(String(init!.body)); const file = JSON.parse(body.messages.at(-1).content).files[0];
    return new Response(JSON.stringify({ id: 'bounded-response', model: 'fixture', object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ edit: { path: 'answer', beforeSha256: file.sha256, content: '1\n' } }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  } });
const registration = { ...f.registration, delivery: { ...f.registration.delivery,
  writer: { identity: writer.id, adapter: writer, capabilityId: writer.capabilities()[0]!.id } } };
const service = new GraphRpcService({ ...f.options, registrations: [registration] });
const started = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request));
for (let n = 0; ; n++) {
  const status = await f.status(started.graphRunId, service);
  if (status.status === 'reconciliation_required') break;
  if (n > 1200) throw Error('TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 20));
}
await service.close(); await f.service.close();
if (mode === 'future-template') {
  // Seed an unsupported persisted history AFTER a real supported invocation.
  // New starts reject this tuple before dispatch; this fixture tests recovery only.
  f.db.transaction(() => {
    const trigger = f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='graph_runs_identity_immutable'").get() as { sql: string };
    f.db.exec('DROP TRIGGER graph_runs_identity_immutable');
    f.db.prepare("UPDATE graph_runs SET identity_json=json_set(identity_json, '$.templateVersion', '999') WHERE graph_run_id=?").run(started.graphRunId);
    f.db.exec(trigger.sql);
  })();
}
const metadata = { root: f.root, id: started.graphRunId, request: f.request, registration: {
  id: registration.id, scope: registration.scope, product: registration.product, repositoryRef: registration.repositoryRef,
  taskRef: registration.taskRef, inputArtifactRef: registration.inputArtifactRef,
  delivery: { repositoryPath: registration.delivery.repositoryPath, task: registration.delivery.task, acceptanceRegistry: registration.delivery.acceptanceRegistry },
} };
writeFileSync(join(output, 'metadata.json'), JSON.stringify(metadata));
f.db.close(); process.send?.({ ready: true });
if (mode === 'alive') process.on('message', () => process.exit(0));
else process.exit(0);
