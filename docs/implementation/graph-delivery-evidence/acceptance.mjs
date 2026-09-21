import { mkdir, writeFile } from 'node:fs/promises';
const root = "/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation";
const evidence = "/Volumes/AIMATE_WORK/tmp/g21";
process.env.OSSTACK_HOME = evidence + '/acceptance-home-2';
process.env.TMPDIR = evidence;
process.env.OSSTACK_UPDATE_CHECK = '0';
await mkdir(process.env.OSSTACK_HOME, {recursive: true});
const { LoopEngine } = await import(root + '/packages/loop/dist/index.js');
const runner = 'node ' + evidence + '/acceptance-command.mjs ';
const engine = new LoopEngine({ loopId: 'G21-final-acceptance-2', workspacePath: root,
 sources: [], inputTasks: [{task_id:'G21-final-acceptance-2', capability:'code.test', source:'manual', priority:100, prompt:'Verify G21 without making source changes.'}],
 useWorktree:false, skipCompletedTasks:false, maxIterations:1, commandTimeoutMs:600000, outputLimit:12000,
 stateFilePath: evidence + '/acceptance-2-LOOP-STATE.json', markdownPath:evidence + '/acceptance-2-STATE.md',
 policyGate: async ({workspacePath}) => workspacePath === root ? {allow:true} : {allow:false,reason:'scope mismatch'},
 executeCommand: runner + 'full-tests', verifyCommands: ['typecheck','schemas','kernel','functional','startup','whitespace'].map(name => runner + name),
});
const result = await engine.runOnce(); await writeFile(evidence + '/acceptance-result.json', JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({completedTasks:result.completedTasks, events:result.events.filter(x=>x.type.includes('verify')||x.type==='loop.stopped')}));
process.exitCode = result.completedTasks.length === 1 && result.completedTasks[0].outcome === 'success' ? 0 : 1;
