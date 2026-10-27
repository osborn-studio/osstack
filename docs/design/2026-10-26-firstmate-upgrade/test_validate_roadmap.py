"""End-to-end negative fixtures for the read-only roadmap validator."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


class RoadmapValidationTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(os.environ.get('OSSTACK_SCRATCH_ROOT', Path(tempfile.gettempdir()) / 'osstack')) / 'tests'
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='roadmap-validator-', dir=scratch)
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.folder = root / HERE.relative_to(REPO)
        shutil.copytree(HERE, self.folder, ignore=shutil.ignore_patterns('__pycache__'))
        old = REPO / 'docs/design/2026-10-25-engineering-agent'
        for name in ['work-items.json', 'capabilities.json', 'sources.json', 'semantic-divergences.json']:
            target = root / (old / name).relative_to(REPO)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(old / name, target)
        for name in ['2026-10-26-session-pilot-delivery.json', '2026-10-25-session-adoption-pilot.md']:
            target = root / 'docs/reports' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / 'docs/reports' / name, target)

    def mutate(self, filename, operation):
        path = self.folder / filename
        data = json.loads(path.read_text())
        operation(data)
        path.write_text(json.dumps(data, ensure_ascii=False))

    def run_validator(self, verify_sources=False):
        command = [sys.executable, str(self.folder / 'validate-roadmap.py'), '--osstack-repo', str(REPO)]
        if verify_sources:
            command += ['--verify-sources', '--firstmate-repo', os.environ['OSSTACK_FIRSTMATE_REPO']]
        return subprocess.run(command, capture_output=True, text=True, timeout=30)

    def assert_rejected(self, reason=None):
        result = self.run_validator()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        if reason:
            self.assertIn(reason, result.stderr)

    def refresh_snapshot(self):
        path = self.folder / 'review-snapshot.json'
        data = json.loads(path.read_text())
        data['file_sha256'] = {name: hashlib.sha256((self.folder / name).read_bytes()).hexdigest() for name in data['file_sha256']}
        path.write_text(json.dumps(data))

    def test_current_snapshot_passes(self):
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)['runtime_qualification'])

    def test_planned_cannot_project_to_done(self):
        self.mutate('work-packages.json', lambda d: d['state_to_board'].update(planned='done'))
        self.refresh_snapshot()
        self.assert_rejected('invalid status projection')

    def test_readme_cannot_replace_completion_evidence(self):
        self.mutate('work-packages.json', lambda d: [x.update(evidence_refs=['README.md']) for x in d['items'] if x['current_state'] == 'local_pilot_complete'])
        self.refresh_snapshot()
        self.assert_rejected('completion evidence substituted')

    def test_blocker_changes_require_an_updated_snapshot(self):
        self.mutate('work-packages.json', lambda d: [x.update(current_state='planned') for x in d['items'] if x['current_state'] == 'partial_blocked'])
        self.assert_rejected()

    def test_upstream_reference_must_be_a_commit(self):
        self.mutate('source-additions.json', lambda d: d['sources'][0].update(commit='HEAD'))
        self.refresh_snapshot()
        self.assert_rejected('immutable SHA')

    def test_cross_cutting_list_cannot_hide_an_executor_gap(self):
        def change(data):
            data['cross_cutting_work'].append('E03')
            for cap in data['capabilities']:
                cap['required_work_items'] = [x for x in cap['required_work_items'] if x != 'E03']
        self.mutate('capability-map.json', change)
        self.refresh_snapshot()
        self.assert_rejected('cross-cutting')

    def test_frozen_source_substitution(self):
        path = self.folder / '../2026-10-25-engineering-agent/sources.json'
        data = json.loads(path.read_text())
        data['sources'][0]['path'] = 'README.md'
        data['sources'][0]['sha256'] = 'a' * 64
        path.write_text(json.dumps(data))
        self.assert_rejected('frozen source manifest changed')

    def test_historical_evidence_content_change(self):
        path = self.folder / '../../reports/2026-10-26-session-pilot-delivery.json'
        path.write_text(path.read_text() + ' ')
        self.assert_rejected('historical evidence changed')

    def test_missing_blocker_owner(self):
        self.mutate('work-packages.json', lambda d: [x.update(owner_role='') for x in d['items'] if x['id']=='D07'])
        self.refresh_snapshot()
        self.assert_rejected('missing owner_role')

    def test_source_traversal(self):
        self.mutate('source-additions.json', lambda d: d['sources'][0].update(path='../outside'))
        self.refresh_snapshot()
        self.assert_rejected('not confined')

    def test_source_option_shaped_commit(self):
        self.mutate('source-additions.json', lambda d: d['sources'][0].update(commit='--help'))
        self.refresh_snapshot()
        self.assert_rejected('immutable SHA')

    def test_reference_absolute_path(self):
        self.mutate('work-packages.json', lambda d: d.update(base_plan=str(REPO/'README.md')))
        self.assert_rejected('relative')

    def test_reference_symlink_escape(self):
        path = self.folder / 'outside.md'
        path.symlink_to(REPO / 'README.md')
        self.mutate('work-packages.json', lambda d: [x.update(evidence_refs=['outside.md']) for x in d['items'] if x['id']=='D07'])
        self.assert_rejected('escapes repository')

    def test_milestone_cycle(self):
        self.mutate('delivery-gates.json', lambda d: d['milestones'][0]['requires'].append('I01.local_contract'))
        self.refresh_snapshot()
        self.assert_rejected('milestone cycle')

    def test_host_qualification_not_required_for_local_contract(self):
        gates = json.loads((self.folder/'delivery-gates.json').read_text())
        nodes = {g['id']: g for g in gates['milestones']}
        def closure(gid):
            return {gid}.union(*(closure(x) for x in nodes[gid]['requires']))
        self.assertFalse(any(nodes[n]['phase']=='host_qualified' for n in closure('I01.local_contract')))
        self.assertIn('V03.host_measurement', closure('D08.host_qualification'))

    def test_stale_board_projection(self):
        self.mutate('board-projection.json', lambda d: d.update(work_manifest_sha256='0'*64))
        self.refresh_snapshot()
        self.assert_rejected('stale board projection')

    def test_wrong_board_state(self):
        self.mutate('board-projection.json', lambda d: d['cards']['R01'].update(status='done'))
        self.refresh_snapshot()
        self.assert_rejected('board status differs')

    def test_duplicate_json_key(self):
        path = self.folder/'board-projection.json'
        path.write_text(path.read_text().replace('{', '{"kind":"duplicate",', 1))
        self.refresh_snapshot()
        self.assert_rejected('duplicate JSON key')

    def test_inventory_cannot_claim_contract(self):
        self.mutate('source-additions.json', lambda d: d['sources'][-1].update(inspection='path_and_hash_verified'))
        self.refresh_snapshot()
        self.assert_rejected('hash-only source')

    def test_planned_scenario_not_passed(self):
        self.mutate('audit-contracts.json', lambda d: d['scenarios'][0].update(status='passed'))
        self.refresh_snapshot()
        self.assert_rejected('falsely reported')

    def test_behavior_shape(self):
        self.mutate('capability-map.json', lambda d: d['capabilities'][0].update(negative_cases={'not':'a list'}))
        self.refresh_snapshot()
        self.assert_rejected('expected list')


    def test_schema_gate_missing(self):
        self.mutate('delivery-gates.json', lambda d: [x.update(requires=[]) for x in d['milestones'] if x['id']=='C03.budget_storage'])
        self.refresh_snapshot()
        self.assert_rejected('schema lacks prior recovery gate')

    def test_contract_blocked_by_host(self):
        self.mutate('delivery-gates.json', lambda d: d['milestones'][0]['requires'].append('V03.host_measurement'))
        self.refresh_snapshot()
        self.assert_rejected('contract blocked on host qualification')

    def test_default_cannot_skip_opt_in(self):
        self.mutate('delivery-gates.json', lambda d: d['release_requirements']['S2_default_enable'].remove('DEBT02.recovery_contract'))
        self.refresh_snapshot()
        self.assert_rejected('default gate omits')

    def test_digest_mutation_gap(self):
        self.mutate('audit-contracts.json', lambda d: d['scenarios'][7]['mutated_fields'].remove('executor_version'))
        self.refresh_snapshot()
        self.assert_rejected('effect digest mutation coverage')

    def test_external_dependency_fake_qualification(self):
        self.mutate('audit-contracts.json', lambda d: d['external_dependencies'][0].update(status='qualified',version='invented'))
        self.refresh_snapshot()
        self.assert_rejected('unverified external qualification')

    def test_code_digest_changed(self):
        self.mutate('current-evidence.json', lambda d: d['code_files'][0].update(sha256='0'*64))
        self.refresh_snapshot()
        self.assert_rejected('current code evidence changed')

    def test_ci_candidate_changed(self):
        self.mutate('current-evidence.json', lambda d: d['ci_observation'].update(headSha='0'*40))
        self.refresh_snapshot()
        self.assert_rejected('CI candidate mismatch')

    def test_equivalence_scope_narrowed(self):
        self.mutate('current-evidence.json', lambda d: d['equivalence'].update(paths=['packages']))
        self.refresh_snapshot()
        self.assert_rejected('runtime equivalence not established')

    def test_normative_document_changed(self):
        path=self.folder/'audit-revision.md'
        path.write_text(path.read_text()+'\nChanged rule.\n')
        self.assert_rejected('stale review snapshot')

    @unittest.skipUnless(os.environ.get('OSSTACK_FIRSTMATE_REPO'), 'fixed Firstmate clone needed for Git source integration test')
    def test_actual_git_source_hash_mismatch(self):
        self.mutate('source-additions.json', lambda d: d['sources'][0].update(sha256='0'*64))
        self.refresh_snapshot()
        result=self.run_validator(verify_sources=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('source hash mismatch',result.stderr)



    def test_schema_target_cannot_reuse_other_recovery(self):
        self.mutate('delivery-gates.json', lambda d: [x.update(schema_change_id='different-schema') for x in d['milestones'] if x['id']=='C03.budget_storage'])
        self.refresh_snapshot()
        self.assert_rejected('schema recovery target mismatch')

    def test_host_qualification_requires_measurement(self):
        self.mutate('delivery-gates.json', lambda d: [x.update(requires=[]) for x in d['milestones'] if x['id']=='E01.recoverable_profile'])
        self.refresh_snapshot()
        self.assert_rejected('host qualification lacks independent measurement')

    def test_recovery_requires_legacy_hold_contract(self):
        self.mutate('delivery-gates.json', lambda d: [x['requires'].remove('DEBT02.recovery_contract') for x in d['milestones'] if x['id']=='I04.recovery_home'])
        self.refresh_snapshot()
        self.assert_rejected('recovery lacks legacy hold operator contract')


if __name__ == '__main__':
    unittest.main()
