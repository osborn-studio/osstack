#!/usr/bin/env python3
"""Offline checkpoint consistency only; does not observe live CI or qualify a runtime."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate(ledger):
    plan = json.loads((ROOT / 'work-packages.json').read_text())['items']
    nodes = ledger['milestones']
    require(len(nodes) == len(plan) == 32, 'milestone count')
    require({x['id'] for x in nodes} == {x['id'] for x in plan}, 'milestone identity')
    require(ledger['runtime_enabled'] is False, 'checkpoint does not qualify runtime')
    require(ledger['owner_thread'] == '01a178ed-616a-7bb1-8d20-13f4c1019245', 'unexpected owner: explicit handoff required')
    require(ledger['handoff']['state'] == 'accepted', 'handoff not accepted')
    require(len({x['card_id'] for x in nodes}) == 32, 'duplicate board card')
    prs = {p['number']: p for p in ledger['prs']}
    require(len(prs) == len(ledger['prs']), 'duplicate PR')
    for node in nodes:
        frozen = next(x for x in plan if x['id'] == node['id'])
        for key in ['depends_on', 'merge_after']:
            require(node[key] == frozen[key], f"{node['id']}: dependency changed")
        require(node['state'] in ['planned','in_progress','candidate_pr_open','blocked','done'], 'unknown state')
        for part in node['slices']:
            if 'base_pr' in part:
                require(part['base_sha'] == prs[part['base_pr']]['headRefOid'], 'candidate base drift: revalidate')
            if 'pr' in part:
                require(part['pr'] in prs, 'unknown PR')
        if node['state'] == 'done':
            require(node['acceptance'] == 'passed' and node.get('acceptance_evidence'), 'done without acceptance')
            require(node['slices'] and all('pr' in s and prs[s['pr']]['state'] == 'MERGED' for s in node['slices']), 'done before merge')
            require(node.get('merged_candidate_ci_evidence'), 'done without merged-candidate verification')
    require((ROOT / ledger['handoff']['report']).is_file(), 'handoff record missing')
    require((ROOT / ledger['management']['snapshot']).is_file(), 'board checkpoint missing')
    import hashlib
    require(hashlib.sha256((ROOT / ledger['handoff']['report']).read_bytes()).hexdigest() == ledger['handoff']['report_sha256'], 'handoff record changed')
    return {'status':'checkpoint_consistent','milestones':len(nodes),'prs':len(prs),'runtime_qualification':False,'live_forge_checked':False}

if __name__ == '__main__':
    print(json.dumps(validate(json.loads((ROOT / 'execution-ledger.json').read_text())), indent=2))
