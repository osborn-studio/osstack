import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseRegistry } from './lib/bridge-probe.mjs';
import { applyBody, loadRulesetFiles, resolveActors } from './lib/rulesets.mjs';
import { collectReadiness, ghGet, main } from './inspect-bridge-operator-readiness.mjs';

const registry = parseRegistry(await readFile(new URL('../docs/decisions/ADR-006-bridge-s0-decisions.md', import.meta.url), 'utf8'));
const files = await loadRulesetFiles(new URL('../.github/rulesets/', import.meta.url).pathname);
const actors = Object.fromEntries(Object.entries(registry.apps).map(([key, app]) => [key, app.appId]));
const copies = files.map((file, i) => ({ ...applyBody(resolveActors(file, actors)), id: i + 1 }));
function fake({ classic = { enforce_admins: { enabled: true } }, live = copies, fail = () => false } = {}) {
  const paths = [];
  const get = async path => {
    paths.push(path);
    if (fail(path)) throw Object.assign(new Error('Bearer secret ghp_DO_NOT_PRINT'), { status: 403 });
    if (path.startsWith('users/')) return { login: decodeURIComponent(path.slice(6)), id: 700 + paths.length, type: 'Bot', token: 'secret' };
    if (path.endsWith('/branches/main')) return { name: 'main' };
    if (path.endsWith('/protection')) return classic;
    if (path.includes('/rulesets?')) return live.map(({ id }) => ({ id }));
    if (path.includes('/rulesets/')) return live.find(item => item.id === Number(path.split('/').at(-1)));
    const repo = path.slice(6);
    return { full_name: repo, id: repo === registry.sandbox.repo ? registry.sandbox.id : 999, visibility: 'public', default_branch: 'main' };
  };
  return { get, paths };
}

test('reports classic protection separately from rulesets and leaves platform evidence missing', async () => {
  const { get } = fake({ classic: { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }, required_status_checks: null, enforce_admins: { enabled: true } } });
  const report = await collectReadiness({ get });
  assert.equal(report.productionGate, 'closed');
  assert.equal(report.collectionComplete, true);
  assert.equal(report.repositories.length, 2);
  assert.equal(report.repositories[0].classicProtection.requiredApprovals, 1);
  assert.deepEqual(report.repositories[0].classicProtection.requiredChecks, []);
  assert.equal(report.repositories[1].rulesets.comparison.ok, true);
  assert.equal(report.repositories[0].rulesets.comparison.complete, false);
  assert.equal(report.identities.length, 6);
  assert.ok(report.identities.every(item => item.publicBot.status === 'observed'));
  assert.equal(report.platformUnknowns.length, 11);
  assert.ok(report.missingEvidence.includes('App C/D migration, installations, permissions and event delivery'));
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('a protection 404 is unknown, not proof of no classic protection', async () => {
  const { get } = fake();
  const report = await collectReadiness({ get: path => {
    if (path.endsWith('/protection')) throw Object.assign(new Error('raw secret'), { status: 404 });
    return get(path);
  } });
  assert.equal(report.repositories[0].classicProtection.status, 'unknown');
  assert.equal(report.repositories[0].classicProtection.httpStatus, 404);
  assert.equal(report.repositories[0].rulesets.status, 'observed');
  assert.equal(report.collectionComplete, false);
});

test('redacts API failures and arbitrary API fields from the report', async () => {
  const { get } = fake({ fail: path => path.startsWith('users/') });
  const report = await collectReadiness({ get });
  assert.equal(report.identities[0].publicBot.status, 'unknown');
  assert.equal(report.identities[0].publicBot.httpStatus, 403);
  assert.doesNotMatch(JSON.stringify(report), /Bearer|secret|ghp_/);
});

test('rejects sandbox identity mismatch before reading protection or rulesets', async () => {
  const { get, paths } = fake();
  const report = await collectReadiness({ get: path => path === `repos/${registry.sandbox.repo}` ? { full_name: registry.sandbox.repo, id: 1, visibility: 'public' } : get(path) });
  assert.equal(report.repositories[1].status, 'unknown');
  assert.equal(report.repositories[1].reason, 'identity_mismatch');
  assert.ok(!paths.some(path => path.startsWith(`repos/${registry.sandbox.repo}/`)));
});

test('stops bounded ruleset pagination and preserves incomplete evidence', async () => {
  let pages = 0;
  const { get } = fake();
  const report = await collectReadiness({ get: path => {
    if (path.includes('/rulesets?')) {
      pages += 1;
      const page = Number(/[?&]page=(\d+)/.exec(path)[1]);
      return Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i + 1 }));
    }
    return get(path);
  } });
  assert.equal(pages, 6);
  assert.equal(report.repositories[0].rulesets.status, 'unknown');
  assert.equal(report.repositories[0].rulesets.reason, 'pagination_limit');
  assert.equal(report.collectionComplete, false);
});

