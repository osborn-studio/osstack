#!/usr/bin/env python3
"""Read-only checks for the joint design; never opens an OSStack database."""
from __future__ import annotations
import argparse
import copy
import hashlib
import gzip
import json
from pathlib import Path
import re
import subprocess
import sys
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
NAMES = ('baseline.json', 'capability-map.json', 'work-packages.json',
         'legacy-work-map.json', 'acceptance-cases.json', 'sources.json',
         'contract.schema.json', 'fixtures/contracts.json', 'fixtures/digest-vectors.json',
         'legacy-case-map.json', 'execution-gates.json', 'unknowns.json',
         'source-coverage.json', 'artifact-catalog.json', 'digest-catalog.json')

def require(condition, message):
    if not condition:
        raise ValueError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def load(root=ROOT):
    return {name: json.loads((root / name).read_text()) for name in NAMES}

def unique(rows, label):
    ids = [row['id'] for row in rows]
    require(len(ids) == len(set(ids)), f'{label}: duplicate ID')
    return set(ids)

def dag(rows, key, label):
    mapping = {r['id']: r[key] for r in rows}
    active, done = set(), set()
    def visit(node):
        require(node in mapping, f'{label}: unknown dependency {node}')
        require(node not in active, f'{label}: dependency cycle at {node}')
        if node in done:
            return
        active.add(node)
        for dep in mapping[node]:
            visit(dep)
        active.remove(node)
        done.add(node)
    for node in mapping:
        visit(node)

def payload_errors(payload, schema):
    errors = [e.message for e in Draft202012Validator(schema).iter_errors(payload)]
    if errors:
        return errors
    kind = payload['kind']
    if kind == 'source_pin':
        path = payload['subdir']
        if path!='.' and (path.startswith('/') or '\\' in path or any(s in ('','.','..') for s in path.split('/')) or any(ord(c)<32 or ord(c)==127 for c in path)):
            errors.append('source path escape')
    if kind == 'trial_permit' and payload['expires_at_ms'] <= payload['issued_at_ms']:
        errors.append('permit expiry must follow issue time')
    if kind == 'trial_permit':
        ttl=payload['expires_at_ms']-payload['issued_at_ms']
        if ttl>86400000 or payload['max_wall_ms']>ttl:
            errors.append('permit TTL or wall budget invalid')
    if kind == 'check_binding':
        checks = payload['checks']
        if len({c['id'] for c in checks}) != len(checks):
            errors.append('duplicate check ID')
        selected = [c for c in checks if c['id'] == payload['primary_id']]
        if len(selected) != 1 or not selected[0]['required'] or selected[0]['role'] != 'acceptance':
            errors.append('primary must select exactly one required acceptance')
    if kind == 'context_receipt' and payload['method_bytes'] > payload['prompt_bytes']:
        errors.append('method bytes exceed actual prompt')
    if kind == 'method_binding':
        if {r['role'] for r in payload['role_materials']} != {'builder','reviewer','verifier'}:
            errors.append('role material coverage incomplete or duplicated')
    if kind == 'recovery_receipt':
        decision=payload['decision']; phase=payload['prior_phase']; subject=payload['subject']
        if (subject['kind']=='broker_lease') != (payload['target']=='broker'):
            errors.append('subject target mismatch')
        if subject['home_id']!=payload['target_home_id']:
            errors.append('subject home mismatch')
        if subject['kind']=='broker_lease' and phase!='broker_unknown':
            errors.append('broker phase mismatch')
        if subject['kind']!='broker_lease' and phase=='broker_unknown':
            errors.append('home phase mismatch')
        if subject['kind']=='effect' and (payload['binding_generation'] is None or payload['support_profile_digest'] is None):
            errors.append('effect requires actual binding and profile')
        if phase=='legacy_unknown' and decision!='preserve_unknown':
            errors.append('legacy invocation cannot be proven by invented identity')
        if phase=='reserved' and payload['prior_resolution']!='none' and decision!='preserve_unknown':
            errors.append('resolution forbids reserved cancellation proof')
        if subject['kind']=='broker_lease' and decision not in ('preserve_unknown','proven_stopped'):
            errors.append('broker supports preserve or contained only')
        if subject['kind']=='broker_lease' and decision=='proven_stopped':
            for proof in payload['proofs']:
                b=proof.get('broker_identity',{})
                if b.get('broker_id')!=subject['broker_id'] or b.get('lease_id')!=subject['lease_id'] or b.get('schema')!=payload['actual_target_schema'] or b.get('owner_generation')!=payload['owner_generation']:
                    errors.append('broker proof identity mismatch')
        expected={'proven_not_started':'cancelled_before_dispatch',
                  'proven_stopped':'invocation_contained','applied_observed':'applied_completion'}
        if decision=='proven_not_started' and phase!='reserved':
            errors.append('committed or legacy effect cannot be proven not started')
        if decision in ('proven_stopped','applied_observed') and phase=='reserved':
            errors.append('reserved phase requires reconciliation, not completion proof')
        if payload['subject']['kind']=='effect' and payload.get('effect_id')!=payload['subject']['effect_id']:
            errors.append('recovery subject effect mismatch')
        if decision in expected and not any(p['type']==expected[decision] and p['subject_digest']==payload['subject_digest'] for p in payload['proofs']):
            errors.append('decision requires matching typed proof for exact effect')
    return errors

