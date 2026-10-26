#!/usr/bin/env python3
"""Read-only design checks. Never opens a control-plane DB or executes sources."""
import argparse
import hashlib
import json
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-sources', action='store_true')
    parser.add_argument('--osstack-repo', type=Path, default=ROOT)
    parser.add_argument('--firstmate-repo', type=Path)
    args = parser.parse_args()
    work = read(HERE / 'work-packages.json')
    mapping = read(HERE / 'capability-map.json')
    additions = read(HERE / 'source-additions.json')
    plan_path = HERE / work['base_plan']
    registry_path = HERE / mapping['base_registry']
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
    completed = {'C01', 'C02', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06'}
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
            require((HERE / ref).is_file(), f'{wid}: evidence reference missing')
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
        all_sources.extend(read(HERE / manifest)['sources'])
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
    if args.verify_sources:
        require(args.firstmate_repo is not None, '--verify-sources requires --firstmate-repo')
        repos = {'osstack': args.osstack_repo, 'firstmate': args.firstmate_repo}
        for sid, source in sources.items():
            data = subprocess.check_output(['git', 'show', f"{source['commit']}:{source['path']}"], cwd=repos[source['repository']])
            require(sha(data) == source['sha256'], f'{sid}: source hash mismatch')
    print(json.dumps({'result': 'PASS', 'work_packages': len(items), 'capabilities': len(caps), 'source_anchors': len(sources), 'source_hashes_verified': args.verify_sources, 'states': counts, 'runtime_qualification': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
