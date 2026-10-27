import assert from 'node:assert/strict';
import { freezeDeliveryContract, assertFrozenDeliveryContract, deliveryCheckReference, assertDeliveryContractAdmission } from './core.ts';
const policy = 'a'.repeat(64);
const frozen = freezeDeliveryContract({
  schema_version: 2, contract_id: 'audit-fixture', task_id: 'fixture-task',
  canonical_repo: '/synthetic/audit-fixture', mode: 'implement', base_head: 'b'.repeat(40),
  goal: 'Fix synthetic fixture', required_checks: [{id:'fixture-check',registry_ref:deliveryCheckReference('true')}],
  review_policy_ref: 'fixture-review', requested_completion: 'local_verified',
  allowed_paths: ['fixture'], requested_actions: ['build','verify'], budget_ref: 'policy:'+policy,
  policy_digest: policy, publication_scope: {mode:'none'}, merge_authority: {mode:'none'}
});
assert.deepEqual(assertFrozenDeliveryContract(frozen),frozen);
let observed = '';
try { assertFrozenDeliveryContract({...frozen,brief:frozen.brief+'\nMethod: reproduce, fix, verify.'}); }
catch(e) { observed = String((e as Error).message); }
assert.equal(observed,'delivery_contract_digest_mismatch');
const changedGoal=freezeDeliveryContract({...frozen.contract,goal:frozen.contract.goal+' Method: reproduce, fix, verify.'});
let goalObserved = '';
try { assertDeliveryContractAdmission(changedGoal,{canonicalRepo:frozen.contract.canonical_repo,baseHead:frozen.contract.base_head,taskId:frozen.contract.task_id,goal:frozen.contract.goal,policyDigest:policy,reviewPolicyRef:frozen.contract.review_policy_ref,acceptedCommands:['true']}); }
catch(e) { goalObserved=String((e as Error).message); }
assert.equal(goalObserved,'delivery_contract_admission_mismatch');
console.log(JSON.stringify({status:'pass',scope:'negative_probe_of_claude_recommendation_not_product_integration',original_frozen_contract:'accepted',appended_brief:observed,changed_goal_under_original_authorization:goalObserved,commands_executed:[],database_access:false},null,2));