def parse_canonical_input(raw):
    def pairs(rows):
        result={}
        for key,value in rows:
            require(key not in result, 'duplicate JSON key')
            result[key]=value
        return result
    def integer(value):
        require(value!='-0' and abs(int(value))<=9007199254740991, 'invalid canonical integer')
        return int(value)
    def invalid_float(value):
        raise ValueError('floating point disallowed')
    value=json.loads(raw,object_pairs_hook=pairs,parse_int=integer,parse_float=invalid_float,parse_constant=invalid_float)
    def check(value):
        if isinstance(value,str):
            require(not any(0xd800<=ord(c)<=0xdfff for c in value),'invalid Unicode')
        if isinstance(value,dict):
            for k,v in value.items():
                require(k.isascii(), 'non-ASCII protocol key');check(k);check(v)
        if isinstance(value,list):
            for v in value:check(v)
    check(value)
    return value

def oracle_metadata_errors(o):
    errors=[];state=o['assignment_state']
    if state not in ('unassigned','assigned','frozen','executed'):return ['unknown oracle state']
    if state=='unassigned':
        if o['pinned_digest'] is not None or o.get('author_principal') is not None:errors.append('unassigned oracle has fabricated identity')
        return errors
    implementers=set(o.get('implementation_principals',[]));author=o.get('author_principal');custodian=o.get('custodian_principal');reviewers=set(o.get('reviewer_principals',[]))
    if not author or not custodian or not implementers or author in implementers or custodian in implementers or reviewers & implementers:errors.append('oracle personnel not independent')
    if state in ('frozen','executed'):
        if not re.fullmatch(r'[a-f0-9]{64}',o.get('pinned_digest') or ''):errors.append('oracle digest missing')
        if not reviewers or author in reviewers:errors.append('second independent reviewer missing')
        before=o.get('frozen_at_ms');candidate=o.get('candidate_created_at_ms')
        if not isinstance(before,int) or not isinstance(candidate,int) or before>=candidate:errors.append('oracle must freeze before candidate')
    if state=='executed' and not o.get('result_record_ref'):errors.append('oracle result record missing')
    return errors

def oracle_ready_for_execution(o):
    return o['assignment_state'] in ('frozen','executed') and not oracle_metadata_errors(o)

def permit_profile_errors(permit, profile):
    errors=[];enforce=profile['budget_enforceability']
    for field,dimension in [('max_wall_ms','wall'),('max_actions','actions'),('max_tokens','tokens'),('max_cost_microusd','cost')]:
        if field in permit and enforce[dimension]!='enforceable':errors.append('unsupported hard cap: '+dimension)
    return errors

def preflight_blockers(data, work_item, stage):
    """Planning-stage unknown check only; this never grants runtime authority."""
    return [u['id'] for u in data['unknowns.json']['items'] if u['status']=='open'
            and {'work_item':work_item,'stage':stage} in u['blocks']]

# Reviewed component substitutions are a closed list, never arbitrary dependency bypasses.
COMPONENT_GATE_OVERRIDES = {work: {'J01': 'J01.contracts'} for work in ('J02', 'J03', 'J04', 'J11')}
PROTECTED_HOST_CASE_FIELDS = ('id', 'owner_work_item', 'title', 'given', 'when', 'then',
    'bad_variant', 'oracle', 'required_evidence', 'layer', 'capabilities', 'asserts', 'covers_negative_ids')
PINNED_LAYER_SPEC_FILES = {'ja01-ja02-original.json': 'd7740ae67078c478c32a6d7a36f997a7f16ae649d6391b699e4ee22512bd6fbb', 'component-case-specs.json': 'e559ee91429e4908bfc6ec0278d20726c8f2b1023c2a83a5d1ec50e454cec73d', 'component-slice-specs.json': '761206b2d4a79ed10a0c32c1e9f89eed349d8f71137bd7a27d046d80ad81f97d'}
COMPONENT_EVIDENCE_BINDING_RULE = 'Every component and host result binds the exact candidate and immutable contract/entry source and configuration digests. A regression-only host slice cannot change frozen contract artifacts; any changed byte invalidates dependent evidence and requires re-evaluation on the composed candidate. No snapshot grants a reusable runtime lease.'
PROTECTED_HOST_CASE_DIGESTS = {
    'JA01': '93ba311087389cd57098152941ae9dded1bdf244c77af2787a6d1295eabf60ce',
    'JA02': 'bf72e8d50bdd66f5306a18198689199cd5cbdbc9cb0a95db551dee4f36862f4d',
}

def component_dependency_gates(work, gm):
    overrides = work.get('dependency_gate_overrides', {})
    expected = COMPONENT_GATE_OVERRIDES.get(work['id'], {})
    require(isinstance(overrides, dict) and overrides == expected,
            work['id'] + ': unregistered component dependency override')
    for producer, gate in overrides.items():
        require(producer in work['depends_on'] and gate in gm
                and gm[gate]['owner_work_item'] == producer,
                work['id'] + ': component override producer mismatch')
    return {overrides.get(dep, dep + '.scoped') for dep in work['depends_on']}

