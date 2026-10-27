import importlib.util
import json
import unittest
from pathlib import Path
p=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('execution',p/'validate-execution.py')
v=importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
class CheckpointTests(unittest.TestCase):
    def setUp(self): self.data=json.loads((p/'execution-ledger.json').read_text())
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
if __name__=='__main__': unittest.main()
