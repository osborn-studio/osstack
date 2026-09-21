import {createRequire} from 'node:module';
import {symlinkSync,writeFileSync} from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-proof-bridge';
const require=createRequire(root+'/package.json');const {build}=createRequire(require.resolve('tsup'))('esbuild');
try{symlinkSync(root+'/packages/cli/node_modules',out+'/node_modules','dir');}catch(e){if(e.code!=='EEXIST')throw e;}
await build({entryPoints:[root+'/packages/cli/src/graph-contained-recovery.ts'],outfile:out+'/proof-bundle.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
writeFileSync(out+'/proof-child.mjs',`import {readFileSync} from 'node:fs';
import {openDb} from '@osstack/core';
import {reopenGraphContainedTests} from './proof-bundle.mjs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));if(input.operation!=='captureQuiescence')throw Error('inspection only');
const db=openDb({path:input.dbPath});
try{const opened=await reopenGraphContainedTests(db,{...input.options,authorizeRead:()=>{},authorizeStop:()=>{throw Error('no stop grant');}},input.request);
const proof=await opened.captureQuiescence();db.transaction(()=>proof.recheck()).immediate();
const row=db.prepare('SELECT a.state,d.released_at FROM graph_actions a JOIN graph_action_admissions d ON d.effect_key=a.effect_key WHERE a.effect_key=?').get(input.request.effectKey);
console.log(JSON.stringify({executorEvidenceRef:proof.executorEvidenceRef,isolationEvidenceRef:proof.isolationEvidenceRef,scope:proof.scope,held:row.released_at===null,state:row.state,rechecked:true}));}finally{db.close();}
`);
