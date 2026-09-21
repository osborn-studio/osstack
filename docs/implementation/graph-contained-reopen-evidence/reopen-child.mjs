import {readFileSync} from 'node:fs';
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
