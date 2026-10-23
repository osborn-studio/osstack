import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-quiescence';
const read=name=>JSON.parse(readFileSync(out+'/'+name));
const matrix=read('matrix.json'),loop=read('acceptance-result.json'),task=loop.completedTasks[0];
assert.equal(loop.executedTaskCount,1);assert.equal(loop.skippedTaskCount,0);assert.equal(task.outcome,'escalated');
assert.equal(task.execution_commands.length,1);assert.notEqual(task.execution_commands[0].exit_code,0);
assert.equal(task.verify_commands.length,7);assert.ok(task.verify_commands.every(c=>c.exit_code===0));
assert.equal(matrix.passed,true);assert.equal(matrix.sourceUnchanged,true);assert.equal(matrix.artifactsUnchanged,true);
for(const [path,digest] of Object.entries({...matrix.sourceHashes,...matrix.artifactHashes}))assert.equal(createHash('sha256').update(readFileSync(root+'/'+path)).digest('hex'),digest,path);
const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','packages','scripts','pnpm-lock.yaml','package.json'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();assert.deepEqual(paths,Object.keys(matrix.sourceHashes).sort());
for(const name of ['kimi-accepted','kimi-addendum']){const r=read(name+'-result.json').at(-1).payload.review;assert.equal(r.verdict,'approved');assert.ok(r.judgments.every(j=>j.pass));assert.equal(r.runtime_identity.model_id,'kimi-code/k3');
 const input=read(name+'-input.json');for(const p of input.changed_paths)assert.ok(input.diff.includes(readFileSync(root+'/'+p,'utf8')),p+' audited source differs');}
for(const [name,count] of [['child',25],['candidate',11]])assert.ok(readFileSync(out+'/accepted-'+name+'.txt','utf8').includes(count+' passed'));
const prior=readFileSync(out+'/failed-delivery.txt','utf8');assert.ok(prior.includes('1 failed | 36 passed (37)'));assert.ok(prior.includes('returns an explicit stop when preparation admission'));
const result={passed:true,sourceFiles:paths.length,retainedVerifiers:7,reason:'Prior delivery run failed only on conservative missing-admission contract expectation; final delivery rerun required. Seeded matrix and all retained verifiers attest final exact source and artifacts.',matrixTests:matrix.runs.reduce((n,r)=>n+r.tests.length,0),sourceUnchanged:true,artifactsUnchanged:true};
writeFileSync(out+'/retained-evidence-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
