// Subprocess harness: exit inside actual receipt publication boundaries without cleanup.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AttentionStore, ContainedMissionStore, HostProcessStore, RevisionChainStore, openDb, type AttentionOwner, type HostProcessRecord } from '@osstack/core';
import { confirmRevisionPublication, publishRevisionCheck, type ConfirmRevisionInput } from './contained-mission-revision-publication.js';

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  path: string; owner: AttentionOwner; input: ConfirmRevisionInput; point: number; repo: string; head: string; checkFile: string; now: number;
};
const db = openDb({ path: config.path });
db.pragma('synchronous=FULL');
const attention = new AttentionStore(db, config.path);
const chains = new RevisionChainStore(attention, config.owner);
const missions = new ContainedMissionStore(attention, config.owner);
const journal = new HostProcessStore(attention, config.owner, { clock: () => ++config.now });
const deps = { chains, missions, host: { recordForIntent: (id: string) => db.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(id) as HostProcessRecord | undefined }, now: () => ++config.now, checkEnabled: true };
const crash = (): never => process.exit(74);
// The external receipt stands in for App B's idempotency key and survives the client crash.
const send = async () => {
  const created = !existsSync(config.checkFile);
  if (created) writeFileSync(config.checkFile, '42');
  if (config.point === 5) crash();
  return { check_run_id: 42, created };
};
if (config.point <= 2) {
  execFileSync('git', ['push', '-q', 'origin', `${config.head}:refs/heads/topic`], { cwd: config.repo });
  if (config.point === 1) crash();
  const row = deps.host.recordForIntent(config.input.intent_id)!;
  journal.stopped(row.op_id, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
  crash();
}
confirmRevisionPublication(deps, { ...config.input,
  ...(config.point === 3 ? { fault: (step: string) => { if (step === 'void') crash(); } } : {}) });
if (config.point === 4) crash();
await publishRevisionCheck(deps, config.input.child_mission_id, send);
crash();