def validate_gate_layers(data, root, wm, gm, cases, closure):
    case_map = {case['id']: case for case in cases}
    for cid, expected in PROTECTED_HOST_CASE_DIGESTS.items():
        require(cid in case_map, cid + ': protected host case missing')
        case = case_map[cid]
        require(all(field in case for field in PROTECTED_HOST_CASE_FIELDS), cid + ': protected host field missing')
        actual = sha(json.dumps({field: case[field] for field in PROTECTED_HOST_CASE_FIELDS},
                                sort_keys=True, ensure_ascii=False).encode())
        require(actual == expected, cid + ': protected host semantics changed')
    component_cases = {'J01.contracts': ['JA59', 'JA70'], 'J08.admission_boundary': ['JA02', 'JA71']}
    for gid, owner, stage in [('J01.contracts', 'J01', 'component_contract_acceptance'),
                              ('J08.admission_boundary', 'J08', 'real_host_non_effecting_admission_boundary')]:
        require(gid in gm and gm[gid]['owner_work_item'] == owner and gm[gid]['stage'] == stage,
                gid + ': component gate owner/stage mismatch')
    require(gm['J01.contracts']['requires'] == []
            and gm['J08.admission_boundary']['requires'] == ['J01.contracts', 'J05.scoped'], 'component producer prerequisites changed')
    require({'J01.contracts', 'J08.admission_boundary'} <= set(gm['J01.scoped']['requires']),
            'J01 host acceptance lacks real admission boundary')
    require('J01.scoped' in gm['J08.scoped']['requires'], 'trial precedes J01 host acceptance')
    require(gm['J08.admission_boundary'].get('effects') == 'none', 'early admission may not produce effects')
    for gate in gm.values():
        required = gate.get('joint_case_requirements', [])
        require(isinstance(required, list) and all(isinstance(cid, str) for cid in required)
                and len(required) == len(set(required)) and set(required) <= set(case_map),
                gate['id'] + ': unknown/duplicate joint case requirement')
        expected = component_cases.get(gate['id'])
        if gate['id'] == gate['owner_work_item'] + '.scoped':
            expected = wm[gate['owner_work_item']]['acceptance_ids']
        if expected is not None:
            require(set(required) == set(expected), gate['id'] + ': joint case coverage drift')
        else:
            require(not required, gate['id'] + ': unregistered joint case consumer')
    require(case_map['JA70']['owner_work_item'] == 'J01' and case_map['JA70']['layer'] == 'contract',
            'component case misclassified as host acceptance')
    for target in ('J27.scoped', 'J27.default_enable', 'J27.full_original_completion'):
        require('J01.scoped' in closure(target), target + ': release bypasses J01 host acceptance')
    for wid in wm:
        require(wid + '.scoped' in gm[wid + '.legacy_full']['requires'], wid + ': legacy wrapper drops scoped obligations')
    # Existing non-scoped edges retain the original host boundary as a direct prerequisite.
    for gid in ('J01.legacy_full', 'J10.protocol', 'J27.release_channel', 'J23.harness'):
        require('J01.scoped' in gm[gid]['requires'], gid + ': original host prerequisite lost')
    for gid in ('J08.scoped', 'J09.scoped', 'J14.scoped', 'J16.scoped', 'J17.scoped'):
        require({'J01.scoped', 'J08.admission_boundary'} <= closure(gid), gid + ': execution bypasses host boundary')
    pins = PINNED_LAYER_SPEC_FILES
    specs = {}
    for name, digest in pins.items():
        raw = (root / 'evidence/gate-layers' / name).read_bytes()
        require(sha(raw) == digest, name + ': frozen layer specification changed')
        specs[name] = json.loads(raw)
    original = specs['ja01-ja02-original.json']
    require(original['source_sha'] == 'd3fa7ef681efc79a5fb2dff92172ef1be0978774', 'host case baseline changed')
    stable_oracle_fields = ('kind', 'author_role', 'implementation_owner_role', 'observation_boundary', 'freeze_requirement')
    protected = original['cases'] + specs['component-case-specs.json']['cases']
    for expected in protected:
        current = case_map[expected['id']]
        require(all(current[field] == expected[field] for field in PROTECTED_HOST_CASE_FIELDS),
                expected['id'] + ': frozen case semantics changed')
        oracle = dict(expected['oracle_spec'])
        if expected['id'] == 'JA02':
            oracle['implementation_owner_role'] = wm['J08']['owner_role']
        require(all(current['oracle_spec'].get(field) == oracle[field] for field in stable_oracle_fields),
                expected['id'] + ': frozen oracle boundary changed')
    slice_registry = specs['component-slice-specs.json']['component_slices']
    for wid, work in wm.items():
        require(work.get('component_slices', []) == slice_registry.get(wid, []),
                wid + ': unregistered or changed component slice')
        if wid in COMPONENT_GATE_OVERRIDES:
            expected = sorted(component_dependency_gates(work, gm))
            require(work['pr']['base'] == 'main_after_required_base_gates'
                    and sorted(work['pr'].get('required_base_gates', [])) == expected,
                    wid + ': component PR base ignores reviewed gate selection')
    # A slice may share another package's files only after that package's scoped gate.
    # The closed registry prohibits arbitrary schema/effect-bearing slices.
    for wid, slices in slice_registry.items():
        for item in slices:
            require(item['requires'] == gm[item['gate']]['requires'], item['id'] + ': slice/gate prerequisite drift')
            require(item['owner_role'] == wm[wid]['owner_role'], item['id'] + ': slice owner mismatch')
            for other, work in wm.items():
                if other != wid and set(item['write_paths']) & set(work['write_paths']):
                    require(other + '.scoped' in closure(item['gate']), item['id'] + ': unordered shared slice path')
    require(data['execution-gates.json'].get('component_evidence_binding_rule') == COMPONENT_EVIDENCE_BINDING_RULE,
            'component candidate binding rule changed')

