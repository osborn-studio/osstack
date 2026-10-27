#!/usr/bin/env python3
"""Negative tests for planning claims; these are not product acceptance tests."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('joint_validator',ROOT/'validate-design.py')
v=importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

class DesignChecks(unittest.TestCase):
    def setUp(self):
        self.data=v.load()

    def rejects(self, edit):
        edit(self.data)
        with self.assertRaises(ValueError):
            v.validate(self.data)

    def test_valid_design(self):
        self.assertEqual(v.validate(self.data)['runtime_cases_executed'],0)

    def gate(self, gid):
        return next(x for x in self.data['execution-gates.json']['gates'] if x['id'] == gid)

    def work(self, wid):
        return next(x for x in self.data['work-packages.json']['items'] if x['id'] == wid)

    def test_component_override_cannot_bypass_recovery(self):
        self.work('J08')['dependency_gate_overrides'] = {'J12': 'J01.contracts'}
        with self.assertRaisesRegex(ValueError, 'unregistered component dependency override'):
            v.validate(self.data)

    def test_component_override_must_remain_explicit(self):
        self.work('J02').pop('dependency_gate_overrides')
        with self.assertRaisesRegex(ValueError, 'unregistered component dependency override'):
            v.validate(self.data)

    def test_component_override_cannot_use_another_owner_gate(self):
        self.work('J02')['dependency_gate_overrides'] = {'J01': 'J08.admission_boundary'}
        with self.assertRaisesRegex(ValueError, 'unregistered component dependency override'):
            v.validate(self.data)

    def test_component_gate_cannot_claim_runtime_evidence(self):
        self.gate('J01.contracts')['evidence_state'] = 'passed'
        with self.assertRaisesRegex(ValueError, 'gate overclaims evidence'):
            v.validate(self.data)

    def test_scope_case_list_cannot_silently_drop_runtime_obligations(self):
        self.gate('J01.scoped')['joint_case_requirements'] = ['JA59', 'JA70']
        with self.assertRaisesRegex(ValueError, 'joint case coverage drift'):
            v.validate(self.data)

    def test_component_and_legacy_case_namespaces_are_distinct(self):
        self.gate('J01.contracts')['case_requirements'] = ['JA59']
        with self.assertRaisesRegex(ValueError, 'unknown legacy case gate'):
            v.validate(self.data)

    def test_unknown_joint_case_and_duplicates_rejected(self):
        for required in (['JA59', 'JA999'], ['JA59', 'JA70', 'JA70'], 'JA59'):
            with self.subTest(required=required):
                self.gate('J01.contracts')['joint_case_requirements'] = required
                with self.assertRaisesRegex(ValueError, 'unknown/duplicate joint case requirement'):
                    v.validate(self.data)

    def test_component_cannot_consume_a_host_case_in_place_of_structure(self):
        self.gate('J01.contracts')['joint_case_requirements'] = ['JA01', 'JA02']
        with self.assertRaisesRegex(ValueError, 'joint case coverage drift'):
            v.validate(self.data)

    def test_new_gate_cannot_silently_consume_joint_cases(self):
        self.gate('J10.protocol')['joint_case_requirements'] = ['JA59']
        with self.assertRaisesRegex(ValueError, 'unregistered joint case consumer'):
            v.validate(self.data)

    def test_same_owner_is_required_for_component_producer(self):
        self.gate('J01.contracts')['owner_work_item'] = 'J08'
        with self.assertRaisesRegex(ValueError, 'component override producer mismatch'):
            v.validate(self.data)

    def test_original_host_case_semantics_remain_exact(self):
        for cid, field, replacement in [('JA01', 'when', '请求 task implementation_verified'),
                                         ('JA01', 'layer', 'contract'),
                                         ('JA02', 'then', '结构合法即可通过'),
                                         ('JA02', 'oracle', 'parser spy only')]:
            with self.subTest(cid=cid, field=field):
                self.data = v.load()
                next(x for x in self.data['acceptance-cases.json']['cases'] if x['id'] == cid)[field] = replacement
                with self.assertRaisesRegex(ValueError, 'protected host semantics changed'):
                    v.validate(self.data)

    def test_first_trial_cannot_precede_host_acceptance(self):
        self.gate('J08.scoped')['requires'].remove('J01.scoped')
        with self.assertRaisesRegex(ValueError, 'trial precedes J01 host acceptance'):
            v.validate(self.data)

    def test_host_acceptance_requires_actual_admission_boundary(self):
        self.gate('J01.scoped')['requires'].remove('J08.admission_boundary')
        with self.assertRaisesRegex(ValueError, 'J01 host acceptance lacks real admission boundary'):
            v.validate(self.data)

    def test_reverse_full_trial_dependency_is_a_cycle(self):
        self.gate('J01.scoped')['requires'] = ['J01.contracts', 'J08.scoped']
        with self.assertRaisesRegex(ValueError, 'cycle'):
            v.validate(self.data)

    def test_release_cannot_qualify_using_only_component_closure(self):
        # Replace every downstream J01 host edge while leaving first-trial guard intact.
        # The other invariants still fail closed; no alternate producer grants release.
        for gate in self.data['execution-gates.json']['gates']:
            if gate['id'] not in ('J08.scoped',):
                gate['requires'] = ['J01.contracts' if x == 'J01.scoped' else x for x in gate['requires']]
        with self.assertRaises(ValueError):
            v.validate(self.data)

    def test_components_do_not_satisfy_original_host_cases(self):
        summary = v.validate(self.data)
        self.assertEqual(summary['runtime_cases_executed'], 0)
        self.assertEqual(summary['future_product_cases'], 70)
        self.assertEqual(summary['stage_gates'], 126)
        self.assertEqual(summary['legacy_cases_retained'], 114)
        self.assertEqual(v.preflight_blockers(self.data, 'J02', 'implementation_start'), ['O06'])

    def test_broker_enabled_text_cannot_expand_home_only_exception(self):
        override = self.data['execution-gates.json']['local_override']
        override['forbidden_when'] = ''
        override['consumer_override'] = 'home-only gate qualifies broker-enabled full legacy recovery'
        with self.assertRaisesRegex(ValueError, 'JADR12 home-only exception semantics changed'):
            v.validate(self.data)

    def test_home_only_exception_cannot_drop_full_legacy_retention(self):
        override = self.data['execution-gates.json']['local_override']
        override['derived_local_gates'] = []
        with self.assertRaisesRegex(ValueError, 'JADR12 home-only exception semantics changed'):
            v.validate(self.data)

    def test_missing_capability(self):
        self.rejects(lambda d:d['capability-map.json']['capabilities'].pop())

    def test_empty_work_mapping(self):
        self.rejects(lambda d:d['capability-map.json']['capabilities'][0].update(joint_work_items=[]))

    def test_unknown_source(self):
        self.rejects(lambda d:d['capability-map.json']['capabilities'][0].update(source_refs=['invented']))

    def test_unknown_dependency(self):
        self.rejects(lambda d:d['work-packages.json']['items'][0].update(depends_on=['J99']))

    def test_cycle(self):
        self.rejects(lambda d:d['work-packages.json']['items'][0].update(depends_on=['J02']))

    def test_merge_order_cycle(self):
        self.rejects(lambda d:d['work-packages.json']['items'][0].update(merge_after=['J14']))

    def test_unordered_shared_write(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J14').update(merge_after=[]))

    def test_acceptance_owner_not_covered(self):
        def mutate(d):
            c=next(x for x in d['capability-map.json']['capabilities'] if x['id']=='PS03')
            c['joint_work_items'].remove('J01')
        self.rejects(mutate)

    def test_completed_plan(self):
        self.rejects(lambda d:d['work-packages.json']['items'][0].update(state='done'))

    def test_false_runtime_enable(self):
        self.rejects(lambda d:d['capability-map.json']['capabilities'][0].update(runtime_enabled=True))

    def test_false_test_execution(self):
        self.rejects(lambda d:d['acceptance-cases.json']['cases'][0].update(executed=True,status='passed'))

    def test_missing_original_work(self):
        self.rejects(lambda d:d['legacy-work-map.json']['items'].pop())

    def test_lost_inherited_gate(self):
        self.rejects(lambda d:next(x for x in d['legacy-work-map.json']['items'] if x['id']=='FM:E02').update(source_requires=[]))

    def test_historical_state_overwrite(self):
        self.rejects(lambda d:d['legacy-work-map.json']['items'][0].update(source_state='production_qualified'))

    def test_source_snapshot_hash(self):
        self.rejects(lambda d:d['baseline.json']['inputs'][0].update(sha256='0'*64))

    def test_missing_oracle(self):
        self.rejects(lambda d:d['acceptance-cases.json']['cases'][0].update(oracle=''))

    def test_owned_case_removed_from_work_package(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J02')['acceptance_ids'].remove('JA04'))

    def test_pstack_original_dependency_removed(self):
        self.rejects(lambda d:next(x for x in d['legacy-work-map.json']['items'] if x['id']=='PS:W11').update(source_requires=[]))

    def test_all_fixtures_removed(self):
        self.rejects(lambda d:d['fixtures/contracts.json'].update(fixtures=[]))

    def test_one_boundary_negative_removed(self):
        self.rejects(lambda d:d['fixtures/contracts.json'].update(fixtures=[f for f in d['fixtures/contracts.json']['fixtures'] if f['id']!='unknown-trial_permit']))

    def test_mismatched_case_owner(self):
        self.rejects(lambda d:d['acceptance-cases.json']['cases'][0].update(owner_work_item='J02'))

    def test_asymmetric_capability_coverage(self):
        self.rejects(lambda d:d['capability-map.json']['capabilities'][0].update(acceptance_ids=['JA02']))

    def test_bad_fixture_cannot_pass(self):
        self.rejects(lambda d:next(x for x in d['fixtures/contracts.json']['fixtures'] if x['id']=='permission-expansion').update(valid=True))

    def test_check_primary_must_be_required(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-check_binding'))
        p['checks'][0]['required']=False
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_duplicate_check_ids(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-check_binding'))
        p['checks'].append(copy.deepcopy(p['checks'][0]))
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_method_bytes_actual_prompt(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-context_receipt'))
        p['method_bytes']=5000;p['prompt_bytes']=100
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_recovery_missing_schema(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-recovery_receipt'))
        del p['schema_spec_digest']
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_recovery_missing_authorization(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-recovery_receipt'))
        del p['authorization_ref']
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_unsafe_integer(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-trial_permit'))
        p['expires_at_ms']=9007199254740992
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_frozen_audit_archive(self):
        self.assertEqual(v.verify_historical_audit(self.data)['raw_responses_verified'],3)

    def test_legacy_case_removed(self):
        self.rejects(lambda d:d['legacy-case-map.json'].update(items=[x for x in d['legacy-case-map.json']['items'] if x['id']!='PS:A27']))

    def test_inherited_release_gate_removed(self):
        self.rejects(lambda d:d['execution-gates.json']['legacy_release_requirements'].update(S2_opt_in=[]))

    def test_critical_release_dependencies_removed(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J27').update(depends_on=[]))

    def test_executor_measurement_dependency_removed(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J14')['depends_on'].remove('J23'))

    def test_experiment_stage_dependency_removed(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='J25.e1').update(requires=[]))

    def test_open_unknown_not_lost(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J04')['blocked_by'].remove('O02'))

    def test_unknown_blocks_only_declared_stage(self):
        self.assertIn('O02',v.preflight_blockers(self.data,'J04','merge'))
        self.assertNotIn('O02',v.preflight_blockers(self.data,'J04','investigation'))

    def test_busy_semantic_assertion_missing(self):
        self.rejects(lambda d:next(x for x in d['acceptance-cases.json']['cases'] if x['id']=='JA54')['asserts'].remove('FM-02:state-precedence'))

    def test_negative_case_reference_missing(self):
        self.rejects(lambda d:next(x for x in d['acceptance-cases.json']['cases'] if x['id']=='JA57').update(covers_negative_ids=[]))

    def test_oracle_author_cannot_be_implementation_owner(self):
        self.rejects(lambda d:d['acceptance-cases.json']['cases'][0]['oracle_spec'].update(author_role='contract-owner'))

    def test_generic_evidence_rejected(self):
        self.rejects(lambda d:d['acceptance-cases.json']['cases'][0].update(required_evidence=['generic evidence']))

    def test_migration_registration_paths_required(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J08')['write_paths'].remove('packages/core/src/state/migrations.ts'))

    def test_migration_queue_required(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J08').update(resource_queue='unregistered'))

    def test_weaken_permit_run_limit(self):
        self.rejects(lambda d:d['contract.schema.json']['$defs']['trial_permit']['properties'].update(max_root_runs={'type':'integer'}))

    def test_weaken_digest_pattern(self):
        self.rejects(lambda d:d['contract.schema.json']['$defs']['method_binding']['properties']['binding_digest'].pop('pattern'))

    def test_weaken_method_byte_limit(self):
        self.rejects(lambda d:d['contract.schema.json']['$defs']['context_receipt']['properties']['method_bytes'].update(maximum=32768))

    def test_source_inventory_entry_removed(self):
        self.rejects(lambda d:d['source-coverage.json']['files'].pop())

    def test_original_inspection_depth_not_erased(self):
        self.rejects(lambda d:d['sources.json']['sources'][0].update(inspection='fully_read'))

    def test_digest_definition_missing(self):
        self.rejects(lambda d:d['digest-catalog.json'].update(definitions=[x for x in d['digest-catalog.json']['definitions'] if x['field']!='binding_digest']))

    def test_digest_golden_tamper(self):
        self.rejects(lambda d:d['fixtures/digest-vectors.json']['vectors'][0].update(sha256='0'*64))

    def test_committed_cannot_be_not_started(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-recovery_receipt'))
        p.update(prior_phase='dispatch_committed',decision='proven_not_started')
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_recovery_stopped_without_proof(self):
        p=copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']=='valid-recovery_receipt'))
        p.update(decision='proven_stopped',proofs=[])
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_legacy_producer_missing_transitive_edge(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='legacy:E02.local_dispatch')['requires'].remove('legacy:C06.start_resolver'))

    def test_legacy_producer_cycle(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='legacy:R05.qualifier_protocol')['requires'].append('legacy:V03.host_measurement'))

    def test_legacy_case_gate_consumer_removed(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='J27.scoped')['case_requirements'].remove('FM:WD-16'))

    def test_default_enable_needs_value(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='J27.default_enable').update(decision_requirements={}))

    def test_optin_allows_safety_only(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='J27.scoped').update(decision_requirements={'J25.e1':['continue']}))

    def test_migration_needs_own_certificate(self):
        self.rejects(lambda d:next(x for x in d['work-packages.json']['items'] if x['id']=='J08').update(schema_recovery_gate='J12.scoped'))

    def test_unassigned_oracle_not_executable(self):
        self.assertFalse(v.oracle_ready_for_execution(self.data['acceptance-cases.json']['cases'][0]['oracle_spec']))

    def frozen_oracle(self):
        o=copy.deepcopy(self.data['acceptance-cases.json']['cases'][0]['oracle_spec'])
        o.update(assignment_state='frozen',author_principal='test-author',implementation_principals=['test-builder'],custodian_principal='test-custodian',reviewer_principals=['test-reviewer'],pinned_digest='a'*64,frozen_at_ms=10,candidate_created_at_ms=11)
        return o

    def test_legitimate_frozen_oracle_accepted(self):
        o=self.frozen_oracle();self.assertTrue(v.oracle_ready_for_execution(o))
        self.data['acceptance-cases.json']['cases'][0]['oracle_spec']=o
        v.validate(self.data)

    def test_oracle_frozen_after_candidate_rejected(self):
        o=self.frozen_oracle();o['frozen_at_ms']=12
        self.assertFalse(v.oracle_ready_for_execution(o))

    def test_different_role_same_person_rejected(self):
        o=self.frozen_oracle();o['author_principal']='test-builder'
        self.assertFalse(v.oracle_ready_for_execution(o))

    def test_critical_oracle_self_review_rejected(self):
        o=self.frozen_oracle();o['reviewer_principals']=['test-author']
        self.assertFalse(v.oracle_ready_for_execution(o))

    def payload(self,id):
        return copy.deepcopy(next(x['payload'] for x in self.data['fixtures/contracts.json']['fixtures'] if x['id']==id))

    def test_legacy_null_recovery_identity(self):
        self.assertFalse(v.payload_errors(self.payload('legacy-recovery-null-identities'),self.data['contract.schema.json']))

    def test_legacy_stopped_claim_rejected(self):
        p=self.payload('legacy-recovery-null-identities');p['decision']='proven_stopped'
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_effect_cannot_use_legacy_null(self):
        p=self.payload('valid-recovery_receipt');p['binding_generation']=None
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_subject_target_mismatch(self):
        p=self.payload('valid-broker-recovery');p['target']='home'
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_broker_proof_identity_required(self):
        p=self.payload('valid-broker-recovery');p['decision']='proven_stopped';p['proofs']=[{'type':'invocation_contained','subject_digest':p['subject_digest'],'evidence_digest':'a'*64,'producer_ref':'test-host'}]
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))
        p['proofs'][0]['broker_identity']={'broker_id':p['subject']['broker_id'],'lease_id':p['subject']['lease_id'],'schema':p['actual_target_schema'],'owner_generation':p['owner_generation']}
        self.assertFalse(v.payload_errors(p,self.data['contract.schema.json']))

    def test_finance_caps_must_be_enforceable(self):
        p=self.payload('valid-trial_permit');profile=self.payload('valid-support_profile');profile['budget_enforceability']={k:'enforceable' for k in ['wall','actions','tokens','cost']};profile['budget_enforceability']['cost']='unavailable'
        self.assertTrue(v.permit_profile_errors(p,profile));p.pop('max_cost_microusd')
        self.assertFalse(v.permit_profile_errors(p,profile))

    def test_role_projection_requires_distinct_field(self):
        p=self.payload('valid-method_binding');p['role_materials'][0]['required_artifacts_digest']=p['role_materials'][0].pop('role_required_artifacts_digest')
        self.assertTrue(v.payload_errors(p,self.data['contract.schema.json']))

    def test_original_optin_gate_consumed(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='J27.scoped')['requires'].remove('local:E02.local_dispatch'))

    def test_cannot_defer_safety_case_to_claim_optin(self):
        self.rejects(lambda d:next(x for x in d['legacy-case-map.json']['items'] if x['id']=='FM:WD-16').update(local_opt_in_applicability='deferred',local_opt_in_reason='later'))

    def test_original_full_completion_consumes_cases(self):
        self.rejects(lambda d:next(x for x in d['execution-gates.json']['gates'] if x['id']=='J27.full_original_completion')['requires'].remove('J14.legacy_full'))

    def test_digest_vector_must_use_registered_domain(self):
        self.rejects(lambda d:next(x for x in d['fixtures/digest-vectors.json']['vectors'] if x['id']=='domain-support_profile_digest').update(domain='osstack.joint.trial-profile.v1'))

    def test_digest_field_domain_must_match_catalog(self):
        self.rejects(lambda d:next(x for x in d['fixtures/digest-vectors.json']['vectors'] if x['id']=='domain-support_profile_digest').update(domain='osstack.joint.method-binding.v1'))

    def test_default_release_each_original_qualification_consumed(self):
        for required in ['legacy:R05.qualifier_protocol','legacy:V03.host_measurement','legacy:V06.trust_operations']:
            with self.subTest(required=required):
                d=v.load();next(x for x in d['execution-gates.json']['gates'] if x['id']=='J27.default_enable')['requires'].remove(required)
                with self.assertRaises(ValueError):v.validate(d)

if __name__=='__main__':
    unittest.main(verbosity=2)
