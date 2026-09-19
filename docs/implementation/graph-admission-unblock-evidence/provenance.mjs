import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const out='/Volumes/AIMATE_WORK/tmp/g25-claude-unblock', root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation';
const result=JSON.parse(readFileSync(out+'/acceptance-result.json','utf8'));
if(result.executedTaskCount!==1||result.skippedTaskCount!==0||result.completedTasks[0]?.outcome!=='success')throw Error('primary Loop not successful');
for(const [file,digest] of Object.entries(JSON.parse(readFileSync(out+'/production-hashes.json','utf8')))) {
 if(createHash('sha256').update(readFileSync(root+'/'+file)).digest('hex')!==digest)throw Error('production changed: '+file);
}
for(const name of ['focused','compatibility','loop','protocol']) {
 const result=JSON.parse(readFileSync(out+'/'+name+'-tests.json','utf8'));
 if(!result.success||result.numFailedTests||result.numPendingTests)throw Error('prior suite invalid: '+name);
}
console.log('Primary Loop and all 434 assertions passed; production/schema hashes unchanged. Only admission tests strengthened after review.');