test('bounds detail reads and rejects hostile inherited ruleset paths', async () => {
  const { get } = fake();
  let details = 0;
  const report = await collectReadiness({ get: path => {
    if (path.includes('/rulesets?')) return Array.from({ length: 99 }, (_, i) => ({ id: i + 1 }));
    if (path.includes('/rulesets/')) { details += 1; return { ...copies[0], id: Number(path.split('/').at(-1)) }; }
    return get(path);
  } });
  assert.ok(details < 100);
  assert.equal(report.collectionComplete, false);
  const hostile = await collectReadiness({ get: path => path.includes('/rulesets?') ? [{ id: 1, source_type: 'Organization', source: '../app' }] : get(path) });
  assert.equal(hostile.repositories[0].rulesets.reason, 'endpoint_rejected');
});

test('reports baseline mismatches and App C binding independently', async () => {
  const live = structuredClone(copies);
  live[0].rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'grok/verify-osstack', integration_id: registry.apps['grok-pr-watcher'].appId });
  const report = await collectReadiness({ get: fake({ live }).get });
  assert.equal(report.repositories[1].rulesets.comparison.ok, false);
  assert.equal(report.repositories[1].rulesets.grokCheckBinding, 'configured');
  assert.equal(report.productionGate, 'closed');
});

test('fixed GET transport uses argument arrays, github.com, timeout and no raw errors', async () => {
  let invocation;
  await ghGet('users/osstack-publisher%5Bbot%5D', { run: async (...args) => { invocation = args; return { stdout: '{}' }; } });
  assert.deepEqual(invocation[1].slice(0, 5), ['api', '--hostname', 'github.com', '--method', 'GET']);
  assert.equal(invocation[2].shell, false);
  assert.equal(invocation[2].timeout, 15000);
  await assert.rejects(ghGet('app/installations/1/access_tokens'), /endpoint_rejected/);
  await assert.rejects(ghGet('users/osstack-publisher%5Bbot%5D', { run: async () => { throw { stderr: 'HTTP 401 Bearer secret', message: 'secret' }; } }), error => error.status === 401 && !error.message.includes('secret'));
});

test('CLI help and invalid args do not call GitHub; output is JSON', async () => {
  let output = '';
  const out = { write: value => { output += value; } };
  assert.equal(await main(['--help'], { out, get: () => assert.fail('GET on help') }), 0);
  assert.match(output, /GET/);
  await assert.rejects(main(['--apps-dir', '/secret'], { out }), /usage/);
  output = '';
  assert.equal(await main([], { out, get: fake({ live: [] }).get }), 0);
  assert.equal(JSON.parse(output).repositories[1].rulesets.comparison.ok, false);
});

test('missing bypass visibility is incomplete evidence, even when all GET requests succeed', async () => {
  const live = structuredClone(copies);
  delete live[0].bypass_actors;
  const report = await collectReadiness({ get: fake({ live }).get });
  assert.equal(report.repositories[1].rulesets.comparison.results[0].status, 'unreadable');
  assert.equal(report.collectionComplete, false);
});

test('malformed responses remain unknown and public identity mismatches are not accepted', async () => {
  const { get } = fake();
  const report = await collectReadiness({ get: path => {
    if (path.includes('/rulesets?')) return { token: 'ghp_DO_NOT_PRINT' };
    if (path.endsWith('/protection')) return {};
    if (path.startsWith('users/')) return { login: 'wrong', id: 10, type: 'User' };
    return get(path);
  } });
  assert.equal(report.repositories[0].classicProtection.reason, 'response_invalid');
  assert.equal(report.repositories[0].rulesets.status, 'unknown');
  assert.ok(report.identities.every(item => item.publicBot.reason === 'response_invalid'));
  assert.doesNotMatch(JSON.stringify(report), /ghp_|wrong/);
});

test('unknown remote strings do not enter summaries and wrong App C producer is not configured', async () => {
  const live = structuredClone(copies);
  live[0].rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'grok/verify-osstack', integration_id: 1 });
  live.push({ ...structuredClone(copies[0]), id: 999, name: 'Bearer ghp_DO_NOT_PRINT' });
  const report = await collectReadiness({ get: fake({ live }).get });
  assert.equal(report.repositories[0].rulesets.grokCheckBinding, 'not_observed');
  assert.equal(report.repositories[0].rulesets.comparison.results.at(-1).name, 'unregistered');
  assert.doesNotMatch(JSON.stringify(report), /Bearer|ghp_/);
});