def validate_audit_additions(data, root, works, caps, cases):
    wm={x['id']:x for x in works}
    assertions={a['id']:a for c in caps for a in c['semantic_assertions']}
    require(len(assertions)==sum(len(c['semantic_assertions']) for c in caps), 'duplicate semantic assertion')
    covered=set()
    for case in cases:
        require(case['asserts'] and set(case['asserts'])<=set(assertions), f"{case['id']}: unknown/missing assertion")
        covered.update(case['asserts'])
        oracle=case['oracle_spec']
        require(oracle['author_role']!=wm[case['owner_work_item']]['owner_role'], f"{case['id']}: oracle owner not independent")
        producer = oracle.get('implementation_producer_work_item', case['owner_work_item'])
        require(producer == ('J08' if case['id'] == 'JA02' else case['owner_work_item']),
                case['id'] + ': unregistered oracle implementation producer')
        require(oracle['implementation_owner_role'] == wm[producer]['owner_role'], f"{case['id']}: oracle implementation owner drift")
        require(not oracle_metadata_errors(oracle), f"{case['id']}: invalid oracle lifecycle")
        require(all(e.startswith(case['id']+':') for e in case['required_evidence']), f"{case['id']}: generic evidence template")
    require(covered==set(assertions), 'semantic assertion not covered')
    negatives={n['id']:n for c in caps for n in c['negative_case_bindings']}
    for case in cases:
        require(set(case['covers_negative_ids'])<=set(negatives),'unknown negative case')
    for nid,negative in negatives.items():
        require(set(negative['case_ids'])=={c['id'] for c in cases if nid in c['covers_negative_ids']} and negative['case_ids'],f'{nid}: negative coverage lost')
    oldfm=json.loads((root/'evidence/inputs/firstmate-pilot-scenarios.json').read_text())['scenarios']
    oldps=json.loads((root/'evidence/inputs/pstack-acceptance-cases.json').read_text())['cases']
    originals={**{'FM:'+x['id']:x for x in oldfm},**{'PS:'+x['id']:x for x in oldps}}
    rows=data['legacy-case-map.json']['items']
    require(unique(rows,'legacy cases')==set(originals), 'legacy case coverage incomplete')
    for row in rows:
        old=originals[row['id']]
        require(row['source_case_sha256']==sha(json.dumps(old,sort_keys=True,ensure_ascii=False).encode()), f"{row['id']}: legacy case changed")
        require(row['original_status']==old.get('execution_status',old.get('status')), f"{row['id']}: legacy status changed")
        require(row['disposition']=='retained_as_gate' and row['assertion'] and row['joint_pass_implies_legacy_pass'] is False, f"{row['id']}: legacy gate dropped")
        require(row['gate_owner_work_item'] in wm, f"{row['id']}: unknown gate owner")
    for w in works:
        require(set(w['legacy_gate_ids'])=={r['id'] for r in rows if r['gate_owner_work_item']==w['id']}, f"{w['id']}: legacy gate owner mismatch")
    g=data['execution-gates.json']; ids=unique(g['gates'],'execution gates');dag(g['gates'],'requires','execution gates')
    require({w['id']+'.scoped' for w in works}<=ids, 'scoped gates incomplete')
    for item in g['gates']:
        require(item['owner_work_item'] in wm and item['evidence_state']=='specified_not_run', 'gate overclaims evidence')
    gm={x['id']:x for x in g['gates']}
    for w in works:
        required_dependencies = component_dependency_gates(w, gm)
        require(required_dependencies <= set(gm[w['id']+'.scoped']['requires']) or w['id']=='J25', f"{w['id']}: package dependency absent from stage gate")
        require(w['pr']['key']=='JP-'+w['id'][1:],f"{w['id']}: PR key mismatch")
        if w.get('introduces_schema'):
            require({'packages/core/src/state/db.ts','packages/core/src/state/migrations.ts','packages/core/src/state/schema.ts'}<=set(w['write_paths']),f"{w['id']}: schema registration paths missing")
            require(w.get('resource_queue')=='state-owner-schema-queue' and w.get('schema_recovery_gate') in gm, f"{w['id']}: schema recovery/queue missing")
    for work,expected in {'J14':['J13','J02','J23'],'J27':['J16','J23','J24','J26','J31'],'J08':['J12'],'J10':['J12'],'J13':['J12']}.items():
        require(set(expected)<=set(wm[work]['depends_on']),f'{work}: safety prerequisite missing')
    for gate,required in {'J05.scoped':['J25.e0'],'J25.e1':['J09.scoped'],'J10.scoped':['J25.e1','J23.method_context'],'J16.scoped':['J14.qualification'],'J17.scoped':['J17.recovery']}.items():
        require(set(required)<=set(gm[gate]['requires']), f'{gate}: critical stage gate missing')
    oldg=json.loads((root/'evidence/inputs/firstmate-delivery-gates.json').read_text())
    originalg={x['id']:x for x in oldg['milestones']}
    require(unique(g['legacy_gate_map'],'legacy gates')==set(originalg), 'inherited milestone projection incomplete')
    for row in g['legacy_gate_map']:
        old=originalg[row['id']]
        require(row['original_requires']==old['requires'] and row['original_definition_sha256']==sha(json.dumps(old,sort_keys=True,ensure_ascii=False).encode()), f"{row['id']}: inherited gate changed")
        require(row['producer_gate'] in ids, f"{row['id']}: missing producer")
    def closure(id,seen=None):
        found=set() if seen is None else seen
        for dep in gm[id]['requires']:
            if dep not in found:found.add(dep);closure(dep,found)
        return found
    validate_gate_layers(data, root, wm, gm, cases, closure)
    lg={r['id']:r for r in g['legacy_gate_map']}
    for row in g['legacy_gate_map']:
        require({lg[dep]['producer_gate'] for dep in row['original_requires']}<=closure(row['producer_gate']),f"{row['id']}: original producer closure missing")
        require(row['component_gate'] in closure(row['producer_gate']),f"{row['id']}: component producer missing")
    case_map={r['id']:r for r in rows}
    for row in rows:
        consumers={x['id'] for x in g['gates'] if row['id'] in x.get('case_requirements',[])}
        require(set(row['gates'])==consumers and row['gate_owner_work_item']+'.legacy_full' in consumers,f"{row['id']}: case gate consumer missing")
        if row['local_opt_in_applicability']=='required':require('J27.scoped' in consumers,f"{row['id']}: opt-in case gate lost")
        else:require(row['local_opt_in_reason'] and 'J27.scoped' not in consumers, 'case scope mismatch')
    for x in g['gates']:require(set(x.get('case_requirements',[]))<=set(case_map),'unknown legacy case gate')
    require(gm['J27.scoped']['decision_requirements']=={'J25.e1':['continue','safety_only']} and 'J32.scoped' not in closure('J27.scoped'),'opt-in/default conflated')
    require(gm['J27.default_enable']['decision_requirements']=={'J25.e1':['continue'],'J32.scoped':['continue']} and {'J27.scoped','J32.scoped'}<=set(gm['J27.default_enable']['requires']),'default enable lacks value gate')
    for wid in ['J08','J10','J13','J21','J22']:
        require(wm[wid]['schema_recovery_gate']==wid+'.recovery' and wid+'.schema_spec' in gm[wid+'.recovery']['requires'] and wid+'.recovery' in gm[wid+'.scoped']['requires'],wid+': per-migration evidence absent')
    expected_deferred={'FM:WD-32','FM:WD-34','PS:A05','PS:A20','PS:A25','PS:A26','PS:A27','PS:A28','PS:A29','PS:A30','PS:A31','PS:A32'}
    require(set(g['local_deferred_case_ids'])==expected_deferred and {r['id'] for r in rows if r['local_opt_in_applicability']=='deferred'}==expected_deferred,'local scope case exclusions changed')
    def local_project(id):
        if id=='I04.compat_recovery':return {'J13.recovery','J12.scoped'}
        return {('local:' if id in ('C03.budget_storage','C04.start_dispatch','E02.local_dispatch') else 'legacy:')+id}
    for target,release in [('J27.scoped','S2_opt_in'),('J27.default_enable','S2_default_enable')]:
        expected=set().union(*(local_project(id) for id in g['legacy_release_requirements'][release]))
        require(expected==set(g['release_bindings'][target]['required_producers']) and expected<=set(gm[target]['requires']),target+': original release not consumed')
    require({r['producer_gate'] for r in g['legacy_gate_map']}|{w+'.legacy_full' for w in wm}<=set(gm['J27.full_original_completion']['requires']),'full original completion missing gates')
    require(g['oracle_policy']['independent_principals'] and g['oracle_policy']['freeze_before']=='candidate_created_at_ms','oracle execution gate weak')
    require(g['legacy_release_requirements']==oldg['release_requirements'], 'inherited release gate lost')
    require(g['local_override']['decision']=='JADR12' and g['local_override']['scope']=='local_without_broker', 'unscoped recovery gate relaxation')
    # Preserve the complete existing JADR12 exception, including its broker prohibition.
    require(sha(json.dumps(g['local_override'], sort_keys=True, ensure_ascii=False).encode())
            == '4440b3481a0047923f36d4af8dc08434b85816bfa43e77f7bdd3ff8233629200', 'JADR12 home-only exception semantics changed')
    unknowns=data['unknowns.json']['items'];require(unique(unknowns,'unknowns')=={f'O{i:02}' for i in range(1,7)}, 'unknown coverage incomplete')
    for u in unknowns:
        require(u['status']=='open' and not u['evidence_refs'], 'unresolved unknown marked resolved without execution')
        require(u['blocks'] and all(b['work_item'] in wm and b['stage'] for b in u['blocks']), 'unknown blocker target invalid')
    for w in works:
        require(set(w['blocked_by'])=={u['id'] for u in unknowns if any(b['work_item']==w['id'] for b in u['blocks'])}, f"{w['id']}: blocking unknown omitted")
    vectors=data['fixtures/digest-vectors.json']['vectors']
    require(len(vectors)>=11,'digest vectors missing')
    domains={x['domain'] for x in data['digest-catalog.json']['definitions']}
    for v in vectors:
        if v['valid']:
            require(v['domain'] in domains, 'vector uses unregistered domain: '+v['id'])
            field=v['id'][7:] if v['id'].startswith('domain-') else None
            if field in {x['field'] for x in data['digest-catalog.json']['definitions']}:
                require(v['domain']==next(x['domain'] for x in data['digest-catalog.json']['definitions'] if x['field']==field),'vector domain differs from field catalog')
            canonical=json.dumps(v['input'],ensure_ascii=False,sort_keys=True,separators=(',',':'))
            preimage=(v['domain']+'\n'+canonical).encode()
            require(canonical==v['canonical_json'] and preimage.hex()==v['preimage_utf8_hex'] and sha(preimage)==v['sha256'], f"digest vector mismatch: {v['id']}")
        else:
            try:parse_canonical_input(v['raw_json'])
            except (ValueError,UnicodeError):pass
            else:raise ValueError('invalid canonical vector accepted: '+v['id'])
    definitions={x['field'] for x in data['digest-catalog.json']['definitions']}
    def digest_fields(value):
        result=set()
        if isinstance(value,dict):
            result.update(k for k in value.get('properties',{}) if k.endswith('_digest'))
            for v in value.values():result.update(digest_fields(v))
        elif isinstance(value,list):
            for v in value:result.update(digest_fields(v))
        return result
    require(digest_fields(data['contract.schema.json'])<=definitions,'undefined digest input')
    coverage=data['source-coverage.json']['files'];require(len(coverage)==200 and len({x['path'] for x in coverage})==200,'pstack source inventory incomplete')
    source_map={x['id']:x for x in data['sources.json']['sources']}
    for entry in coverage:
        require(entry['classification'] and entry['reason'],'unclassified pstack source')
        if entry['source_ref']:
            require(entry['source_ref'] in source_map and entry['sha256']==source_map[entry['source_ref']]['sha256'],'source inventory pin mismatch')
    for name in ['firstmate-sources.json','firstmate-source-additions.json']:
        for old in json.loads((root/'evidence/inputs'/name).read_text())['sources']:
            new=source_map['FM:'+old['id']]
            require(new['inspection']==old['inspection'] and new['usage']==old.get('usage','as_recorded_in_original_design'),'source inspection depth lost')
    require({m['kind'] for m in data['artifact-catalog.json']['materials']}=={'intent_frame','grounding','impact_map','verification_plan','review_dispositions','decision_trail','feature_map','experiment_result','usage_sketch','prototype_decision'},'method material taxonomy lost')
    architecture=(root/'architecture.md').read_text()
    adr_ids=re.findall(r'\*\*(JADR\d+)\*\*',architecture)
    require(len(adr_ids)==len(set(adr_ids)) and 'JADR15' in adr_ids,'duplicate or missing ADR')
    plan=(root/'implementation-plan.md').read_text()
    for left,right in re.findall(r'\b(J\d{2})(?:\[[^\]]*\])?\s*-->\s*(J\d{2})',plan):
        require(left in wm[right]['depends_on'],f'mermaid edge drift: {left}->{right}')
    return {'legacy_cases_retained':len(rows),'stage_gates':len(ids),'semantic_assertions':len(assertions),'unresolved_unknowns':len(unknowns)}

