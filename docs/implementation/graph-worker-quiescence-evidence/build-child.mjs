import { createRequire } from 'node:module';
import { symlinkSync, writeFileSync } from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation';
const out='/Volumes/AIMATE_WORK/tmp/g25-quiescence';
const require=createRequire(root+'/package.json');
const {build}=createRequire(require.resolve('tsup'))('esbuild');
try {symlinkSync(root+'/packages/cli/node_modules',out+'/node_modules','dir');} catch(e) {if(e.code!=='EEXIST')throw e;}
await build({entryPoints:[root+'/packages/cli/src/graph-worker-exit-proof.ts'],outfile:out+'/exit-proof-bundle.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
writeFileSync(out+'/exit-proof-child.mjs',`import {readFileSync} from 'node:fs';
import {openDb} from '@osstack/core';
import {verifyJournaledGraphWorkerExit} from './exit-proof-bundle.mjs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const db=openDb({path:input.dbPath});
try {console.log(JSON.stringify(verifyJournaledGraphWorkerExit(db,input.binding)));}finally {db.close();}
`);
