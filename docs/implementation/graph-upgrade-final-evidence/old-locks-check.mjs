import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { acquireRepoWriteLock } from '/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/autonomy/dist/repo-lock.js';
import { acquireRepoWriteLock as oldAcquire } from './v17/package/dist/repo-lock.js';
const root=await mkdtemp('/Volumes/AIMATE_WORK/tmp/g30-final/old-locks/lock-');
const lock=await acquireRepoWriteLock({root_dir:root,repo_id:'r',autonomy_run_id:'graph:unknown',pid:123,recover_stale:false});
const before=await readFile(lock.path,'utf8');
await assert.rejects(oldAcquire({root_dir:root,repo_id:'r',autonomy_run_id:'old',is_process_alive:()=>false}),{name:'RepoLockCorruptError'});
assert.equal(await readFile(lock.path,'utf8'),before);await lock.release();console.log(JSON.stringify({published:'@osstack/autonomy@0.17.0',result:'strict parser refuses new managed owner; lock unchanged',passed:true}));