def validate(data, root=ROOT, check_inputs=True):
    baseline = data['baseline.json']
    caps = data['capability-map.json']['capabilities']
    works = data['work-packages.json']['items']
    legacy = data['legacy-work-map.json']['items']
    cases = data['acceptance-cases.json']['cases']
    sources = data['sources.json']['sources']
    fixtures = data['fixtures/contracts.json']['fixtures']
    cap_ids, work_ids = unique(caps, 'capabilities'), unique(works, 'work')
    legacy_ids, case_ids = unique(legacy, 'legacy'), unique(cases, 'cases')
    source_ids = unique(sources, 'sources')
    unique(fixtures, 'fixtures')
    require(cap_ids == {f'FM-{i:02}' for i in range(1,25)} | {f'PS{i:02}' for i in range(1,25)}, 'source capability set incomplete')
    require(work_ids == {f'J{i:02}' for i in range(1,33)}, 'joint milestone set incomplete')
    require(case_ids == {f'JA{i:02}' for i in range(1,73)}, 'acceptance set incomplete')
    fm_snapshot = json.loads((root/'evidence/inputs/firstmate-work-packages.json').read_text())
    expected_legacy = {'FM:'+x['id'] for x in fm_snapshot['items']} | {'PS:W'+str(i).zfill(2) for i in range(1,20)}
    require(legacy_ids == expected_legacy, 'legacy task coverage incomplete')
    require(baseline['scope'] == 'design_and_executable_spec_only' and baseline['runtime_enabled'] is False, 'baseline overclaims runtime')
    for name in ('capability-map.json', 'work-packages.json', 'legacy-work-map.json'):
        require(data[name]['runtime_enabled'] is False, f'{name}: runtime enabled')
    normalized = unique(data['capability-map.json']['normalized_capabilities'], 'normalized')
    for row in caps:
        require(row['runtime_enabled'] is False, f"{row['id']}: runtime enabled")
        require(row['normalized_capability'] in normalized, f"{row['id']}: unknown normalized capability")
        for field, allowed in [('source_refs',source_ids),('joint_work_items',work_ids),('legacy_work_items',legacy_ids),('acceptance_ids',case_ids)]:
            require(row[field] and set(row[field]) <= allowed, f"{row['id']}: empty/unknown {field}")
        require(row['semantic_difference'] and row['observable_result'], f"{row['id']}: behavior missing")
        if row['source_family']=='pstack':
            require(row['full_work_packages'] and set('PS:'+w for w in row['full_work_packages']) == set(row['legacy_work_items']), f"{row['id']}: full W mapping missing")
    case_map={x['id']:x for x in cases}
    for row in works:
        require(row['state']=='planned' and row['runtime_enabled'] is False, f"{row['id']}: false completion")
        require(row['pr']['status']=='planned_not_created', f"{row['id']}: false PR claim")
        for field in ('owner_role','write_paths','inputs','outputs','acceptance','rollback','verification','acceptance_ids'):
            require(row[field], f"{row['id']}: missing {field}")
        require(set(row['acceptance_ids']) <= case_ids, f"{row['id']}: unknown acceptance")
        require(all(case_map[c]['owner_work_item']==row['id'] for c in row['acceptance_ids']), f"{row['id']}: wrong case owner")
        require(set(row['acceptance_ids']) == {c['id'] for c in cases if c['owner_work_item']==row['id']}, f"{row['id']}: owned acceptance missing from work package")
    for row in legacy:
        require(row['joint_work_items'] and set(row['joint_work_items']) <= work_ids, f"{row['id']}: unmapped legacy task")
    # Preserve every inherited Firstmate edge; narrowing J milestones cannot erase original gates.
    fm_base={x['id']:x for x in json.loads((root/'evidence/inputs/firstmate-base-work-items.json').read_text())['work_items']}
    lm={x['id']:x for x in legacy}
    for x in fm_snapshot['items']:
        req=set(fm_base.get(x['id'],{}).get('depends_on',[])+x.get('depends_on_add',[]))
        require(set(lm['FM:'+x['id']]['source_requires']) == {'FM:'+d for d in req}, f"FM:{x['id']}: inherited dependency lost")
        require(lm['FM:'+x['id']]['source_state']==x['current_state'], f"FM:{x['id']}: historical state overwritten")
    # Preserve the original pstack graph, including edges deliberately rescoped
    # by the joint plan. Historical facts and effective prerequisites differ.
    old_spec=(root/'evidence/inputs/pstack-revision2-integration-spec.md').read_text()
    old_packages=re.findall(r'^### (W\d{2})[^\n]*\n\n依赖：([^。]+)',old_spec,re.M)
    require(len(old_packages)==19, 'pstack historical dependency source incomplete')
    for package, dependency_text in old_packages:
        expected={'PS:'+w for w in re.findall(r'W\d{2}',dependency_text)}
        require(set(lm['PS:'+package]['source_requires'])==expected, f'PS:{package}: inherited dependency lost')
        require(lm['PS:'+package]['source_state']=='specified_not_implemented', f'PS:{package}: historical state overwritten')
    for row in cases:
        require(row['owner_work_item'] in work_ids, f"{row['id']}: unknown owner")
        require(row['executed'] is False and row['status']=='specified_not_run', f"{row['id']}: unexecuted case marked passed")
        require(set(row['capabilities']) <= cap_ids, f"{row['id']}: unknown capability")
        for field in ('given','when','then','bad_variant','oracle','required_evidence'):
            require(row[field], f"{row['id']}: missing {field}")
    for c in caps:
        require(set(c['acceptance_ids']) == {x['id'] for x in cases if c['id'] in x['capabilities']}, f"{c['id']}: asymmetric case mapping")
        require({case_map[a]['owner_work_item'] for a in c['acceptance_ids']} <= set(c['joint_work_items']), f"{c['id']}: acceptance owner absent from work coverage")
    dag(works,'depends_on','joint')
    merge_rows=[{'id':x['id'],'requires':list(set(x['depends_on']+x['merge_after']))} for x in works]
    dag(merge_rows,'requires','joint_merge_order')
    merge_graph={r['id']:r['requires'] for r in merge_rows}
    def ancestors(node):
        result=set()
        for dep in merge_graph[node]:
            result.add(dep); result.update(ancestors(dep))
        return result
    for i,left in enumerate(works):
        for right in works[i+1:]:
            overlap=set(left['write_paths']) & set(right['write_paths'])
            if overlap:
                queued=any(overlap<=set(q['paths']) and left.get('resource_queue')==q['id']==right.get('resource_queue')
                           and q['resource'] in left['write_resources'] and q['resource'] in right['write_resources']
                           for q in data['execution-gates.json']['resource_queues'])
                require(queued or left['id'] in ancestors(right['id']) or right['id'] in ancestors(left['id']), f"shared write paths lack merge order: {left['id']}/{right['id']}")
    dag(legacy,'source_requires','legacy')
    schema=data['contract.schema.json']
    Draft202012Validator.check_schema(schema)
    kinds={definition['properties']['kind']['const'] for definition in schema['$defs'].values()
           if 'kind' in definition.get('properties',{})}
    require(kinds, 'boundary schema coverage empty')
    fixture_ids={f['id'] for f in fixtures}
    require({prefix+kind for kind in kinds for prefix in ('valid-','unknown-','missing-')} <= fixture_ids,
            'boundary fixture coverage incomplete')
    for fixture in fixtures:
        actual=not payload_errors(fixture['payload'],schema)
        require(actual is fixture['valid'], f"fixture expectation mismatch: {fixture['id']}")
    if check_inputs:
        for pin in baseline['inputs']:
            require(sha((root/pin['snapshot']).read_bytes())==pin['sha256'], f"input snapshot changed: {pin['snapshot']}")
        current_path=root.parents[1]/'reports/2026-10-26-pstack/capability-map.json'
        require(current_path.exists(), 'required pstack report missing; run in complete repository checkout')
        if current_path.exists():
            current=json.loads(current_path.read_text())
            old=json.loads((root/'evidence/inputs/pstack-capability-map.json').read_text())
            original={x['id']:x for x in old['capabilities']}
            joined={x['id']:x for x in caps}
            for row in current['capabilities']:
                require(row['work_packages']==joined[row['id']]['full_work_packages'],f"{row['id']}: pstack full mapping drift")
                require(row['article_delta_work_packages']==original[row['id']]['work_packages'],f"{row['id']}: historical delta lost")
                require(row['joint_work_items']==joined[row['id']]['joint_work_items'],f"{row['id']}: joint mapping drift")
    # New documents use only local links that can be reproduced without another checkout.
    for doc in root.glob('*.md'):
        text=doc.read_text()
        for target in re.findall(r'\]\(([^)]+)\)',text):
            if re.match(r'^[a-z]+:',target) or target.startswith('#'):
                continue
            path=target.split('#')[0]
            require((doc.parent/path).exists(),f'broken link: {doc.name} -> {target}')
    additions=validate_audit_additions(data,root,works,caps,cases)
    return {'source_capabilities':len(caps),'normalized_capabilities':len(normalized),'legacy_tasks':len(legacy),'joint_milestones':len(works),'future_product_cases':len(cases),'contract_fixtures':len(fixtures),'source_anchors':len(sources),'runtime_cases_executed':0,**additions}

