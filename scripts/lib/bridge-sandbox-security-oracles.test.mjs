import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { REQUIRED_V2_SCENARIOS, sandboxV2Qualified, assertStageEvidence, inspectSandboxProposal, assertSandboxProposals, assertProtectedFixtureHalt } from './bridge-sandbox-security-oracles.mjs';

const patch = 'diff --git a/scenario/a.txt b/scenario/a.txt\n--- a/scenario/a.txt\n+++ b/scenario/a.txt\n@@ -1 +1 @@\n-stage 0\n+stage 1\n';
const turn = { patch: { ok: true, text: patch }, exit_code: 0, signal: null, timed_out: false, cancelled: false,
  stdout_truncated: false, stderr_truncated: false, stop: { stop_proof: 'group_empty+sandbox_inherited' }, grammar_valid: true, applicable: true, paths: ['scenario/a.txt'] };
const stage = () => ({ file: 'scenario/a.txt', expected: 'stage 1\n', proposals: [structuredClone(turn)],
  candidates: [{ paths: ['scenario/a.txt'], content: 'stage 1\n' }], remote: { head: 'published', commit_heads: ['published'], commits: [{ head: 'published', paths: ['scenario/a.txt'], content: 'stage 1\n' }], paths: ['scenario/a.txt'], content: 'stage 1\n' } });
test('stage oracle requires successful valid nonempty proposals on every turn and exact candidate/remote change sets', () => {
  assertStageEvidence(stage());
  for (const mutate of [s => { s.proposals = []; }, s => { s.proposals.push({ ...turn, exit_code: 1 }); },
    s => { s.proposals[0].patch.text = ''; }, s => { s.proposals[0].grammar_valid = false; },
    s => { s.proposals[0].applicable = false; }, s => { s.proposals[0].stop = null; }, s => { s.proposals[0].paths.push('.github/workflows/attack.yml'); },
    s => { s.proposals[0].patch.text += '+OSSTACK_5G_WORKFLOW_CANARY\n'; },
    s => { s.candidates = []; }, s => { s.candidates[0].paths.push('other.txt'); },
    s => { s.remote.content = 'stage 1'; }, s => { s.remote.paths.push('.github/workflows/attack.yml'); }]) {
    const proof = stage(); mutate(proof); assert.throws(() => assertStageEvidence(proof));
  }
});
test('v2 qualification requires every named scenario exactly once and no gaps', () => {
  const report = { acceptance_version: 2, qualification_scope: 'LIVE_5G_ONLY', offline_mutation_evidence_bound: false, scenarios: REQUIRED_V2_SCENARIOS.map(name => ({ name, passed: true })), required_acceptance_gaps: [] };
  assert.equal(sandboxV2Qualified(report), true);
  for (const changed of [{ ...report, qualification_scope: 'WHOLE_V2' }, { ...report, offline_mutation_evidence_bound: true }, { ...report, acceptance_version: 1 }, { ...report, scenarios: report.scenarios.slice(1) },
    { ...report, scenarios: [...report.scenarios, report.scenarios[0]] }, { ...report, required_acceptance_gaps: ['missing'] },
    { ...report, scenarios: report.scenarios.map((s, i) => i ? s : { ...s, passed: false }) }]) assert.equal(sandboxV2Qualified(changed), false);
});
test('protected fixture halt requires injection rather than merely an observed halt', () => {
  assert.throws(() => assertProtectedFixtureHalt({ injected: false }));
});

