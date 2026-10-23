import {createRequire} from 'node:module';
import {symlinkSync,writeFileSync} from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-sweep';
const require=createRequire(root+'/package.json');const {build}=createRequire(require.resolve('tsup'))('esbuild');
try{symlinkSync(root+'/packages/cli/node_modules',out+'/node_modules','dir');}catch(e){if(e.code!=='EEXIST')throw e;}
await build({entryPoints:[root+'/packages/cli/src/graph-quiescence-sweep.ts'],outfile:out+'/sweep-bundle.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
writeFileSync(out+'/sweep-child.mjs',`import {readFileSync} from 'node:fs';
import {openDb} from '@osstack/core';
import {sweepGraphQuiescence} from './sweep-bundle.mjs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const db=openDb({path:input.dbPath});
const options={...input.options,authorize:()=>{},contained:{...input.options.contained,options:{...input.options.contained.options,authorizeRead:()=>{},authorizeStop:()=>{}}}};
try{console.log(JSON.stringify(await sweepGraphQuiescence(db,options,input.request)));}finally{db.close();}
`);