test('CLI returns incomplete status without leaking transport failure details', async () => {
  let output = '';
  const exitCode = await main([], { out: { write: value => { output += value; } }, get: async () => { throw new Error('Bearer secret'); } });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(output).collectionComplete, false);
  assert.doesNotMatch(output, /Bearer|secret/);
});

test('second pass: preserves HTTP 401, 403 and 404 without inferring absence', async () => {
  for (const status of [401, 403, 404]) {
    const { get } = fake();
    const report = await collectReadiness({ get: path => {
      if (path.endsWith('/protection') || path.startsWith('users/')) throw Object.assign(new Error('secret'), { status });
      return get(path);
    } });
    assert.equal(report.repositories[0].classicProtection.httpStatus, status);
    assert.equal(report.repositories[0].classicProtection.status, 'unknown');
    assert.equal(report.identities[0].publicBot.httpStatus, status);
    assert.equal(report.collectionComplete, false);
  }
});

test('second pass: GET installation, token, auth and cross-scope endpoints never reach gh', async () => {
  for (const path of [
    'app', 'app/installations', 'app/installations/1/access_tokens', 'installation/repositories',
    'repos/osborn-studio/osstack/installation', 'applications/1/token', 'user',
    'repos/other/project', 'repos/other/project/rulesets/1', 'users/unregistered-bot%5Bbot%5D',
    'orgs/other/rulesets/1', 'https://api.github.com/repos/osborn-studio/osstack',
  ]) {
    await assert.rejects(ghGet(path, { run: async () => assert.fail(`transport invoked for ${path}`) }), /endpoint_rejected/);
  }
});

test('second pass: duplicate bot user IDs across distinct registered logins are conflicts', async () => {
  const { get } = fake();
  const report = await collectReadiness({ get: async path => {
    const value = await get(path);
    return path.startsWith('users/') ? { ...value, id: 12345 } : value;
  } });
  assert.ok(report.identities.every(item => item.publicBot.status === 'unknown' && item.publicBot.reason === 'identity_conflict'));
  assert.equal(report.collectionComplete, false);
});

test('second pass: duplicate ruleset summaries fail before detail reads', async () => {
  const { get, paths } = fake();
  const report = await collectReadiness({ get: path => path.includes('/rulesets?') ? [{ id: 1 }, { id: 1 }] : get(path) });
  assert.equal(report.repositories[0].rulesets.status, 'unknown');
  assert.equal(report.repositories[0].rulesets.reason, 'response_invalid');
  assert.ok(!paths.some(path => path.includes('/rulesets/')));
});

test('second pass: detail identity and inherited source cannot switch the evidence scope', async () => {
  const { get, paths } = fake();
  const report = await collectReadiness({ get: async path => {
    const value = await get(path);
    return path.includes('/rulesets/') ? { ...value, id: value.id + 10 } : value;
  } });
  assert.equal(report.repositories[0].rulesets.status, 'unknown');
  const inherited = await collectReadiness({ get: path => path.includes('/rulesets?') ? [{ id: 1, source_type: 'Organization', source: 'unregistered-org' }] : get(path) });
  assert.equal(inherited.repositories[0].rulesets.reason, 'endpoint_rejected');
  assert.ok(!paths.some(path => path.startsWith('orgs/')));
});

test('second pass: malformed rule evidence cannot count as a complete read', async () => {
  for (const mutate of [
    rule => { rule.rules = [null]; },
    rule => { rule.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: {} } }]; },
    rule => { rule.rules.push(structuredClone(rule.rules[0])); },
    rule => { rule.conditions = {}; },
    rule => { rule.bypass_actors = [null]; },
  ]) {
    const live = structuredClone(copies);
    mutate(live[0]);
    const report = await collectReadiness({ get: fake({ live }).get });
    assert.equal(report.repositories[0].rulesets.status, 'unknown');
    assert.equal(report.collectionComplete, false);
  }
});

test('second pass: absent main does not probe protection or claim a configured main check', async () => {
  const live = structuredClone(copies);
  live[0].rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'grok/verify-osstack', integration_id: registry.apps['grok-pr-watcher'].appId });
  const { get, paths } = fake({ live });
  const report = await collectReadiness({ get: path => {
    if (path.endsWith('/branches/main')) throw Object.assign(new Error('missing'), { status: 404 });
    return get(path);
  } });
  assert.equal(report.repositories[0].mainBranch.httpStatus, 404);
  assert.ok(!paths.some(path => path.endsWith('/protection')));
  assert.equal(report.repositories[0].rulesets.grokCheckBinding, 'unknown');
  assert.equal(report.collectionComplete, false);
});

