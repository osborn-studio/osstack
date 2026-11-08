#!/usr/bin/env node
// Run source mutants sequentially and restore each file before the next run.
// A failed build/import is not a killed mutant. This never calls a live CLI or GitHub.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createScratchDir } from './lib/scratch.mjs';
import { classifyMutationResult, classifyProtectedPathMutationResult, selectMutationNames, validateProtectedPathBaseline } from './lib/bridge-mutation-result.mjs';

const publication = 'packages/cli/src/contained-mission-revision-publication.ts';
const store = 'packages/core/src/state/engineering-revision-chain-store.ts';
const ddl = 'packages/core/src/state/engineering-revision-chain-ddl.ts';
const runner = 'packages/cli/src/contained-mission-runner.ts';
const classifier = 'packages/governance/src/mission-patch/classify.ts';
const protectedPathMutant = 'no-adversarial-protected-path-finding';
const protectedPathOracle = 'packages/cli/src/contained-mission-adversarial.test.ts';
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
  // Suppress only this fixture's finding, including cumulative classification.
  // Do not alter protected-set.ts/digest or merely bypass the first T2 branch.
  [protectedPathMutant, classifier,
    'if (protectedRules.length > 0) findings.push({ code: "PROTECTED_PATH", path: file.path, rules: protectedRules });',
    'if (protectedRules.length > 0 && file.path !== ".github/workflows/osstack-5g-injected.yml") findings.push({ code: "PROTECTED_PATH", path: file.path, rules: protectedRules });',
    '@osstack/cli', ['src/contained-mission-adversarial.test.ts', '--maxWorkers=1', '-t', 'offline protected workflow proposal halts before local application']],
];
const root = resolve(import.meta.dirname, '..');
const selected = selectMutationNames(mutants.map(([name]) => name), process.argv.slice(2));
const out = await createScratchDir('smoke', 'bridge-phase5-mutants');
const results = [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
function run(pkg, tests, label) {
  const command = ['pnpm', '--filter', pkg, 'test', ...tests];
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', env: process.env, timeout: 180000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(resolve(out, `${label}.log`), output);
  return { command, log: `${label}.log`, output_sha256: sha256(output), status: result.status, signal: result.signal, error: result.error, output };
}
const suites = new Map();
const execution = ({ command, log, output_sha256, status, signal, error }) => ({ command, cwd: root, log, output_sha256, status, signal, spawn_error: error?.code ?? null });
for (const [name, file, from, to, pkg, tests] of mutants) {
  if (!selected.includes(name)) continue;
  const path = realpathSync(resolve(root, file)); const original = readFileSync(path, 'utf8');
  if (original.split(from).length !== 2) throw Error(`mutation target not unique: ${name}`);
  const baselineSourceHash = sha256(original);
  const oracleHash = name === protectedPathMutant ? sha256(readFileSync(resolve(root, protectedPathOracle))) : null;
  const suite = JSON.stringify([pkg, tests]);
  if (!suites.has(suite)) {
    const baseline = run(pkg, tests, `baseline-${suites.size}`);
    if (classifyMutationResult(baseline) !== 'survived') throw Error(`baseline failed; inspect ${out}`);
    suites.set(suite, baseline);
  }
  if (sha256(readFileSync(path)) !== baselineSourceHash) throw Error(`baseline changed source: ${name}`);
  const baseline = suites.get(suite);
  if (name === protectedPathMutant && !validateProtectedPathBaseline(baseline, path, baselineSourceHash)) {
    throw Error(`protected-path baseline evidence invalid; inspect ${out}`);
  }
  const mutated = original.replace(from, to);
  let record;
  const restore = () => writeFileSync(path, original);
  const interrupted = () => { restore(); process.exit(130); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  process.once('exit', restore);
  try {
    writeFileSync(path, mutated);
    const result = run(pkg, tests, name);
    const verdict = name === protectedPathMutant
      ? classifyProtectedPathMutationResult({ baseline, mutant: result, sourcePath: path,
        baselineSourceHash, mutantSourceHash: sha256(mutated) })
      : classifyMutationResult(result);
    record = { name, file, ...execution(result), verdict,
      baseline: { ...execution(baseline), source_sha256: baselineSourceHash },
      mutant_source_sha256: sha256(mutated), observed_mutant_source_sha256: sha256(readFileSync(path)) };
    if (name === protectedPathMutant) {
      record.oracle = { file: protectedPathOracle, baseline_sha256: oracleHash,
        after_mutant_sha256: sha256(readFileSync(resolve(root, protectedPathOracle))) };
      if (record.oracle.after_mutant_sha256 !== oracleHash) record.verdict = 'invalid';
    }
  } finally {
    restore(); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    process.removeListener('exit', restore);
  }
  record.restored_source_sha256 = sha256(readFileSync(path));
  record.source_restored = record.restored_source_sha256 === baselineSourceHash;
  if (!record.source_restored || record.observed_mutant_source_sha256 !== record.mutant_source_sha256) record.verdict = 'invalid';
  results.push(record);
  writeFileSync(resolve(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`${name}: ${record.verdict}`);
}
console.log(`Evidence: ${out}`);
if (results.some(r => r.verdict !== 'killed')) process.exitCode = 1;
