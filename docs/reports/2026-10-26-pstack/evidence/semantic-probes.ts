// Read-only research against the pinned upstream code; fake forge, isolated store.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [upstream, scratch] = process.argv.slice(2);
if (!upstream || !scratch) throw new Error('upstream and scratch are required');
const load = (p: string) => import(pathToFileURL(join(upstream, p)).href);
const { readSnapshot, classifyPr } = await load('skills/poteto-mode/scripts/watch-pr/policy.ts');
const { fakeReader } = await load('skills/poteto-mode/scripts/watch-pr/fakes.test-helper.ts');
const { openStore } = await load('skills/poteto-mode/scripts/orch/store.ts');
const { parseMermaid, parseValue } = await load('skills/statechart/scripts/lib.mjs');
const results: Record<string, unknown>[] = [];
for (const facts of [
  { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' },
  { mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' },
]) {
  const snapshot = await readSnapshot({ reader: fakeReader({ facts }), context: { owner: 'example', repo: 'fixture', number: 1 }, pendingHistory: 'include', allowDraft: false });
  const decision = classifyPr(snapshot);
  assert.equal(decision.kind, 'ready');
  results.push({ probe: 'watcher-ready-semantics', facts, observed: decision.kind,
    interpretation: 'Upstream ready is not sufficient evidence of forge permission or trusted OSStack authorization.' });
}
const store = openStore(join(scratch, 'ledger'));
try {
  await store.init();
  await store.ledger.record({ pr: 1, sha: 'not-a-commit', verdict: 'verifier-failed', evidence: 'missing-file', verifier: 'reviewer' });
  await store.ledger.record({ pr: 1, sha: 'not-a-commit', verdict: 'live-ui-verified', evidence: 'also-missing', verifier: 'worker' });
  const row = await store.ledger.check({ pr: 1, sha: 'not-a-commit' });
  assert.equal(row.verifier, 'worker');
  assert.equal(row.verdict, 'live-ui-verified');
  results.push({ probe: 'ledger-last-writer', observed: row, interpretation: 'The store is a bookkeeping layer; SHA validity, evidence existence and verifier precedence are not authenticated here.' });
  let refused = false;
  try { await store.ledger.check({ pr: 1, sha: 'another-head' }); } catch { refused = true; }
  assert.equal(refused, true);
  results.push({ probe: 'ledger-exact-head-key', observed: 'different key rejected' });
} finally { await store.close(); }
const chart = parseMermaid('stateDiagram-v2\n[*] --> Idle\nIdle --> Busy : begin\nBusy --> Done : finish');
assert.equal(chart.regions.Main.transitions.length, 2);
results.push({ probe: 'statechart-parser', observed: 'two observable transitions parsed' });
assert.equal(parseValue('TRUE'), true);
results.push({ probe: 'tlc-value-parser', observed: 'TRUE parsed as boolean' });
console.log(JSON.stringify({ status: 'pass', probes: results }, null, 2));
