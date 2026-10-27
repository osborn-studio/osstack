import importlib.util
import json
import hashlib
import unittest
from unittest.mock import patch
from pathlib import Path
p=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('execution',p/'validate-execution.py')
v=importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.data=json.loads((p/'evidence/joint-execution/successors-retarget/ledger-before.json').read_text())
        # Upgrade only the test fixture's legacy Ready metadata; preserved snapshot bytes stay unchanged.
        part=next(s for n in self.data['milestones'] for s in n['slices'] if s.get('pr')==273)
        part['state']='open'  # Old audit-binding format cannot be promoted as newly Ready.
        part.update(base_sha=self.data['main_sha'],evidence_status='current_for_code_sha')
        part['validation']['code_sha']=part['code_sha']
    def test_current_checkpoint(self): self.assertEqual(v.validate_published(json.loads((p/'execution-ledger.json').read_text()))['status'],'checkpoint_consistent')
    def test_valid(self): self.assertEqual(v.validate(self.data)['status'],'checkpoint_consistent')
    def test_missing_scope(self):
        self.data['milestones'].pop()
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_dependency_removed(self):
        self.data['milestones'][1]['depends_on']=[]
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_false_completion(self):
        self.data['milestones'][0]['state']='done'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_drifted_contract(self):
        self.data['milestones'][1]['slices'][0].pop('base_status',None)
        self.data['milestones'][1]['slices'][0]['base_sha']='0'*40
        with self.assertRaises(ValueError): v.validate(self.data)
    def stale_slice(self):
        node=self.data['milestones'][1]; part=node['slices'][0]
        head=next(p['headRefOid'] for p in self.data['prs'] if p['number']==part['base_pr'])
        node['board_status']='blocked'; node['state']='blocked'
        part.update(base_sha='0'*40,observed_base_sha=head,base_status='stale_requires_revalidation',state='blocked',revalidation_required='merge current main and retest after predecessor merge')
        part['evidence_status']='historical'
        for key in ['audit','validation']:
            if key in part: part[key]['status']='historical'
        predecessor=next(s for n in self.data['milestones'] for s in n['slices'] if s.get('pr')==part['base_pr'])
        predecessor.setdefault('candidate_history',[]).append({'sha':'0'*40,'evidence_url':'https://example.invalid/historical-fixture','status':'historical'})
        return part
    def test_explicit_stale_checkpoint(self):
        self.stale_slice()
        self.assertEqual(v.validate(self.data)['status'],'checkpoint_consistent')
    def test_stale_cannot_be_ready(self):
        self.stale_slice()['state']='ready'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_stale_observation_must_match(self):
        self.stale_slice()['observed_base_sha']='1'*40
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_stale_requires_action(self):
        self.stale_slice()['revalidation_required']=''
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_stale_requires_real_drift(self):
        part=self.stale_slice(); part['base_sha']=part['observed_base_sha']
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_stale_requires_blocked_board(self):
        self.stale_slice(); self.data['milestones'][1]['board_status']='running'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_stale_requires_blocked_node(self):
        self.stale_slice(); self.data['milestones'][1]['state']='candidate_pr_open'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_history_required(self):
        self.stale_slice(); self.data['milestones'][0]['slices'][1]['candidate_history']=[]
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_observation_time_required(self):
        self.data['prs'][0].pop('observed_at')
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_slice_head_mismatch(self):
        self.data['milestones'][0]['slices'][1]['candidate_sha']='0'*40
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_unknown_base_pr(self):
        self.stale_slice()['base_pr']=999
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_missing_report(self):
        self.data['handoff']['report']='missing-checkpoint.md'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_path_escape(self):
        self.data['handoff']['report']='../README.md'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_handoff_hash(self):
        self.data['handoff']['report_sha256']='0'*64
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_j11_cannot_reuse_old_evidence(self):
        node=next(n for n in self.data['milestones'] if n['id']=='J11')
        node['slices'][0]['evidence_status']='current'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_lost_owner(self):
        self.data['owner_thread']='other'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_forged_runtime(self):
        self.data['runtime_enabled']=True
        with self.assertRaises(ValueError): v.validate(self.data)
    def retargeted_slice(self):
        part=self.data['milestones'][1]['slices'][0]
        for key in ['base_pr','observed_base_sha','base_status','revalidation_required']: part.pop(key,None)
        part.update(base_branch='main',base_sha=self.data['main_sha'],state='ready',evidence_status='current_for_code_sha')
        part['audit']['status']='current_for_code_sha'
        part['validation']['status']='passed_for_code_sha'
        part['validation']['code_sha']=part['code_sha']
        pr=next(x for x in self.data['prs'] if x['number']==part['pr']);pr['baseRefName']='main';pr['isDraft']=False
        return part
    def test_main_retargeted_checkpoint(self):
        self.retargeted_slice();self.assertEqual(v.validate(self.data)['status'],'checkpoint_consistent')
    def test_main_retarget_drift(self):
        self.retargeted_slice()['base_sha']='1'*40
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_historical_evidence(self):
        self.retargeted_slice()['evidence_status']='historical'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_missing_audit(self):
        self.retargeted_slice()['audit']['verdict']='REVISE'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_pending_validation(self):
        self.retargeted_slice()['validation']['status']='pending'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_without_base(self):
        part=self.retargeted_slice();part.pop('base_branch');part.pop('base_sha')
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_old_audit_status(self):
        self.retargeted_slice()['audit']['status']='historical'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_wrong_code(self):
        self.retargeted_slice()['code_sha']='f'*40
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_wrong_audit_binding(self):
        part=self.retargeted_slice();part['code_sha']='f'*40;part['validation']['code_sha']='f'*40
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_bad_retarget_history(self):
        self.retargeted_slice()['retarget_history']=[{'base_pr':273,'base_sha':'a'*40,'status':'current'}]
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_design_file_is_not_evidence(self):
        self.data['handoff']['report']='README.md'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_missing_checkpoint_time(self):
        self.data['observed_at']='2026-10-27'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_closed_pr(self):
        part=self.retargeted_slice();next(x for x in self.data['prs'] if x['number']==part['pr'])['state']='CLOSED'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_merged_slice_open_pr(self):
        next(x for x in self.data['prs'] if x['number']==272)['state']='OPEN'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_stacked_after_predecessor_merge(self):
        part=self.stale_slice();part['base_sha']=part['observed_base_sha'];part.pop('base_status');part['state']='candidate_pr_open'
        next(x for x in self.data['prs'] if x['number']==273)['state']='MERGED'
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_missing_binding(self):
        self.retargeted_slice()['validation'].pop('audit_binding')
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_failed_test_counts(self):
        self.retargeted_slice()['validation']['failed']=1
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_zero_passed_tests(self):
        self.retargeted_slice()['validation']['passed']=0
        with self.assertRaises(ValueError):v.validate(self.data)
    def test_ready_revise_binding(self):
        self.retargeted_slice();original=json.loads
        def changed(text):
            value=original(text)
            if isinstance(value,dict) and 'code_commit' in value:value['verdict']='REVISE'
            return value
        with patch.object(v.json,'loads',side_effect=changed):
            with self.assertRaises(ValueError):v.validate(self.data)
    def test_merged_base_remains_historical(self):
        part=self.data['milestones'][0]['slices'][0]
        part.update(base_branch='main',base_sha='e'*40)
        self.assertEqual(v.validate(self.data)['status'],'checkpoint_consistent')
    def successor(self):
        import copy
        part=copy.deepcopy(self.retargeted_slice())
        part.update(head_sha=next(x['headRefOid'] for x in self.data['prs'] if x['number']==part['pr']),
                    runtime_enabled=False,card_id='fixture-card',scope='independent precursor')
        part['proof_version'] = 2
        part['merge_readiness'] = {'ci': 'pending_or_failed_at_observation'}
        # Virtualize only this binding's bytes; immutable historical files stay intact.
        target = (p / part['validation']['audit_binding']).resolve()
        original_text, original_bytes = Path.read_text, Path.read_bytes
        binding = json.loads(original_text(target))
        binding['reviewed_base'] = part['base_sha']
        self.binding_bytes = json.dumps(binding).encode()
        def read_text(path, *args, **kwargs):
            if path.resolve() == target: return self.binding_bytes.decode()
            return original_text(path, *args, **kwargs)
        def read_bytes(path, *args, **kwargs):
            if path.resolve() == target: return self.binding_bytes
            return original_bytes(path, *args, **kwargs)
        for method, replacement in [('read_text', read_text), ('read_bytes', read_bytes)]:
            patcher = patch.object(Path, method, replacement)
            patcher.start(); self.addCleanup(patcher.stop)
        part['validation']['report_sha256'] = hashlib.sha256((p / part['validation']['report']).read_bytes()).hexdigest()
        part['validation']['audit_binding_sha256'] = hashlib.sha256(self.binding_bytes).hexdigest()
        part['code_head_proof'] = {'code_sha': part['code_sha'], 'head_sha': part['head_sha'],
            'changed_paths': ['docs/fixture.md'] if part['head_sha'] != part['code_sha'] else [],
            'diff_sha256': hashlib.sha256(b'owner-observed fixture diff').hexdigest()}
        self.data['handoff']['successor_deliveries']=[part]
        return part
    def test_successor_ready(self):
        self.successor();self.assertEqual(v.validate(self.data)['status'],'checkpoint_consistent')
    def test_successor_cannot_drift(self):
        self.successor()['base_sha']='e'*40
        with self.assertRaisesRegex(ValueError,'audit reviewed base differs'):v.validate(self.data)
    def test_successor_requires_audit(self):
        self.successor()['audit']['verdict']='REVISE'
        with self.assertRaisesRegex(ValueError,'ready without audit pass'):v.validate(self.data)
    def test_successor_head_must_match(self):
        self.successor()['head_sha']='e'*40
        with self.assertRaisesRegex(ValueError,'successor head differs'):v.validate(self.data)
    def test_successor_cannot_enable_runtime(self):
        self.successor()['runtime_enabled']=True
        with self.assertRaisesRegex(ValueError,'successor does not qualify runtime'):v.validate(self.data)
    def test_successor_cannot_mark_unmerged_done(self):
        self.successor()['state']='merged'
        with self.assertRaisesRegex(ValueError,'successor merge unobserved'):v.validate(self.data)
    def test_duplicate_successor_rejected(self):
        part=self.successor();self.data['handoff']['successor_deliveries'].append(part)
        with self.assertRaisesRegex(ValueError,'duplicate successor'):v.validate(self.data)
    def test_successor_requires_proof_version(self):
        self.successor().pop('proof_version')
        with self.assertRaisesRegex(ValueError, 'proof_version'): v.validate(self.data)
    def test_successor_different_head_requires_proof(self):
        part = self.successor(); self.assertNotEqual(part['code_sha'], part['head_sha'])
        part.pop('code_head_proof')
        with self.assertRaisesRegex(ValueError, 'code/head proof missing'): v.validate(self.data)
    def test_successor_changed_path_cannot_be_product(self):
        self.successor()['code_head_proof']['changed_paths'] = ['packages/cli/src/daemon.ts']
        with self.assertRaisesRegex(ValueError, 'metadata scope'): v.validate(self.data)
    def test_successor_changed_path_cannot_escape(self):
        part = self.successor()
        for path in ['docs/../packages/code.ts', 'docs//file.md', 'docs/./file.md', 'docs/', 'docs/\\escape', '/docs/file.md']:
            with self.subTest(path=path):
                part['code_head_proof']['changed_paths'] = [path]
                with self.assertRaisesRegex(ValueError, 'metadata scope'): v.validate(self.data)
    def test_successor_diff_hash_required(self):
        self.successor()['code_head_proof']['diff_sha256'] = 'no-digest'
        with self.assertRaisesRegex(ValueError, 'diff SHA256'): v.validate(self.data)
    def test_successor_proof_identity_must_match(self):
        self.successor()['code_head_proof']['head_sha'] = 'e' * 40
        with self.assertRaisesRegex(ValueError, 'proof identity'): v.validate(self.data)
    def test_successor_different_head_requires_paths(self):
        self.successor()['code_head_proof']['changed_paths'] = []
        with self.assertRaisesRegex(ValueError, 'path emptiness'): v.validate(self.data)
    def equal_head_successor(self):
        part = self.successor()
        pr = next(x for x in self.data['prs'] if x['number'] == part['pr'])
        pr['headRefOid'] = part['code_sha']
        for node in self.data['milestones']:
            for item in node['slices']:
                if item.get('pr') == part['pr']:
                    for key in ['candidate_sha', 'head_sha']:
                        if key in item: item[key] = part['code_sha']
        part['head_sha'] = part['code_sha']
        if 'candidate_sha' in part: part['candidate_sha'] = part['code_sha']
        part['code_head_proof'].update(head_sha=part['code_sha'], changed_paths=[])
        return part
    def test_successor_equal_head_accepts_empty_paths(self):
        self.equal_head_successor()
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_successor_equal_head_rejects_paths(self):
        self.equal_head_successor()['code_head_proof']['changed_paths'] = ['docs/impossible.md']
        with self.assertRaisesRegex(ValueError, 'path emptiness'): v.validate(self.data)
    def test_successor_report_digest_must_match(self):
        self.successor()['validation']['report_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_successor_changed_binding_bytes_rejected(self):
        self.successor(); self.binding_bytes += b' '
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_successor_audit_base_must_match_even_with_valid_hash(self):
        part = self.successor()
        binding = json.loads(self.binding_bytes); binding['reviewed_base'] = 'e' * 40
        self.binding_bytes = json.dumps(binding).encode()
        part['validation']['audit_binding_sha256'] = hashlib.sha256(self.binding_bytes).hexdigest()
        with self.assertRaisesRegex(ValueError, 'audit reviewed base differs'): v.validate(self.data)
    def test_draft_current_evidence_requires_hashes(self):
        part = self.successor(); part['state'] = 'revalidating'
        next(x for x in self.data['prs'] if x['number'] == part['pr'])['isDraft'] = True
        # The parent milestone slice is historical, so the successor is the only current claim.
        self.data['milestones'][1]['slices'][0]['state'] = 'open'
        part['validation'].pop('audit_binding_sha256')
        with self.assertRaisesRegex(ValueError, 'invalid evidence SHA256'): v.validate(self.data)
    def test_draft_current_evidence_valid(self):
        part = self.successor(); part['state'] = 'revalidating'
        next(x for x in self.data['prs'] if x['number'] == part['pr'])['isDraft'] = True
        self.data['milestones'][1]['slices'][0]['state'] = 'open'
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_blocked_current_audit_cannot_bypass_proof(self):
        part = self.successor(); part['state'] = 'blocked'; part['evidence_status'] = 'historical'
        part.pop('code_head_proof')
        with self.assertRaisesRegex(ValueError, 'code/head proof missing'): v.validate(self.data)
    def completed_node(self):
        node = self.data['milestones'][0]
        node['state'] = 'done'; node['acceptance'] = 'passed'
        for part in node['slices']:
            pr = next(x for x in self.data['prs'] if x['number'] == part['pr'])
            pr.update(state='MERGED', mergeCommit={'oid': 'e' * 40})
            part['state'] = 'merged'
            part['merge_sha'] = 'e' * 40
        for key in ['acceptance_evidence', 'merged_candidate_ci_evidence']:
            node[key] = self.data['handoff']['report']
            node[key + '_sha256'] = self.data['handoff']['report_sha256']
        return node
    def test_done_rejects_fictional_acceptance_path(self):
        self.completed_node()['acceptance_evidence'] = 'evidence/does-not-exist.json'
        with self.assertRaisesRegex(ValueError, 'evidence file missing'): v.validate(self.data)
    def test_done_rejects_fictional_ci_path(self):
        self.completed_node()['merged_candidate_ci_evidence'] = 'evidence/does-not-exist.json'
        with self.assertRaisesRegex(ValueError, 'evidence file missing'): v.validate(self.data)
    def test_done_rejects_acceptance_hash_drift(self):
        self.completed_node()['acceptance_evidence_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_done_rejects_ci_hash_drift(self):
        self.completed_node()['merged_candidate_ci_evidence_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def virtual_files(self, files):
        # Virtual fixture bytes remain below the evidence root without modifying history.
        originals = (Path.is_file, Path.read_bytes, Path.read_text)
        resolved = {(p / name).resolve(): data for name, data in files.items()}
        def is_file(path):
            return path.resolve() in resolved or originals[0](path)
        def read_bytes(path):
            if path.resolve() in resolved: return resolved[path.resolve()]
            return originals[1](path)
        def read_text(path, *args, **kwargs):
            if path.resolve() in resolved: return resolved[path.resolve()].decode()
            return originals[2](path, *args, **kwargs)
        for method, replacement in [('is_file', is_file), ('read_bytes', read_bytes), ('read_text', read_text)]:
            patcher = patch.object(Path, method, replacement)
            patcher.start(); self.addCleanup(patcher.stop)
    def root_v2(self):
        self.data['checkpoint_proof_version'] = 2
        # These historical milestone slices are not freshly published Ready claims.
        for node in self.data['milestones']:
            for part in node['slices']:
                if part['state'] == 'ready': part['state'] = 'open'
                if part['state'] == 'merged':
                    part['merge_sha'] = next(pr['mergeCommit']['oid'] for pr in self.data['prs'] if pr['number'] == part['pr'])
                if part.get('evidence_status') == 'current_for_code_sha': part['evidence_status'] = 'historical'
                for key in ['audit', 'validation']:
                    if part.get(key, {}).get('status') in ['current_for_code_sha', 'passed_for_code_sha']: part[key]['status'] = 'historical'
        report = self.data['handoff']['report']
        digest = self.data['handoff']['report_sha256']
        self.data['checkpoint_history'] = [{'path': report, 'sha256': digest}]
        management = self.data['management']
        management['snapshot_sha256'] = hashlib.sha256((p / management['snapshot']).read_bytes()).hexdigest()
        names = ['subagent-dispatch-receipts.json', 'terminal-preflight-receipt.json',
                 'board-final-receipts.json', 'automation-receipt.json']
        files = {'evidence/test-v2/' + name: b'{}' for name in names}
        self.virtual_files(files)
        management['receipts'] = [{'path': name, 'sha256': hashlib.sha256(data).hexdigest()} for name, data in files.items()]
    def root_v2_successor(self):
        part = self.successor(); self.root_v2()
        path = 'evidence/test-v2/code-head.diff'
        data = b'diff --git a/docs/fixture.md b/docs/fixture.md\nindex abc1234..def5678 100644\n--- a/docs/fixture.md\n+++ b/docs/fixture.md\n@@ -1 +1 @@\n-old\n+new\n'
        self.virtual_files({path: data})
        part['code_head_proof']['diff_path'] = path
        part['code_head_proof']['diff_sha256'] = hashlib.sha256(data).hexdigest()
        return part
    def test_historical_successor_hash_cannot_bypass_check(self):
        part = self.successor(); part.update(state='blocked', evidence_status='historical')
        part['audit']['status'] = 'historical'; part['validation']['status'] = 'historical'
        part['validation']['report_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def merged_successor(self):
        part = self.successor(); part.update(state='merged', merge_sha='a' * 40)
        next(x for x in self.data['prs'] if x['number'] == part['pr']).update(state='MERGED', mergeCommit={'oid': 'a' * 40})
        self.data['milestones'][1]['slices'][0]['state'] = 'merged'
        return part
    def test_merged_successor_matches_observed_commit(self):
        self.merged_successor()
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_merged_successor_wrong_sha_rejected(self):
        self.merged_successor()['merge_sha'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'successor merge SHA differs'): v.validate(self.data)
    def test_merged_successor_missing_sha_rejected(self):
        self.merged_successor().pop('merge_sha')
        with self.assertRaisesRegex(ValueError, 'successor merge SHA differs'): v.validate(self.data)
    def test_root_v2_valid(self):
        self.root_v2()
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_root_v2_missing_receipts(self):
        self.root_v2(); self.data['management'].pop('receipts')
        with self.assertRaisesRegex(ValueError, 'four receipts required'): v.validate(self.data)
    def test_root_v2_wrong_receipt_name(self):
        self.root_v2(); self.data['management']['receipts'][0]['path'] = 'evidence/wrong.json'
        with self.assertRaisesRegex(ValueError, 'receipt names differ'): v.validate(self.data)
    def test_root_v2_duplicate_receipt(self):
        self.root_v2(); receipts = self.data['management']['receipts']; receipts[0] = receipts[1]
        with self.assertRaisesRegex(ValueError, 'receipt names differ'): v.validate(self.data)
    def test_root_v2_missing_snapshot_hash(self):
        self.root_v2(); self.data['management'].pop('snapshot_sha256')
        with self.assertRaisesRegex(ValueError, 'snapshot hash missing'): v.validate(self.data)
    def test_root_v2_wrong_snapshot_hash(self):
        self.root_v2(); self.data['management']['snapshot_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_root_v2_missing_history(self):
        self.root_v2(); self.data.pop('checkpoint_history')
        with self.assertRaisesRegex(ValueError, 'history missing'): v.validate(self.data)
    def test_root_v2_empty_history(self):
        self.root_v2(); self.data['checkpoint_history'] = []
        with self.assertRaisesRegex(ValueError, 'history missing'): v.validate(self.data)
    def test_root_v2_bad_history_hash(self):
        self.root_v2(); self.data['checkpoint_history'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_root_v2_bad_receipt_hash(self):
        self.root_v2(); self.data['management']['receipts'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_root_v2_missing_receipt_file(self):
        self.root_v2(); self.data['management']['receipts'][0]['path'] = 'evidence/missing/subagent-dispatch-receipts.json'
        with self.assertRaisesRegex(ValueError, 'evidence file missing'): v.validate(self.data)
    def test_root_v2_rejects_legacy_ready_slice(self):
        self.root_v2(); self.retargeted_slice()
        with self.assertRaisesRegex(ValueError, 'ready slice requires proof_version 2'): v.validate(self.data)
    def test_root_v2_successor_diff_bytes_bound(self):
        self.root_v2_successor()
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_root_v2_missing_diff_path(self):
        self.root_v2_successor()['code_head_proof'].pop('diff_path')
        with self.assertRaisesRegex(ValueError, 'evidence path missing'): v.validate(self.data)
    def test_root_v2_changed_diff_bytes_rejected(self):
        part = self.root_v2_successor()
        self.virtual_files({part['code_head_proof']['diff_path']: b'changed bytes'})
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def empty_net_diff_successor(self):
        part = self.root_v2_successor()
        proof = part['code_head_proof']
        self.virtual_files({proof['diff_path']: b''})
        proof.update(net_diff_empty=True, changed_paths=[], diff_sha256=hashlib.sha256(b'').hexdigest())
        return part
    def test_explicit_empty_net_diff_between_distinct_commits(self):
        part = self.empty_net_diff_successor(); self.assertNotEqual(part['code_sha'], part['head_sha'])
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_net_empty_flag_cannot_hide_paths(self):
        self.empty_net_diff_successor()['code_head_proof']['changed_paths'] = ['docs/nonempty.md']
        with self.assertRaisesRegex(ValueError, 'net empty diff proof differs'): v.validate(self.data)
    def test_net_empty_flag_requires_empty_hash(self):
        part = self.root_v2_successor()
        part['code_head_proof'].update(net_diff_empty=True, changed_paths=[])
        with self.assertRaisesRegex(ValueError, 'net empty diff proof differs'): v.validate(self.data)
    def test_ready_successor_requires_ci_observation(self):
        self.successor().pop('merge_readiness')
        with self.assertRaisesRegex(ValueError, 'CI observation missing'): v.validate(self.data)
    def test_ready_successor_rejects_invented_ci_value(self):
        self.successor()['merge_readiness']['ci'] = 'probably fine'
        with self.assertRaisesRegex(ValueError, 'CI observation missing'): v.validate(self.data)
    def test_ready_successor_accepts_non_green_observation(self):
        part = self.successor()
        for status in ['passed_at_observation', 'pending_or_failed_at_observation', 'pending', 'failed', 'not_observed']:
            with self.subTest(status=status):
                part['merge_readiness']['ci'] = status
                self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_non_ready_successor_cannot_use_stale_main(self):
        part = self.successor(); part.update(state='blocked', base_sha='d' * 40)
        binding = json.loads(self.binding_bytes); binding['reviewed_base'] = part['base_sha']
        self.binding_bytes = json.dumps(binding).encode()
        part['validation']['audit_binding_sha256'] = hashlib.sha256(self.binding_bytes).hexdigest()
        with self.assertRaisesRegex(ValueError, 'successor main candidate base drift'): v.validate(self.data)
    def test_optional_board_snapshot_hash_checked(self):
        self.data['management']['board_snapshots'] = [{'path': self.data['handoff']['report'], 'sha256': '0' * 64}]
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_optional_rpc_helper_hash_checked(self):
        self.data['management']['rpc_helper'] = {'path': self.data['handoff']['report'], 'sha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_optional_rpc_helper_cannot_escape(self):
        self.data['management']['rpc_helper'] = {'path': '../outside.py', 'sha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'path escapes'): v.validate(self.data)
    def root_v2_done(self):
        self.root_v2(); node = self.completed_node()
        # Existing fixture successor stacks must remain explicitly blocked after this merge.
        for other in self.data['milestones']:
            for part in other['slices']:
                if part.get('base_pr') in [item['pr'] for item in node['slices']]: part['state'] = 'blocked'
        plan = json.loads((p / 'work-packages.json').read_text())['items']
        expected = next(item['acceptance_ids'] for item in plan if item['id'] == node['id'])
        self.done_acceptance = {'node_id': node['id'], 'status': 'passed',
            'cases': [{'case_id': case, 'status': 'passed'} for case in expected]}
        self.done_ci = {'node_id': node['id'], 'status': 'passed',
            'merges': [{'pr': part['pr'], 'merge_sha': 'e' * 40, 'status': 'passed'} for part in node['slices']]}
        self.bind_done_evidence(node)
        return node
    def bind_done_evidence(self, node):
        files = {}
        for key, data in [('acceptance_evidence', self.done_acceptance), ('merged_candidate_ci_evidence', self.done_ci)]:
            path = 'evidence/test-v2/' + key + '.json'; body = json.dumps(data).encode()
            files[path] = body; node[key] = path; node[key + '_sha256'] = hashlib.sha256(body).hexdigest()
        self.virtual_files(files)
    def test_root_v2_done_with_bound_records(self):
        self.root_v2_done()
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_root_v2_done_cannot_reuse_one_evidence_file(self):
        node = self.root_v2_done()
        node['merged_candidate_ci_evidence'] = node['acceptance_evidence']
        node['merged_candidate_ci_evidence_sha256'] = node['acceptance_evidence_sha256']
        with self.assertRaisesRegex(ValueError, 'must differ'): v.validate(self.data)
    def test_root_v2_done_cannot_use_hashed_handoff(self):
        node = self.root_v2_done()
        self.done_acceptance = {'arbitrary': 'handoff fact', 'status': 'passed'}
        self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'acceptance node/status differs'): v.validate(self.data)
    def test_root_v2_done_acceptance_node_must_match(self):
        node = self.root_v2_done(); self.done_acceptance['node_id'] = 'J99'; self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'acceptance node/status differs'): v.validate(self.data)
    def test_root_v2_done_cases_must_cover_design(self):
        node = self.root_v2_done(); self.done_acceptance['cases'].pop(); self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'case coverage differs'): v.validate(self.data)
    def test_root_v2_done_cases_must_pass(self):
        node = self.root_v2_done(); self.done_acceptance['cases'][0]['status'] = 'not_run'; self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'case not passed'): v.validate(self.data)
    def test_root_v2_done_ci_node_must_match(self):
        node = self.root_v2_done(); self.done_ci['node_id'] = 'J99'; self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'CI node/status differs'): v.validate(self.data)
    def test_root_v2_done_ci_must_pass(self):
        node = self.root_v2_done(); self.done_ci['status'] = 'pending'; self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'CI node/status differs'): v.validate(self.data)
    def test_root_v2_done_ci_covers_each_slice(self):
        node = self.root_v2_done(); self.done_ci['merges'].pop(); self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'CI PR coverage differs'): v.validate(self.data)
    def test_root_v2_done_ci_merge_must_match_observation(self):
        node = self.root_v2_done(); self.done_ci['merges'][0]['merge_sha'] = 'a' * 40; self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'CI merge SHA differs'): v.validate(self.data)
    def test_root_v2_done_ci_each_merge_passes(self):
        node = self.root_v2_done(); self.done_ci['merges'][0]['status'] = 'pending'; self.bind_done_evidence(node)
        with self.assertRaisesRegex(ValueError, 'CI merge record invalid'): v.validate(self.data)
    def test_published_checkpoint_rejects_legacy_root(self):
        with self.assertRaisesRegex(ValueError, 'published checkpoint requires'): v.validate_published(self.data)
    def test_published_checkpoint_accepts_v2(self):
        self.root_v2()
        self.assertEqual(v.validate_published(self.data)['status'], 'checkpoint_consistent')
    def replace_diff(self, part, body):
        self.virtual_files({part['code_head_proof']['diff_path']: body})
        part['code_head_proof']['diff_sha256'] = hashlib.sha256(body).hexdigest()
    def test_diff_product_header_cannot_claim_docs(self):
        part = self.root_v2_successor()
        self.replace_diff(part, b'diff --git a/packages/cli/src/daemon.ts b/packages/cli/src/daemon.ts\n')
        with self.assertRaisesRegex(ValueError, 'headers differ'): v.validate(self.data)
    def test_diff_omitted_header_path_rejected(self):
        part = self.root_v2_successor()
        self.replace_diff(part, b'diff --git a/docs/fixture.md b/docs/fixture.md\ndiff --git a/docs/omitted.md b/docs/omitted.md\n')
        with self.assertRaisesRegex(ValueError, 'headers differ'): v.validate(self.data)
    def test_diff_nonempty_without_headers_rejected(self):
        part = self.root_v2_successor(); self.replace_diff(part, b'pretend patch')
        with self.assertRaisesRegex(ValueError, 'malformed diff header'): v.validate(self.data)
    def test_diff_renamed_paths_rejected(self):
        part = self.root_v2_successor()
        self.replace_diff(part, b'diff --git a/packages/secret.ts b/docs/fixture.md\n')
        with self.assertRaisesRegex(ValueError, 'same-path no-renames'): v.validate(self.data)
    def test_diff_malformed_header_rejected(self):
        part = self.root_v2_successor(); self.replace_diff(part, b'diff --git "a/docs/fixture.md b/docs/fixture.md\n')
        with self.assertRaisesRegex(ValueError, 'malformed diff header'): v.validate(self.data)
    def test_diff_combined_format_rejected(self):
        part = self.root_v2_successor(); self.replace_diff(part, b'diff --cc docs/fixture.md\n')
        with self.assertRaisesRegex(ValueError, 'malformed diff header'): v.validate(self.data)
    def test_diff_c_quoted_escape_rejected(self):
        part = self.root_v2_successor(); self.replace_diff(part, b'diff --git "a/docs/\\141.md" "b/docs/\\141.md"\n')
        with self.assertRaisesRegex(ValueError, 'unsupported diff header'): v.validate(self.data)
    def test_diff_ascii_quoted_path_supported(self):
        part = self.root_v2_successor(); part['code_head_proof']['changed_paths'] = ['docs/space name.md']
        self.replace_diff(part, b'diff --git "a/docs/space name.md" "b/docs/space name.md"\n')
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def current_milestone(self):
        import copy
        part = copy.deepcopy(self.root_v2_successor()); part['state'] = 'open'
        self.data['milestones'][1]['slices'][0] = part
        self.data['handoff']['successor_deliveries'] = []
        return part
    def test_root_v2_open_milestone_current_evidence_checked(self):
        self.current_milestone()['validation']['report_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
    def test_root_v2_open_milestone_current_proof_version_required(self):
        self.current_milestone().pop('proof_version')
        with self.assertRaisesRegex(ValueError, 'current evidence requires proof_version 2'): v.validate(self.data)
    def test_root_v2_open_milestone_current_evidence_valid(self):
        self.current_milestone()
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_root_v2_observed_merge_requires_merged_milestone(self):
        self.root_v2(); self.data['milestones'][0]['slices'][0]['state'] = 'open'
        with self.assertRaisesRegex(ValueError, 'observed merged PR requires merged slice'): v.validate(self.data)
    def test_root_v2_observed_merge_requires_merged_successor(self):
        part = self.root_v2_successor(); part['state'] = 'blocked'
        next(item for item in self.data['prs'] if item['number'] == part['pr']).update(state='MERGED', mergeCommit={'oid':'a'*40})
        self.data['milestones'][1]['slices'][0].update(state='merged', merge_sha='a'*40)
        with self.assertRaisesRegex(ValueError, 'observed merged PR requires merged successor'): v.validate(self.data)
    def test_root_v2_merged_milestone_sha_matches(self):
        self.root_v2()
        self.assertEqual(v.validate(self.data)['status'], 'checkpoint_consistent')
    def test_root_v2_merged_milestone_sha_must_match(self):
        self.root_v2(); part = self.data['milestones'][0]['slices'][0]
        for wrong in [None, 'b' * 40]:
            with self.subTest(merge_sha=wrong):
                part['merge_sha'] = wrong
                with self.assertRaisesRegex(ValueError, 'milestone merge SHA differs'): v.validate(self.data)
    def test_current_archive_manifest_requires_hash(self):
        part = self.root_v2_successor()
        part['validation']['archive_manifest'] = part['validation']['report']
        with self.assertRaisesRegex(ValueError, 'invalid evidence SHA256'): v.validate(self.data)
    def test_current_archive_manifest_rejects_hash_drift(self):
        part = self.root_v2_successor()
        part['validation'].update(archive_manifest=part['validation']['report'], archive_manifest_sha256='0' * 64)
        with self.assertRaisesRegex(ValueError, 'evidence hash differs'): v.validate(self.data)
if __name__=='__main__': unittest.main()
