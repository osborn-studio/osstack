import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-reopen';
const read=name=>JSON.parse(readFileSync(out+'/'+name)); const hash=file=>createHash('sha256').update(readFileSync(root+'/'+file)).digest('hex');
const loop=read('acceptance-result.json'),task=loop.completedTasks[0],matrix=read('matrix.json');
assert.equal(task.outcome,'escalated'); const failed=task.verify_commands.filter(c=>c.exit_code!==0);
assert.equal(failed.length,1);assert.ok(failed[0].command.endsWith(' candidate'));
assert.equal(task.execution_commands[0].exit_code,0);assert.equal(task.verify_commands.filter(c=>c.exit_code===0).length,9);
const failure=readFileSync(out+'/candidate-first-failed.txt','utf8');assert.equal((failure.match(/Error: ENOENT: no such file or directory, open .*real-evidence/g)||[]).length,10);
assert.equal(matrix.passed,true);assert.equal(matrix.sourceUnchanged,true);assert.equal(matrix.artifactsUnchanged,true);
for(const [path,digest] of Object.entries({...matrix.sourceHashes,...matrix.artifactHashes,...read('accepted-source-hashes.json')}))assert.equal(hash(path),digest,path);
const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','packages','scripts','pnpm-lock.yaml','package.json'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();assert.deepEqual(paths,Object.keys(matrix.sourceHashes).sort());
for(const name of ['kimi-reopen','kimi-final-2']){const p=read(name+'-result.json').at(-1).payload;assert.equal(p.review.verdict,'approved');assert.ok(p.review.judgments.every(j=>j.pass));assert.equal(p.review.runtime_identity.model_id,'kimi-code/k3');}
assert.equal(read('ledger-crash-result.json').passed,true);assert.equal(read('real-final.json').passed,true);
assert.ok(readFileSync(out+'/accepted-candidate.txt','utf8').includes('12 passed'));
const result={passed:true,scope:'Retain previously passed checks only after exact source and build hash validation; first Loop failed solely on missing report directory',sourceFiles:paths.length,priorPassedVerifiers:9,failedVerifierRerun:'candidate',sourceUnchanged:true,artifactsUnchanged:true};
writeFileSync(out+'/retained-evidence-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
