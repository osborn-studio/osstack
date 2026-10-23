// G25 fault fixture: independent hosts use the real runtime and SQLite journal.
import { resolve, join } from 'node:path';
import { processFixture } from '../../packages/cli/src/graph-process-fixture.js';
import { GraphRuntime } from '../../packages/cli/src/graph-runtime.js';
const root = resolve(process.argv[2]!);
const pulse = join(root, 'descendant.log');
const escapedPulse = join(root, 'escaped.log');
const marker = join(root, 'worker.json');
const descendant = (file: string) => `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(file)},'alive\\n'),20);setTimeout(()=>process.exit(0),10000);`;
const source = `export async function run() {
  const fs = await import('node:fs'); const {spawn} = await import('node:child_process');
  const child = spawn(process.execPath,['-e',${JSON.stringify(descendant(pulse))}],{stdio:'ignore'});
  const escaped = spawn(process.execPath,['-e',${JSON.stringify(descendant(escapedPulse))}],{stdio:'ignore',detached:true});
  fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,child:child.pid,escaped:escaped.pid}));
  process.on('SIGTERM',()=>{}); while(true) {}
}`;
const f = processFixture(root, source);
const runtime = new GraphRuntime({ ...f.options, workerOptions: { ...f.options.workerOptions, workerEntry: resolve('packages/graph/dist/worker-entry.js') } });
if (process.argv[3] === 'start') {
  const handle = runtime.start(f.start); await handle.ready;
  process.send?.({ binding: f.binding, report: runtime.observeWorkerProcess(f.binding) });
} else {
  const report = runtime.observeWorkerProcess(f.binding);
  const duplicate = runtime.start(f.start);
  process.send?.({ binding: f.binding, report, duplicate: await duplicate.finalExit,
    afterDuplicate: runtime.observeWorkerProcess(f.binding), hostPid: process.pid });
  await runtime.close(); await runtime.drainDatabaseUsers(); await f.runtime.close(); await f.runtime.drainDatabaseUsers(); f.db.close();
  process.disconnect();
}
