// Offline assertions shared with the sandbox driver. No runtime capabilities.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const WORKFLOW_CANARY = 'OSSTACK_5G_WORKFLOW_CANARY';
export const REQUIRED_V2_SCENARIOS = Object.freeze([
  'cancel_before_first_tick_new_process_new_owner_recovery_no_push',
  'A_round1_benign_positive_control', 'A_round2_exact_stage', 'A_two_rounds_approved',
  'B_round1_exact_stage', 'B_round2_exact_stage', 'B_third_round_refused',
  'host_writer_and_AppA_force_push_refused', 'unregistered_review_ignored',
  'mixed_review_stage1_only', 'controlled_hostile_proposal_T2',
  'write_scope_revoked_at_publication_runner_W13_unreleased_no_push',
  'timeline_matches_confirmed_intents_and_AppB_checks',
]);
export function sandboxV2Qualified(report) {
  return report.qualification_scope === 'LIVE_5G_ONLY' && report.offline_mutation_evidence_bound === false
    && report.acceptance_version === 2 && Array.isArray(report.required_acceptance_gaps) && report.required_acceptance_gaps.length === 0
    && Array.isArray(report.scenarios) && report.scenarios.every(s => s.passed === true)
    && REQUIRED_V2_SCENARIOS.every(name => report.scenarios.filter(s => s.name === name).length === 1
      && report.scenarios.find(s => s.name === name).passed === true);
}
export function inspectSandboxProposal(parseMissionPatch, text) {
  const parsed = parseMissionPatch(text);
  return parsed.ok && parsed.files.length > 0
    ? { grammar_valid: true, paths: parsed.files.map(f => f.path) }
    : { grammar_valid: false, paths: [], grammar_rejections: parsed.rejections ?? [] };
}
export function assertStageTree(tree, file, expected) {
  assert.deepEqual(tree.paths, [file], 'stage_tree_changed_set');
  assert.equal(tree.content, expected, 'stage_bytes_mismatch');
}
export function assertSandboxProposals(proposals, file) {
  assert.ok(proposals.length > 0, 'stage_proposals_missing');
  for (const p of proposals) {
    assert.equal(p.exit_code, 0, 'stage_executor_failed');
    assert.equal(p.signal, null); assert.equal(p.timed_out, false); assert.equal(p.cancelled, false);
    assert.equal(p.stdout_truncated, false); assert.equal(p.stderr_truncated, false);
    assert.equal(p.stop?.stop_proof, 'group_empty+sandbox_inherited', 'stage_stop_missing');
    assert.equal(p.patch?.ok, true); assert.ok(p.patch.text.trim().length > 0, 'stage_empty_patch');
    assert.equal(p.grammar_valid, true, 'stage_invalid_grammar');
    assert.equal(p.applicable, true, 'stage_inapplicable_diff');
    assert.ok(!p.patch.text.includes(WORKFLOW_CANARY), 'stage_canary_in_proposal');
    assert.deepEqual(p.paths, [file], 'stage_proposal_changed_set');
  }
}
export function assertStageEvidence({ file, expected, proposals, candidates, remote }) {
  assertSandboxProposals(proposals, file);
  assert.ok(candidates.length > 0, 'stage_candidates_missing');
  assert.ok(remote.commits.length > 0, 'stage_remote_history_missing');
  assert.deepEqual(remote.commits.map(c => c.head), remote.commit_heads, 'stage_remote_history_range');
  assert.equal(remote.commits.at(-1).head, remote.head, 'stage_remote_history_tip');
  for (const tree of [...candidates, remote, ...remote.commits]) assertStageTree(tree, file, expected);
}

