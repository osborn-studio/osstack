// Real process fault injection around production G25 host recovery; never a shipped entrypoint.
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { processFixture } from '../../packages/cli/src/graph-process-fixture.js';
import { GraphProcessJournal } from '../../packages/cli/src/graph-process-journal.js';

const root = resolve(process.argv[2]!); const mode = process.argv[3];
const source = `export async function run(){ const fs=await import('node:fs'); fs.appendFileSync(${JSON.stringify(join(root, 'executions.log'))},'once\\n'); return 42; }`;
const f = processFixture(root, source);
if (mode === 'fail-registration') {
  f.broker.register = () => { throw Error('injected consumed registration failure'); };
  const exit = await f.runtime.start(f.start).finalExit;
  process.send?.({ kind: 'ready', exit });
  process.on('message', () => {
    try { f.runtime.start(f.start); process.send?.({ kind: 'unexpected-start' }); }
    catch (error) { process.send?.({ kind: 'old-start-refused', error: String(error) }); }
  });
} else if (mode === 'pre-spawn' || mode === 'pre-identity') {
  if (mode === 'pre-spawn') {
    const register = f.broker.register.bind(f.broker);
    f.broker.register = (...args) => {
      writeFileSync(join(root, 'boundary.json'), JSON.stringify({ kind: mode }));
      process.kill(process.pid, 'SIGSTOP'); register(...args);
    };
  } else {
    const launched = GraphProcessJournal.prototype.launched;
    GraphProcessJournal.prototype.launched = function(binding, launch) {
      writeFileSync(join(root, 'boundary.json'), JSON.stringify({ kind: mode, workerPid: launch.pid }));
      process.kill(process.pid, 'SIGSTOP'); launched.call(this, binding, launch);
    };
  }
  f.runtime.start(f.start);
} else {
  try {
    const r = f.run;
    const result = await f.runtime.recoverUnstartedWorker({ fence: { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity,
      expectedGeneration: r.generation, expectedRevision: r.revision, expectedOwner: r.leaseOwner, now: Date.now() },
      receiptId: 'recover-no-child', owner: 'fresh-host', leaseExpiresAt: Date.now() + 30000 }, () => {});
    const run = result.result.run;
    const h = f.runtime.start({ ...f.start, run, registration: { ...f.start.registration, generation: run.generation, owner: run.leaseOwner! } });
    const value = await h.result; await h.finalExit;
    process.send?.({ kind: 'recovered', generation: run.generation, value, proof: result.result.record.proof,
      launches: f.db.prepare("SELECT count(*) n FROM graph_worker_process_events WHERE kind='launched'").get(),
      actions: f.db.prepare('SELECT count(*) n FROM graph_actions').get() });
  } catch (error) { process.send?.({ kind: 'refused', error: String(error), report: f.runtime.observeWorkerProcess(f.binding) }); }
  await f.runtime.close(); await f.runtime.drainDatabaseUsers(); f.db.close(); process.disconnect();
}
