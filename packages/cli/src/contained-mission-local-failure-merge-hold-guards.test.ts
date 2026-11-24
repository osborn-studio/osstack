import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('confines the local-failure merge hold', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const module = 'contained-mission-local-failure-merge-hold';
  const merge = 'contained-mission-sandbox-ci-merge.ts';
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.(?:test|testkit)\.[cm]?[jt]sx?$/.test(file));
  for (const file of files.filter(file => file !== module + '.ts' && file !== merge)) {
    expect(read(file), file).not.toMatch(/readLocalFailureMergeHold|contained-mission-local-failure-merge-hold/);
  }
  const source = read(module + '.ts');
  for (const forbidden of ['INSERT', 'UPDATE', 'DELETE', '.record(', '.transition(', 'appendEvent', 'fetch']) {
    expect(source).not.toContain(forbidden);
  }
  expect(source).not.toMatch(/\b(?:from\s*|import\s*\(?\s*)['"][^'"]*(?:publish|approval|dispatch|diagnos|recheck-run|github|app-e)[^'"]*['"]/i);
  expect(read(merge).match(/\bheldFor\s*\(/g)).toHaveLength(5);
  expect(read(merge).match(/local_failure_merge_held/g)).toHaveLength(2);
  expect(read('contained-mission-local-failure-switch.ts')).toContain('LOCAL_FAILURE_ROUTE_MERGE_HOLD_REQUIRED');
  expect(read('contained-mission-rpc.ts').match(/\bassertLocalFailureRouteStartable\s*\(/g)).toHaveLength(2);
});
