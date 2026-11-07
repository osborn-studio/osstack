// Fault injection only: pauses the original supervisor at actual Docker API boundaries.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainedCommandExecutor } from '../../packages/agents/dist/contained-command.js';
import { ContainedDocker } from '../../packages/agents/dist/contained-docker.js';
// Temp file + rename so a polling reader never observes a partial boundary.json.
function writeBoundary(dir, value) {
  const target = join(dir, 'boundary.json'); const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value)); renameSync(temp, target);
}
const [file, mode, invocationId] = process.argv.slice(2);
const options = JSON.parse(readFileSync(file)); options.authorize = () => {};
const original = ContainedDocker.prototype.call;
ContainedDocker.prototype.call = async function(method, path, body) {
  if (mode === 'pre-start' && method === 'POST' && path.endsWith('/start')) {
    writeBoundary(options.journalRoot, { path }); process.kill(process.pid, 'SIGSTOP');
  }
  const r = await original.call(this, method, path, body);
  if ((mode === 'post-create' && path === '/containers/create') || (mode === 'post-delete' && method === 'DELETE')) {
    writeBoundary(options.journalRoot, { path, body: r.bytes.toString() }); process.kill(process.pid, 'SIGSTOP');
  }
  return r;
};
const executor = new ContainedCommandExecutor(options);
try {
  const result = mode === 'stop' ? await executor.stop(invocationId) : await executor.execute(invocationId, new AbortController().signal);
  process.send?.({ ok: true, result });
} catch (error) { process.send?.({ ok: false, error: String(error) }); }
process.disconnect();
