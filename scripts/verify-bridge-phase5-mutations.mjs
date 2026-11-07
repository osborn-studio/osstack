#!/usr/bin/env node
// Run source mutants sequentially and restore each file before the next run.
// A failed build/import is not a killed mutant. This never calls a live CLI or GitHub.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createScratchDir } from './lib/scratch.mjs';

const publication = 'packages/cli/src/contained-mission-revision-publication.ts';
const store = 'packages/core/src/state/engineering-revision-chain-store.ts';
const ddl = 'packages/core/src/state/engineering-revision-chain-ddl.ts';
const runner = 'packages/cli/src/contained-mission-runner.ts';
const pubTests = ['src/contained-mission-revision-publication.test.ts'];
const storeTests = ['src/state/engineering-revision-chain-store.test.ts'];
const mutants = [
  ['no-lease', publication, '`--force-with-lease=${ref}:${old}`, ', '', '@osstack/cli', pubTests],
  ['no-store-rounds-check', store, 'if (typeof rounds !== "number" || chain.rounds_used >= rounds) fail("rounds_exhausted");', '', '@osstack/core', storeTests],
  ['no-ddl-rounds-check', ddl, "AND COALESCE(rounds_used<=json_extract(grant_json,'$.rounds'),0)", '', '@osstack/core', storeTests],
  ['no-reservation-pk', ddl, 'PRIMARY KEY(repository,pr_number,head_sha),', '', '@osstack/core', storeTests],
  ['no-grant-fence', publication, 'assertGrantLive(chain, { ...authority!, now: deps.now() });', 'void chain;', '@osstack/cli', pubTests],
  ['no-completed-reservation-void', publication, "chain = deps.chains.voidReservation(chain.chain_id, chain.revision, intent.expected_old_head!, 'published', deps.now()).chain;", '', '@osstack/cli', pubTests],
  ['no-revision-spec-denial', 'packages/cli/src/contained-mission-ports.ts', "if (spec.publish_target) throw Error('CONTAINED_PUBLISH_TARGET_REQUIRES_REVISION');", '', '@osstack/cli', ['src/contained-mission-ports.test.ts']],
  ['no-feedback-delimiters', runner, '`<<<REVIEW-FEEDBACK-${review.nonce}`, review.text, `REVIEW-FEEDBACK-${review.nonce}>>>`,', 'review.text,', '@osstack/cli', ['src/contained-mission-revision.runner.test.ts']],
  ['no-precheck-base', publication, "if (pr.baseRefName !== chain.base_ref || pr.baseRefOid !== chain.published_base) reject('base_changed');", '', '@osstack/cli', pubTests],
  ['split-dispatch-transaction', 'packages/cli/src/contained-mission-revision.ts', 'const outcome = chains.transaction(', 'const outcome = (fn => fn())(', '@osstack/cli', ['src/contained-mission-revision.test.ts']],
  ['no-unsettled-publication-check', store, 'if (open) fail(open.state === "pending" ? "push_intent_pending" : "push_intent_uncertain");', '', '@osstack/core', storeTests],
  ['no-chain-classification', runner, 'const chain = this.classifyForChain(spec, chainDiff);', "const chain = { tier: 'T0', reasons: [] };", '@osstack/cli', ['src/contained-mission-revision.runner.test.ts']],
  ['no-acknowledge-advance', runner, 'this.ports.revision.acknowledgeAdvance(m, spec, decision.kind);', '', '@osstack/cli', ['src/contained-mission-revision.runner.test.ts']],
  ['interrupted-push-failed', publication, "deps.chains.settleIntent(intentId, 'uncertain', deps.now(), detail);", "deps.chains.settleIntent(intentId, 'failed', deps.now(), detail);", '@osstack/cli', pubTests],
  ['wrong-revision-publish-port', runner, 'await publication.publishRevision(revisionInput)', "await this.ports.publish({ ...revisionInput, body: 'mutant' })", '@osstack/cli', ['src/contained-mission-revision.runner.test.ts']],
  ['no-release-fence', 'packages/core/src/state/engineering-host-process-store.ts', 'const result: unknown = fence();', 'const result: unknown = undefined;', '@osstack/core', ['src/state/engineering-host-process-store.test.ts']],
  ['token-after-fence', 'packages/cli/src/contained-mission-bridge.ts', "if (args[at] === 'push') {\n          const token = await publisherToken();", "if (args[at] === 'push') {\n          options.gate?.fence();\n          const token = await publisherToken();\n          if (options.gate) options = { ...options, gate: { ...options.gate, fence: () => {} } };", '@osstack/cli', ['src/contained-mission-bridge.test.ts']],
  // This mutant requires the production invariant-6 baseline node (bcd20732).
  ['baseline-omission', 'packages/cli/src/contained-mission-grant.ts', "chains.settleIntent(initial.intent.intent_id, 'confirmed', at);", "chains.settleIntent(initial.intent.intent_id, 'failed', at);", '@osstack/cli', ['src/contained-mission-grant.test.ts', '-t', 'issues a signed grant']],
  ['no-readback-range-check', publication, "if (digest(compared) !== digest(commits) || (readback.state === 'OPEN' && readback.headRefOid !== permit.head)) {", 'if (false) {', '@osstack/cli', pubTests],
];
const root = resolve(import.meta.dirname, '..');
const out = await createScratchDir('smoke', 'bridge-phase5-mutants');
const results = [];
const selected = process.argv.slice(2);
function run(pkg, tests, label) {
  const result = spawnSync('pnpm', ['--filter', pkg, 'test', ...tests], { cwd: root, encoding: 'utf8', env: process.env, timeout: 180000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(resolve(out, `${label}.log`), output);
  return { status: result.status, signal: result.signal, output };
}
const suites = new Set();
for (const [name, file, from, to, pkg, tests] of mutants) {
  if (selected.length && !selected.includes(name)) continue;
  const suite = JSON.stringify([pkg, tests]);
  if (!suites.has(suite)) {
    const baseline = run(pkg, tests, `baseline-${suites.size}`);
    if (baseline.status !== 0) throw Error(`baseline failed; inspect ${out}`);
    suites.add(suite);
  }
  const path = resolve(root, file); const original = readFileSync(path, 'utf8');
  if (original.split(from).length !== 2) throw Error(`mutation target not unique: ${name}`);
  try {
    writeFileSync(path, original.replace(from, to));
    const result = run(pkg, tests, name);
    const assertion = /FAIL\s+src\/[^\n]+ >/.test(result.output);
    const invalid = /Transform failed|Failed to load|Cannot find module|SyntaxError:|Parse failure/.test(result.output);
    const verdict = result.status === 0 ? 'survived' : assertion && !invalid ? 'killed' : 'invalid';
    results.push({ name, file, command: ['pnpm', '--filter', pkg, 'test', ...tests], verdict, status: result.status });
    writeFileSync(resolve(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    console.log(`${name}: ${verdict}`);
  } finally { writeFileSync(path, original); }
}
console.log(`Evidence: ${out}`);
if (results.some(r => r.verdict !== 'killed')) process.exitCode = 1;