test('second pass: non-main response and default-branch rules on develop cannot establish main binding', async () => {
  const { get } = fake();
  const wrong = await collectReadiness({ get: path => path.endsWith('/branches/main') ? { name: 'develop' } : get(path) });
  assert.equal(wrong.repositories[0].mainBranch.reason, 'response_invalid');
  const live = structuredClone(copies);
  live[0].rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'grok/verify-osstack', integration_id: registry.apps['grok-pr-watcher'].appId });
  const other = fake({ live });
  const report = await collectReadiness({ get: async path => {
    const value = await other.get(path);
    return /^repos\/[^/]+\/[^/]+$/.test(path) ? { ...value, default_branch: 'develop' } : value;
  } });
  assert.equal(report.repositories[0].rulesets.grokCheckBinding, 'not_observed');
  assert.equal(report.productionGate, 'closed');
});

test('second pass: a short second page still respects the total request budget', async () => {
  const { get } = fake();
  const counts = new Map();
  const pages = [];
  const report = await collectReadiness({ get: path => {
    if (path.startsWith('repos/')) {
      const scope = path.split('/').slice(0, 3).join('/');
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
    if (path.includes('/rulesets?')) {
      pages.push(path);
      return path.includes('page=1&') ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }];
    }
    if (path.includes('/rulesets/')) return { ...copies[0], id: Number(path.split('/').at(-1)) };
    return get(path);
  } });
  assert.equal(pages.length, 4);
  assert.ok([...counts.values()].every(count => count === 50));
  assert.equal(report.repositories[0].rulesets.reason, 'request_limit');
});

test('second pass: conflicting same-name check producers cannot establish App C binding', async () => {
  const live = structuredClone(copies);
  live[0].rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push(
    { context: 'grok/verify-osstack', integration_id: registry.apps['grok-pr-watcher'].appId },
    { context: 'grok/verify-osstack', integration_id: 1 },
  );
  const report = await collectReadiness({ get: fake({ live }).get });
  assert.equal(report.repositories[0].rulesets.grokCheckBinding, 'conflicting');
  assert.equal(report.productionGate, 'closed');
  assert.equal(report.readiness, 'not_assessed');
  assert.equal(report.evidenceScope, 'github_metadata_only');
  assert.ok(report.platformUnknowns.every(item => item.status === 'not_verified'));
});

test('second pass: non-main, excluded, disabled and unresolved glob rules never establish main binding', async () => {
  for (const [include, exclude, enforcement, expected] of [
    [['refs/heads/develop'], [], 'active', 'not_observed'],
    [['refs/heads/main'], ['refs/heads/main'], 'active', 'not_observed'],
    [['refs/heads/main'], [], 'disabled', 'not_observed'],
    [['refs/heads/*'], [], 'active', 'unknown'],
    [['refs/heads/main'], [], 'active', 'configured'],
  ]) {
    const live = structuredClone(copies);
    live[0].conditions.ref_name = { include, exclude };
    live[0].enforcement = enforcement;
    live[0].rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'grok/verify-osstack', integration_id: registry.apps['grok-pr-watcher'].appId });
    const report = await collectReadiness({ get: fake({ live }).get });
    assert.equal(report.repositories[0].rulesets.grokCheckBinding, expected);
    assert.equal(report.readiness, 'not_assessed');
    assert.ok(report.platformUnknowns.every(item => item.status === 'not_verified'));
  }
});

test('second pass: owner organization inheritance works but contradictory detail source is rejected', async () => {
  const { get } = fake();
  const report = await collectReadiness({ get: path => {
    if (path.includes('/rulesets?')) return [{ id: 1, source_type: 'Organization', source: 'osborn-studio' }];
    if (path === 'orgs/osborn-studio/rulesets/1') return { ...copies[0], source_type: 'Organization', source: 'osborn-studio' };
    return get(path);
  } });
  assert.equal(report.repositories[0].rulesets.status, 'observed');
  const contradictory = await collectReadiness({ get: async path => {
    const value = await get(path);
    return path.includes('/rulesets/') ? { ...value, source_type: 'Repository', source: 'other/project' } : value;
  } });
  assert.equal(contradictory.repositories[0].rulesets.reason, 'response_invalid');
});