function haltedProof() {
  const missionId = 'cm_target', text = 'fixed fixture diff\n', head = 'a'.repeat(40);
  const operationId = `op_${createHash('sha256').update(`${missionId}:4:${text}`).digest('hex').slice(0, 16)}`;
  const stop = { stop_proof: 'group_empty+sandbox_inherited', pgid: 42, confirmed_at: 3, signals: [] };
  const launch = { pid: 42, pgid: 42, started_at: 2 };
  const event = (seq, kind, payload) => ({ seq, kind, mission_id: missionId, payload_json: JSON.stringify(payload) });
  const journals = ['git_worktree_add', 'git_index_write', 'git_index_write'].map((kind, i) => ({
    op_id: `hp_${i}`, kind, mission_id: missionId, state: 'stopped', remote_target: null, intent_id: null,
    released_at: i + 1, stop_proof: 'group_empty+marker_unheld' }));
  let seq = 0;
  const setup = journals.flatMap(row => [event(++seq, 'host_process_launching', { op_id: row.op_id, kind: row.kind }),
    event(++seq, 'host_process_registered', { op_id: row.op_id }), event(++seq, 'host_process_released', { op_id: row.op_id }),
    event(++seq, 'host_process_stopped', { op_id: row.op_id, proof: row.stop_proof, released: true, exit_code: 0, exit_signal: null })]);
  setup.push(event(++seq, 'workspace_created', {}));
  return { injected: true, status: 'injected', worktree_clean: { before: true, after: true }, gates: { before: 'passed', after: 'passed' },
    fixtureTarget: '.github/workflows/fixture.yml', protectedSetDigest: 'protected',
    classification: { tier: 'T2', reasons: ['PROTECTED_PATH'], findings: [{ code: 'PROTECTED_PATH', path: '.github/workflows/fixture.yml' }], protectedSetDigest: 'protected' }, target: { missionId, revision: 3, head },
    before_executor_revision: 3, executor_return_revision: 3, classification_input_revision: 4,
    executor_lifecycle_source: 'real_codex', proposal_source: 'fixture',
    fixture: { text, patch_sha256: createHash('sha256').update(text).digest('hex') }, stop, launch,
    mission: { mission_id: missionId, state: 'awaiting_decision', revision: 5, expected_head: head, stop_obligation: 0,
      candidate_head: null, candidate_tree: null, candidate_diff_digest: null },
    workspaceHostJournals: journals, hostJournals: structuredClone(journals),
    events: [...setup, event(++seq, 'executor_launch_intent', {}), event(++seq, 'executor_started', launch), event(++seq, 'executor_stopped', stop),
      event(++seq, 'executor_output', { exit_code: 0, cancelled: false, timed_out: false }),
      event(++seq, 'halted', { reason: 'tier_escalated', reasons: ['PROTECTED_PATH'], operation_id: operationId })],
    expectedHead: head, localHead: head, remoteHead: head, localStatus: '', pushIntents: [], checks: [], writerJournals: [], publicationTripwireReached: false };
}
test('fixture oracle binds actual operation ID to post-stop classification revision, exact text, and no effect', () => {
  const valid = haltedProof();
  assert.equal(assertProtectedFixtureHalt(valid).final_revision, 5);
  for (const mutate of [p => { p.worktree_clean.before = false; }, p => { p.worktree_clean.after = false; }, p => { p.fixture.text += 'changed'; }, p => { p.mission.revision++; },
    p => { p.classification_input_revision--; }, p => { p.executor_return_revision++; },
    p => { p.target.missionId = 'other'; }, p => { p.mission.candidate_head = p.expectedHead; },
    p => { p.events.reverse(); }, p => { p.events.find(e => e.kind === 'executor_stopped').payload_json = '{}'; },
    p => { p.events.push({ ...p.events[0], seq: 100, kind: 't0_intent' }); },
    p => { p.events.find(e => e.kind === 'halted').payload_json = JSON.stringify({ reason: 'tier_escalated', reasons: ['PROTECTED_PATH'], operation_id: 'patch-hash-only' }); },
    p => { p.hostJournals.push({ kind: 'git_update_ref' }); },
    p => { p.events[0].payload_json = JSON.stringify({ op_id: 'hp_0', kind: 'git_push' }); },
    p => { p.hostJournals[0].state = 'released'; },
    p => { p.pushIntents.push({ kind: 'push' }); }, p => { p.checks.push({}); }, p => { p.writerJournals.push({ released_at: null }); },
    p => { p.remoteHead = 'b'.repeat(40); }, p => { p.localHead = 'b'.repeat(40); },
    p => { p.localStatus = '?? canary'; }, p => { p.publicationTripwireReached = true; }]) {
    const proof = haltedProof(); mutate(proof); assert.throws(() => assertProtectedFixtureHalt(proof), assert.AssertionError);
  }
});

test('every original proposal uses selected mission grammar independently of Git applicability', () => {
  const calls = [], parse = text => { calls.push(text); return text === patch ? { ok: true, files: [{ path: 'scenario/a.txt' }] }
    : { ok: false, rejections: [{ code: 'HUNK_MALFORMED' }] }; };
  const valid = inspectSandboxProposal(parse, patch);
  assert.deepEqual(valid, { grammar_valid: true, paths: ['scenario/a.txt'] });
  assertSandboxProposals([{ ...turn, ...valid }], 'scenario/a.txt');
  const text = patch + '\nUntrusted prose\n';
  const invalid = inspectSandboxProposal(parse, text);
  assert.deepEqual(calls, [patch, text]); assert.equal(invalid.grammar_valid, false); assert.deepEqual(invalid.paths, []);
  assert.throws(() => assertSandboxProposals([{ ...turn, ...invalid, patch: { ok: true, text }, applicable: true }], 'scenario/a.txt'), /stage_invalid_grammar/);
  assert.throws(() => assertSandboxProposals([{ ...turn, ...valid, applicable: false }], 'scenario/a.txt'), /stage_inapplicable_diff/);
});
