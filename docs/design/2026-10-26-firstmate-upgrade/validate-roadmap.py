#!/usr/bin/env python3
"""Read-only design checks. Never opens a control-plane DB or executes sources."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def read(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'duplicate JSON key: {key}')
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=unique)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def index(rows):
    result = {row['id']: row for row in rows}
    require(len(result) == len(rows), 'duplicate record ID')
    return result


def sha(data):
    return hashlib.sha256(data).hexdigest()



def confined(ref):
    require(isinstance(ref, str) and ref and not Path(ref).is_absolute(), 'reference must be relative')
    path = (HERE / ref).resolve()
    require(path.is_relative_to(ROOT.resolve()), 'reference escapes repository')
    require(path.is_file(), f'missing reference: {ref}')
    return path


def strings(value, label, nonempty=True):
    require(isinstance(value, list) and (value or not nonempty), f'{label}: expected list')
    require(all(isinstance(x, str) and x.strip() for x in value), f'{label}: expected strings')
    require(len(set(value)) == len(value), f'{label}: duplicate entry')
    return value


def digest_value(value, size=64):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{'+str(size)+'}', value) is not None


def audit_checks(work, mapping, additions, items, sources, args):
    require(work['state_to_board'] == {'planned':'todo', 'local_pilot_complete':'done', 'partial_blocked':'blocked'}, 'invalid status projection')
    common = {f'R{i:02}' for i in range(1,6)} | {f'V{i:02}' for i in range(7)} | {'M01','M02'}
    require(set(strings(mapping['cross_cutting_work'], 'cross cutting')) == common, 'feature hidden in cross-cutting work')
    expected_frozen = {f'../2026-10-25-engineering-agent/{n}.json' for n in ['work-items','capabilities','sources','semantic-divergences']}
    require({r['path'] for r in work['frozen_manifests']} == expected_frozen and len(work['frozen_manifests']) == 4, 'frozen manifest coverage')
    for ref in work['frozen_manifests']:
        require(digest_value(ref['sha256']) and sha(confined(ref['path']).read_bytes()) == ref['sha256'], 'frozen source manifest changed')
    for wid, item in items.items():
        for field in ['owner_role','acceptance_add','verification']:
            require(isinstance(item[field], str) and item[field].strip(), f'{wid}: missing {field}')
        strings(item['depends_on_add'], wid+' dependencies', False)
        if item['current_state'] == 'partial_blocked':
            require(isinstance(item['unblock_condition'], str) and item['unblock_condition'].strip(), f'{wid}: missing unblock condition')
            strings(item['missing_evidence'], wid+' missing evidence')
        if 'proposed_targets' in item:
            for path in strings(item['proposed_targets'], wid+' targets'):
                require(not Path(path).is_absolute() and '..' not in Path(path).parts and path.endswith('.ts'), f'{wid}: target must be a proposed TS file')
    for source in sources.values():
        require(source['repository'] in {'firstmate','osstack'}, 'unknown source repository')
        require(digest_value(source['commit'], 40), 'source commit must be full immutable SHA')
        require(digest_value(source['sha256']), 'invalid source digest')
        p = source['path']
        require(isinstance(p,str) and p and not p.startswith('/') and not any(c in p for c in ['\\', ':', '\x00', '\n', '\r']), 'unsafe source path')
        require(all(x not in {'..','.',''} for x in p.split('/')), 'source path is not confined')
    contracts = read(confined('audit-contracts.json'))
    scenarios = index(contracts['scenarios'])
    require(set(scenarios) == {f'AT-{n:02}' for n in range(1,20)}, 'audit scenario coverage')
    for sc in scenarios.values():
        require(sc['status'] == 'planned' and isinstance(sc['assertion'],str) and sc['assertion'].strip(), 'planned scenario falsely reported as executed')
        require(set(strings(sc['owners'], 'scenario owners')) <= set(items), 'unknown scenario owner')
    capability_cases = index(contracts['capability_negative_cases'])
    require(set(capability_cases) == {f'FM-{n:02}-NEG' for n in range(1,25)}, 'capability scenario coverage')
    for cap in mapping['capabilities']:
        strings(cap['negative_cases'], cap['id']+' negative cases')
        sc = capability_cases[cap['negative_scenario_id']]
        require(sc['status'] == 'planned' and sc['capability'] == cap['id'] and sc['owner'] == 'R04' and sc['inputs'] == cap['negative_cases'], 'invalid capability scenario')
        require(isinstance(sc['required_result'],str) and sc['required_result'].strip(), 'missing negative expectation')
        for field in ['upstream_refs','additional_source_refs','current_code_refs','required_work_items','journeys']:
            strings(cap[field], cap['id']+' '+field, field != 'additional_source_refs')
        require(isinstance(cap['trigger'],str) and isinstance(cap['observable_result'],str), 'invalid behavior shape')
        strings(cap['negative_cases'], cap['id']+' negative cases')
    require(set(contracts['supplement_source_refs']) <= set(sources), 'unknown supplemental source')
    referenced = set(contracts['supplement_source_refs'])
    for cap in mapping['capabilities']:
        referenced.update(cap['upstream_refs'] + cap['additional_source_refs'] + cap['current_code_refs'])
    for source in additions['sources']:
        require(source['usage'] in {'contract_excerpt','inventory_only','implementation_identity'}, 'unclassified source use')
        require(source['id'] in referenced or source['usage'] == 'inventory_only', 'unreferenced source not inventoried')
        if source['usage'] == 'contract_excerpt':
            require(source['inspection'] == 'selected_contract_excerpt_read', 'hash-only source cannot prove behavior')
    for difference in contracts['semantic_divergences']:
        require(difference['scenario'] in scenarios and set(difference['owners']) <= set(items), 'unbound divergence')
        for field in ['review','reason','upstream','osstack']:
            require(isinstance(difference[field],str) and difference[field].strip(), 'incomplete divergence')
    gates = read(confined('delivery-gates.json'))
    milestones = index(gates['milestones'])
    active, done = set(), set()
    def visit_gate(gid):
        require(gid in milestones, 'unknown milestone')
        require(gid not in active, 'milestone cycle')
        if gid in done: return
        g = milestones[gid]
        require(g['owner'] in items and g['phase'] in {'contract','wired','host_qualified','default_enabled'}, 'invalid milestone owner/phase')
        require(g['status'] == 'planned' and isinstance(g['scope'],str) and g['scope'], 'milestone not a scoped plan')
        active.add(gid)
        for dep in strings(g['requires'], gid+' requires', False):visit_gate(dep)
        active.remove(gid); done.add(gid)
    for gid in milestones:visit_gate(gid)
    def closure(gid):
        return {gid}.union(*(closure(x) for x in milestones[gid]['requires']))
    for gid, g in milestones.items():
        if g.get('introduces_schema'):
            require('I04.compat_recovery' in closure(gid) - {gid}, 'schema lacks prior recovery gate')
            target = g.get('schema_change_id')
            require(target and any(milestones[n].get('schema_change_id') == target and milestones[n]['scope'] == 'target_schema_recovery' for n in closure(gid)), 'schema recovery target mismatch')
        if g['phase'] == 'host_qualified' and gid != 'V03.host_measurement':
            require({'R05.qualifier_protocol','V03.host_measurement'} <= closure(gid), 'host qualification lacks independent measurement')
        if g['scope'] == 'target_schema_recovery':
            require(any(milestones[n]['phase'] == 'contract' and milestones[n].get('schema_change_id') == g['schema_change_id'] for n in closure(gid)), 'recovery lacks target schema specification')
            require('DEBT02.recovery_contract' in closure(gid), 'recovery lacks legacy hold operator contract')
        if g['phase'] == 'contract':
            require(not any(milestones[n]['phase'] in {'host_qualified','default_enabled'} for n in closure(gid)), 'contract blocked on host qualification')
    requirements = gates['release_requirements']
    require(set(requirements['S2_opt_in']) <= set(requirements['S2_default_enable']), 'default gate omits opt-in requirement')
    require(set(gates['default_enable_rule']['slice_faults']) == {f'S{i}' for i in range(1,7)}, 'slice fault matrix missing')
    for slice_id, gid in gates['default_enable_rule']['slice_faults'].items():
        require(gid in milestones and milestones[gid]['scope'].startswith(slice_id+':'), 'fault receipt reused across slices')
    require({'C06.start_resolver','X01.plan_invalidation','E01.recoverable_profile'} <= closure('E02.local_dispatch'), 'dispatch lacks resolver or identity gate')
    digest_contract = contracts['dispatch_digest']
    require(set(scenarios['AT-08']['mutated_fields']) == set(digest_contract['bound_fields']) and len(digest_contract['bound_fields']) == 15, 'effect digest mutation coverage')
    require(set(scenarios['AT-08']['canonicalization_cases']) == set(digest_contract['canonicalization_rejections']), 'canonicalization coverage')
    require({x['name'] for x in contracts['external_dependencies']} == {'tasks-axi','quota-axi'}, 'external dependency coverage')
    for dep in contracts['external_dependencies']:
        require(dep['status'] == 'not_qualified' and dep['version'] == 'unresolved', 'unverified external qualification')
        require(set(dep['required_before']) == {'E05','X07'}, 'external dependency gate missing')
    require('R03' in items['E05']['depends_on_add'] and 'R03' in items['X07']['depends_on_add'], 'external extraction prerequisite missing')
    require('R03.external_contracts' in requirements['S3_opt_in'] and 'R03.external_contracts' in requirements['S5_public_opt_in'], 'external contract milestone missing')
    for wid, refs in mapping['supplemental_work_source_refs'].items():
        require(wid in items and set(strings(refs, 'work source refs')) <= set(sources), 'unbound supplemental source')
    for requirement in gates['release_requirements'].values():
        require(set(strings(requirement,'release gate')) <= set(milestones), 'unknown release prerequisite')
    evidence = read(confined('current-evidence.json'))
    require(evidence['scope_profile'] == 'adopt_session' and evidence['runtime_qualification'] is False, 'unsupported qualification claim')
    require(evidence['code_candidate'] == work['baseline']['osstack'] and evidence['ci_observation']['headSha'] == evidence['code_candidate'] and evidence['ci_observation']['conclusion'] == 'success', 'CI candidate mismatch')
    summary = evidence['ci_test_summary']
    require(summary['package_suites'] == len(summary['summary_lines']), 'CI suite count mismatch')
    computed = {key: sum(int(n) for line in summary['summary_lines'] for n in re.findall(r'(\d+) '+key, line)) for key in ['passed','skipped','failed']}
    require(computed == summary['counts'] and computed['failed'] == 0, 'CI test count mismatch')
    historical_paths = [r['path'] for r in evidence['historical_evidence']]
    for ref in evidence['historical_evidence']:
        require(ref['historical'] is True and sha(confined(ref['path']).read_bytes()) == ref['sha256'], 'historical evidence changed')
    for wid in evidence['local_scoped_items']:
        require(items[wid]['current_state'] == 'local_pilot_complete' and items[wid]['current_evidence'] == 'current-evidence.json', 'evidence/status mismatch')
        require(items[wid]['evidence_refs'] == historical_paths, 'completion evidence substituted')
    require(set(evidence['local_scoped_items']) == {k for k,v in items.items() if v['current_state']=='local_pilot_complete'}, 'completed work lacks scoped evidence')
    equivalence = evidence['equivalence']
    require(digest_value(equivalence['from'],40) and equivalence['to'] == evidence['code_candidate'], 'invalid equivalence candidates')
    require(equivalence['paths'] == ['.'] and equivalence['exclusions'] == ['docs/','README.md','README.zh.md'] and equivalence['changed_paths'] == [], 'runtime equivalence not established')
    def code_paths(output):
        return [x for x in output.decode().splitlines() if not x.startswith('docs/') and x not in {'README.md','README.zh.md'}]
    changed = subprocess.check_output(['git','diff','--name-only',equivalence['from'],equivalence['to'],'--',*equivalence['paths']],cwd=args.osstack_repo)
    require(not code_paths(changed), 'historical runtime code differs')
    changed = subprocess.check_output(['git','diff','--name-only',evidence['code_candidate'],'--',*equivalence['paths']],cwd=args.osstack_repo)
    require(not code_paths(changed), 'current tracked runtime differs from observed baseline')
    untracked = subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=args.osstack_repo)
    require(not code_paths(untracked), 'untracked production files invalidate equivalence')
    for code in evidence['code_files']:
        p = (args.osstack_repo / code['path']).resolve()
        require(p.is_relative_to(args.osstack_repo.resolve()) and p.is_file() and sha(p.read_bytes()) == code['sha256'], 'current code evidence changed')
    snapshot = read(confined('review-snapshot.json'))
    expected_files = {'work-packages.json','capability-map.json','source-additions.json','current-evidence.json','delivery-gates.json','audit-contracts.json','README.md','audit-revision.md','board-projection.json'}
    require(set(snapshot['file_sha256']) == expected_files, 'snapshot coverage changed')
    for path,digest in snapshot['file_sha256'].items():
        require(digest_value(digest) and sha(confined(path).read_bytes()) == digest, 'stale review snapshot: '+path)
    require(snapshot['states'] == {k:v['current_state'] for k,v in items.items()}, 'status snapshot mismatch')
    board = read(confined('board-projection.json'))
    require(board['work_manifest_sha256'] == sha(confined('work-packages.json').read_bytes()), 'stale board projection')
    require(set(board['cards']) == set(items), 'board projection coverage')
    require(len({c['card_id'] for c in board['cards'].values()}) == len(items), 'duplicate board card')
    for wid,c in board['cards'].items():
        require(c['status'] == work['state_to_board'][items[wid]['current_state']], 'board status differs')
    require(sha(confined('board-receipt.md').read_bytes()) == board['historical_receipt_sha256'], 'historical board receipt changed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-sources', action='store_true')
    parser.add_argument('--osstack-repo', type=Path, default=ROOT)
    parser.add_argument('--firstmate-repo', type=Path)
    args = parser.parse_args()
    work = read(HERE / 'work-packages.json')
    mapping = read(HERE / 'capability-map.json')
    additions = read(HERE / 'source-additions.json')
    plan_path = confined(work['base_plan'])
    registry_path = confined(mapping['base_registry'])
    require(sha(plan_path.read_bytes()) == work['base_plan_sha256'], 'frozen plan changed')
    require(sha(registry_path.read_bytes()) == mapping['base_registry_sha256'], 'frozen registry changed')
    original = index(read(plan_path)['work_items'])
    original_caps = index(read(registry_path)['capabilities'])
    items = index(work['items'])
    caps = index(mapping['capabilities'])
    new_ids = {f'X{i:02}' for i in range(1, 9)} | {'M01', 'M02', 'DEBT01', 'DEBT02', 'DEBT03'}
    require(len(original) == 37 and set(items) == set(original) | new_ids, 'work item coverage changed')
    require(set(caps) == set(original_caps) == {f'FM-{i:02}' for i in range(1, 25)}, '24 capability IDs required')
    require(work['kind'] == 'design_roadmap_not_runtime_authority' and work['runtime_enabled'] is False, 'design must not activate runtime')
    completed = set(read(confined('current-evidence.json'))['local_scoped_items'])
    deps = {}
    counts = {}
    for wid, item in items.items():
        if wid in original:
            require(item['inherits'] == wid, f'{wid}: wrong inheritance')
        else:
            require(item['title'] and item['proposed_targets'], f'{wid}: missing new task contract')
        require(item['slice'] in {'pilot', *[f'S{i}' for i in range(7)]}, f'{wid}: unknown slice')
        require(item['acceptance_add'] and item['verification'], f'{wid}: empty acceptance')
        state = item['current_state']
        require(state in work['state_to_board'], f'{wid}: unknown status')
        counts[state] = counts.get(state, 0) + 1
        require((state == 'local_pilot_complete') == (wid in completed), f'{wid}: unsupported completion claim')
        if wid in completed:
            require(item['scope_profile'] == 'adopt_session' and item['evidence_refs'], f'{wid}: unscoped completion')
        if state == 'partial_blocked':
            require(item.get('blocker'), f'{wid}: missing blocker')
        for ref in item.get('evidence_refs', []):
            require(confined(ref).is_file(), f'{wid}: evidence reference missing')
        deps[wid] = original.get(wid, {}).get('depends_on', []) + item['depends_on_add']
        require(set(deps[wid]) <= set(items), f'{wid}: unknown dependency')
    visited = set()

    def visit(wid, active):
        require(wid not in active, f'cycle: {active + [wid]}')
        if wid not in visited:
            for dep in deps[wid]:
                visit(dep, active + [wid])
            visited.add(wid)
    for wid in items:
        visit(wid, [])

    all_sources = []
    for manifest in mapping['source_manifests']:
        all_sources.extend(read(confined(manifest))['sources'])
    sources = index(all_sources)
    covered = set(mapping['cross_cutting_work'])
    for cid, cap in caps.items():
        require(cap['runtime_enabled'] is False and cap['qualification'] == 'not_end_to_end_qualified', f'{cid}: false activation')
        require(cap['upstream_refs'] == original_caps[cid]['upstream_refs'], f'{cid}: lost provenance')
        refs = cap['upstream_refs'] + cap['additional_source_refs'] + cap['current_code_refs']
        require(set(refs) <= set(sources), f'{cid}: unknown source')
        require(cap['current_code_refs'] and cap['required_work_items'], f'{cid}: missing mapping')
        for ref in cap['current_code_refs']:
            require(sources[ref]['repository'] == 'osstack' and sources[ref]['commit'] == work['baseline']['osstack'], f'{cid}: current code not pinned')
        require(cap['journeys'] and set(cap['journeys']) <= {f'J{i:02}' for i in range(1, 8)}, f'{cid}: unknown journey')
        require(cap['trigger'] and cap['observable_result'] and cap['negative_cases'], f'{cid}: missing behavior')
        covered.update(cap['required_work_items'])
    require(covered == set(items), 'work package is orphaned or unknown')
    require(additions['license']['spdx'] == 'MIT' and additions['license']['source_ref'] in sources, 'missing license provenance')
    audit_checks(work, mapping, additions, items, sources, args)
    if args.verify_sources:
        require(args.firstmate_repo is not None, '--verify-sources requires --firstmate-repo')
        repos = {'osstack': args.osstack_repo, 'firstmate': args.firstmate_repo}
        for sid, source in sources.items():
            data = subprocess.check_output(['git', 'show', f"{source['commit']}:{source['path']}"], cwd=repos[source['repository']])
            require(sha(data) == source['sha256'], f'{sid}: source hash mismatch')
    print(json.dumps({'result': 'SOURCE_IDENTITIES_VERIFIED' if args.verify_sources else 'STRUCTURE_PASS_SOURCES_UNVERIFIED', 'work_packages': len(items), 'capabilities': len(caps), 'source_anchors': len(sources), 'source_hashes_verified': args.verify_sources, 'states': counts, 'runtime_qualification': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