def verify_historical_audit(data, root=ROOT):
    report=root.parents[1]/'reports/2026-10-26-pstack'
    archive=report/'evidence/claude-audit-2026-10-27'
    manifest=json.loads((archive/'input-manifest.json').read_text())
    frozen={pin['path']:root/pin['snapshot'] for pin in data['baseline.json']['inputs'] if pin['repository']=='workspace'}
    count=0
    for item in manifest['files']:
        if item['path'].startswith('report/'):
            name=item['path'][len('report/'):]
            key='docs/reports/2026-10-26-pstack/'+name
            path=frozen.get(key,report/name)
            require(sha(path.read_bytes())==item['sha256'],f'historical audited input mismatch: {name}')
            count+=1
    for mode,info in manifest['prompts'].items():
        raw=gzip.decompress((archive/(mode+'-input.txt.gz')).read_bytes())
        require(sha(raw)==info['sha256'] and len(raw)==info['bytes'],f'historical prompt changed: {mode}')
    for mode in ['audit','audit-recovered','challenge']:
        response=json.loads((archive/(mode+'-response.json')).read_text())
        require((archive/(mode+'-raw.md')).read_text()==response['result']+'\n',f'raw audit modified: {mode}')
    return {'reviewed_report_and_evidence_files_verified':count,'frozen_report_files':7,'unchanged_research_evidence_files':count-7,'exact_prompt_archives_verified':len(manifest['prompts']),'raw_responses_verified':3,'new_model_review_claimed':False}

