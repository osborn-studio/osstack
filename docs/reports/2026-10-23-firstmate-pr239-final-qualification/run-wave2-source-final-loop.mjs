import {LoopEngine} from '/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-followthrough/packages/loop/dist/index.js';
import {writeFile,readFile} from 'node:fs/promises';
const root='/Volumes/AIMATE_WORK/tmp/osstack/smoke/pr237-integration';
const engine=new LoopEngine({workspacePath:'/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-followthrough',stateFilePath:root+'/wave2-loop/LOOP-STATE.json',markdownPath:root+'/wave2-loop/STATE.md',sources:[],inputTasks:[JSON.parse(await readFile(JSON.parse(await readFile(root+'/wave2-source-final-enqueue.json','utf8')).path,'utf8'))],executeCommand:'python3 '+root+'/run-wave2-source-final-checks.py',verifyCommands:['python3 '+root+'/verify-wave2-source-final-checks.py'],maxIterations:1,commandTimeoutMs:1800000,outputLimit:12000,archiveCompletedTasks:false});
const result=await engine.runOnce(); await writeFile(root+'/wave2-source-final-loop-result.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result.completedTasks));process.exitCode=result.completedTasks.at(-1)?.outcome==='success'?0:1;
