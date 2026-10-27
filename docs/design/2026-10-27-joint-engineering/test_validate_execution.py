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
        self.data['milestones'][1]['slices'][0]['base_sha']='0'*40
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_lost_owner(self):
        self.data['owner_thread']='other'
        with self.assertRaises(ValueError): v.validate(self.data)
    def test_forged_runtime(self):
        self.data['runtime_enabled']=True
        with self.assertRaises(ValueError): v.validate(self.data)
if __name__=='__main__': unittest.main()