def verify_sources(data, repos):
    checked=0
    cache={}
    for pin in data['sources.json']['sources']:
        require(pin['repository'] in repos, f"unknown source repository: {pin['repository']}")
        key=(pin['repository'],pin['commit'],pin['path'])
        if key not in cache:
            cache[key]=subprocess.check_output(['git','-C',str(repos[key[0]]),'show',key[1]+':'+key[2]],stderr=subprocess.PIPE)
        require(sha(cache[key])==pin['sha256'],f"source mismatch: {pin['id']}")
        checked+=1
    for pin in data['baseline.json']['inputs']:
        if pin['repository']=='osstack':
            actual=subprocess.check_output(['git','-C',str(repos['osstack']),'show',pin['commit']+':'+pin['path']],stderr=subprocess.PIPE)
            require(sha(actual)==pin['sha256'],f"input Git mismatch: {pin['path']}")
    return {'anchors_verified':checked,'unique_git_blobs_read':len(cache),'network_fetch_performed':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-sources',action='store_true')
    parser.add_argument('--osstack-repo',type=Path,default=ROOT.parents[2])
    parser.add_argument('--firstmate-repo',type=Path)
    parser.add_argument('--pstack-repo',type=Path)
    args=parser.parse_args()
    data=load(); result=validate(data)
    result['historical_audit']=verify_historical_audit(data)
    if args.verify_sources:
        result['sources']=verify_sources(data,{'osstack':args.osstack_repo,'firstmate':args.firstmate_repo or args.osstack_repo.parent/'firstmate','pstack':args.pstack_repo or args.osstack_repo.parent/'cursor-plugins'})
    print(json.dumps({'status':'passed_design_checks_only',**result},ensure_ascii=False,indent=2))

if __name__=='__main__':
    try:
        main()
    except (ValueError,KeyError,TypeError,FileNotFoundError,subprocess.CalledProcessError) as error:
        print(f'DESIGN VALIDATION FAILED: {error}',file=sys.stderr)
        sys.exit(1)
