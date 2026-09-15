import { mkdtemp, writeFile } from 'node:fs/promises';
const root = '/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation';
const out = await mkdtemp('/Volumes/AIMATE_WORK/tmp/gc6/G18-loop-');
process.env.OSSTACK_HOME = '/Volumes/AIMATE_WORK/tmp/gc6/home';
process.env.TMPDIR = '/Volumes/AIMATE_WORK/tmp/gc6';
process.env.OSSTACK_UPDATE_CHECK = '0';
const { LoopEngine } = await import(root + '/packages/loop/dist/index.js');
const id = out.split('/').at(-1);
const env = 'OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc6 ';
const files = 'packages/graph/src/registry.ts packages/graph/src/registry.test.ts packages/graph/src/spec-compiler.ts packages/graph/src/spec-compiler.test.ts';
const engine = new LoopEngine({ loopId: id, workspacePath: root, sources: [],
  inputTasks: [{ task_id: id, capability: 'code.test', source: 'manual', priority: 100,
    prompt: 'Run focused G18 compiler and registry tests only. No source edits, agents or full acceptance.' }],
  useWorktree: false, skipCompletedTasks: false, maxIterations: 1, commandTimeoutMs: 120000, outputLimit: 20000,
  stateFilePath: out + '/LOOP-STATE.json', markdownPath: out + '/STATE.md',
  policyGate: async ({ workspacePath }) => ({ allow: workspacePath === root }),
  executeCommand: env + 'pnpm --filter @osstack/graph exec vitest run src/registry.test.ts src/spec-compiler.test.ts',
  verifyCommands: [env + 'pnpm exec tsc -p /Volumes/AIMATE_WORK/tmp/gc6/G18-typecheck.json',
    env + 'pnpm exec biome check ' + files, 'git diff --check -- ' + files],
});
const result = await engine.runOnce();
await writeFile(out + '/result.json', JSON.stringify(result, null, 2));
await writeFile('/Volumes/AIMATE_WORK/tmp/gc6/G18-loop-latest.txt', out + '\n');
console.log(JSON.stringify({ out, executedTaskCount: result.executedTaskCount, completedTasks: result.completedTasks,
  verificationEvents: result.events.filter(event => event.type.includes('verif')) }, null, 2));
process.exitCode = result.executedTaskCount === 1 && result.completedTasks.length === 1 && result.completedTasks[0].outcome === 'success' ? 0 : 1;
