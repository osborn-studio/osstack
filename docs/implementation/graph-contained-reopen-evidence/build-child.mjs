import { createRequire } from 'node:module';
import { symlinkSync, writeFileSync } from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation';
const out='/Volumes/AIMATE_WORK/tmp/g25-reopen';
const require=createRequire(root+'/package.json');
const {build}=createRequire(require.resolve('tsup'))('esbuild');
try {symlinkSync(root+'/packages/cli/node_modules',out+'/node_modules','dir');} catch(e) {if(e.code!=='EEXIST')throw e;}
await build({entryPoints:[root+'/packages/cli/src/graph-contained-recovery.ts'],outfile:out+'/reopen-bundle.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
writeFileSync(out+'/reopen-child.mjs',`import {readFileSync} from 'node:fs';
import {openDb} from '@osstack/core';
import {reopenGraphContainedTests} from './reopen-bundle.mjs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const db=openDb({path:input.dbPath});
try {
 const reopened=await reopenGraphContainedTests(db,{...input.options,authorizeRead:()=>{},authorizeStop:()=>{}},input.request);
 const proof=await reopened[input.operation]();
 const row=db.prepare('SELECT a.state,h.released_at FROM graph_actions a JOIN graph_action_admissions h ON h.effect_key=a.effect_key WHERE a.effect_key=?').get(input.request.effectKey);
 console.log(JSON.stringify({...proof,state:row.state,held:row.released_at===null}));
}finally {db.close();}
`);