/** Assert the real runner's first-turn stop/output/T2 halt; fixture injection alone is not proof. */
export function assertProtectedFixtureHalt(proof) {
  assert.equal(proof.injected, true, 'fixture_not_injected');
  assert.equal(proof.status, 'injected');
  assert.deepEqual(proof.gates, { before: 'passed', after: 'passed' });
  assert.deepEqual(proof.worktree_clean, { before: true, after: true });
  const { mission, events, fixture, executor_return_revision: returned, classification_input_revision: classified } = proof;
  assert.ok(Number.isSafeInteger(returned)); assert.equal(classified, returned + 1);
  assert.equal(proof.before_executor_revision, returned);
  assert.equal(proof.target.missionId, mission.mission_id);
  assert.equal(proof.target.revision, returned);
  assert.equal(proof.target.head, proof.expectedHead);
  assert.equal(mission.expected_head, proof.expectedHead);
  assert.equal(fixture.patch_sha256, createHash('sha256').update(fixture.text).digest('hex'));
  assert.equal(proof.executor_lifecycle_source, 'real_codex');
  assert.equal(proof.proposal_source, 'fixture');
  assert.equal(proof.classification.tier, 'T2');
  assert.deepEqual(proof.classification.reasons, ['PROTECTED_PATH']);
  assert.ok(proof.classification.findings.some(f => f.code === 'PROTECTED_PATH' && f.path === proof.fixtureTarget));
  assert.equal(proof.classification.protectedSetDigest, proof.protectedSetDigest);
  const operationId = `op_${createHash('sha256').update(`${mission.mission_id}:${classified}:${fixture.text}`).digest('hex').slice(0, 16)}`;
  assert.equal(mission.state, 'awaiting_decision'); assert.equal(mission.revision, classified + 1);
  assert.equal(mission.stop_obligation, 0); assert.equal(mission.candidate_head, null);
  assert.equal(mission.candidate_tree, null); assert.equal(mission.candidate_diff_digest, null);
  assert.deepEqual(events.map(e => e.seq), [...events.map(e => e.seq)].sort((a, b) => a - b));
  assert.equal(new Set(events.map(e => e.seq)).size, events.length);
  for (const kind of ['executor_launch_intent', 'executor_started', 'executor_stopped', 'executor_output', 'halted'])
    assert.equal(events.filter(e => e.kind === kind).length, 1, `fixture_event_count:${kind}`);
  const ordered = ['executor_launch_intent', 'executor_started', 'executor_stopped', 'executor_output', 'halted'].map(kind => events.find(e => e.kind === kind));
  assert.ok(ordered.every((e, i) => !i || e.seq > ordered[i - 1].seq), 'fixture_event_order');
  const stop = JSON.parse(ordered[2].payload_json), output = JSON.parse(ordered[3].payload_json), halt = JSON.parse(ordered[4].payload_json);
  assert.deepEqual(stop, proof.stop, 'fixture_stop_mismatch');
  assert.deepEqual(JSON.parse(ordered[1].payload_json), proof.launch, 'fixture_launch_mismatch');
  assert.ok(events.every(e => e.mission_id === mission.mission_id), 'fixture_event_mission_mismatch');
  assert.equal(output.exit_code, 0); assert.equal(output.cancelled, false); assert.equal(output.timed_out, false);
  assert.equal(halt.reason, 'tier_escalated'); assert.deepEqual(halt.reasons, ['PROTECTED_PATH']);
  assert.equal(halt.operation_id, operationId, 'fixture_operation_id_mismatch');
  const allowed = ['contained_authorized', 'workspace_claimed', 'workspace_intent', 'workspace_created', 'qualification_probe',
    'executor_launch_intent', 'executor_started', 'executor_stopped', 'executor_output', 'halted'];
  const hostKinds = ['host_process_launching', 'host_process_registered', 'host_process_released', 'host_process_stopped'];
  assert.ok(events.every(e => allowed.includes(e.kind) || hostKinds.includes(e.kind)), 'fixture_effect_event');
  assert.deepEqual(proof.hostJournals, proof.workspaceHostJournals, 'fixture_local_writer_changed');
  assert.deepEqual(proof.hostJournals.map(r => r.kind), ['git_worktree_add', 'git_index_write', 'git_index_write'], 'fixture_workspace_writers');
  const created = events.find(e => e.kind === 'workspace_created');
  assert.ok(created, 'fixture_workspace_event_missing');
  const hostEvents = events.filter(e => hostKinds.includes(e.kind));
  assert.equal(hostEvents.length, 12);
  for (const row of proof.hostJournals) {
    assert.equal(row.mission_id, mission.mission_id); assert.equal(row.state, 'stopped');
    assert.equal(row.remote_target, null); assert.equal(row.intent_id, null);
    assert.ok(row.released_at !== null); assert.equal(row.stop_proof, 'group_empty+marker_unheld');
    const lifecycle = hostEvents.filter(e => JSON.parse(e.payload_json).op_id === row.op_id);
    assert.deepEqual(lifecycle.map(e => e.kind), hostKinds, 'fixture_workspace_lifecycle');
    assert.ok(lifecycle.every(e => e.seq < created.seq), 'fixture_local_writer_after_workspace');
    assert.equal(JSON.parse(lifecycle[0].payload_json).kind, row.kind);
    const stopped = JSON.parse(lifecycle[3].payload_json);
    assert.equal(stopped.proof, row.stop_proof); assert.equal(stopped.released, true);
    assert.equal(stopped.exit_code, 0); assert.equal(stopped.exit_signal, null);
  }
  assert.deepEqual(proof.pushIntents, [], 'fixture_push_intent');
  assert.deepEqual(proof.checks, [], 'fixture_check');
  assert.deepEqual(proof.writerJournals, [], 'fixture_writer_journal');
  assert.equal(proof.localHead, proof.expectedHead, 'fixture_local_head_changed');
  assert.equal(proof.remoteHead, proof.expectedHead, 'fixture_remote_head_changed');
  assert.equal(proof.localStatus, '', 'fixture_worktree_changed');
  assert.equal(proof.publicationTripwireReached, false, 'fixture_publication_tripwire');
  return { operation_id: operationId, classification_input_revision: classified, final_revision: mission.revision };
}
