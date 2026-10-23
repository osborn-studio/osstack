// Built public API smoke: one authorized implementation, with no commit or Loop state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGraphTestEnv } from '../../../scripts/graph-test-env.mjs';
import { executeCandidateImplementation, planTask } from '../../../packages/loop/dist/index.js';

const fixture = createGraphTestEnv();
const repository = join(fixture.home, 'repository');
mkdirSync(repository);
const git = (...args) => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', ...args], { env: fixture.env, encoding: 'utf8' }).trim();
let cleanupAllowed = true;
try {
  git('init', '-q');
  git('-c', 'user.name=Graph Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture baseline');
  const before = git('rev-parse', 'HEAD');
  const command = 'node -e "require(\'fs\').writeFileSync(\'implementation.txt\', \'one authorized implementation\\n\')"';
  let admissions = 0;
  const result = await executeCandidateImplementation({
    plan: planTask({ task_id: 'public-api-demo', capability: 'code.write', prompt: 'Write one implementation artifact', source: 'manual', priority: 50 }),
    workspace: { workspace_id: 'demo-owned-workspace', workspace_path: repository },
    command,
    authorize: (scope) => {
      admissions++;
      return scope.workspace.workspace_id === 'demo-owned-workspace'
        && scope.workspace.workspace_path === repository && scope.command === command
        && scope.plan.task.capability === 'code.write'
        ? { allow: true } : { allow: false, reason: 'Outside registered fixture scope' };
    },
  });
  cleanupAllowed = result.status !== 'execution_unconfirmed'
    && result.execution?.cancellation?.stop_confirmed !== false
    && !result.execution?.command_results.some(command => command.termination?.stop_confirmed === false);
  assert.equal(result.status, 'implementation_complete');
  assert.equal(admissions, 1);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(existsSync(join(repository, 'LOOP-STATE.json')), false);
  assert.equal(existsSync(join(repository, 'tasks')), false);
  const content = readFileSync(join(repository, 'implementation.txt'), 'utf8');
  assert.equal(content, 'one authorized implementation\n');
  console.log(JSON.stringify({ status: result.status, admissions, headUnchanged: true,
    loopStateCreated: false, taskQueueCreated: false, changedFiles: git('status', '--short'), content,
    commandExit: result.execution.command_results[0].exitCode,
    processStopConfirmed: result.execution.command_results[0].termination.stop_confirmed,
    ownerCleansFixtureAfterAssertions: true }, null, 2));
} finally {
  if (cleanupAllowed) fixture.cleanup();
  else console.error(`Unconfirmed execution: retain owned fixture for reconciliation: ${fixture.home}`);
}
