#!/usr/bin/env python3
"""Offline checkpoint consistency only; does not observe live CI or qualify a runtime."""
import json
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate(ledger):
    def evidence(path):
        target = (ROOT / path).resolve()
        require(target.is_relative_to(ROOT), 'evidence path escapes checkpoint')
        require(target.is_file(), 'evidence file missing')
        return target
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
    for pr in prs.values():
        require(bool(pr.get('observed_at')), 'missing PR observation time')
        require(datetime.fromisoformat(pr['observed_at']).tzinfo is not None, 'observation timezone missing')
    for node in nodes:
        frozen = next(x for x in plan if x['id'] == node['id'])
        for key in ['depends_on', 'merge_after']:
            require(node[key] == frozen[key], f"{node['id']}: dependency changed")
        require(node['state'] in ['planned','in_progress','candidate_pr_open','blocked','done'], 'unknown state')
        for part in node['slices']:
            require(part['state'] in ['open','merged','revalidating','blocked','candidate_pr_open','ready'], 'unknown slice state')
            if 'pr' in part:
                require(part['pr'] in prs, 'unknown PR')
                pr = prs[part['pr']]
                for key in ['candidate_sha', 'head_sha']:
                    if key in part: require(part[key] == pr['headRefOid'], 'slice head differs from observed PR')
                if 'base_branch' in part: require(part['base_branch'] == pr['baseRefName'], 'slice base differs from observed PR')
                if part['state'] == 'revalidating': require(pr['isDraft'], 'revalidating PR must remain draft')
                if part['state'] == 'ready': require(not pr['isDraft'], 'ready PR is still draft')
            if 'base_pr' in part:
                require(part['base_pr'] in prs, 'unknown base PR')
                require(bool(re.fullmatch('[a-f0-9]{40}',part['base_sha'])), 'invalid pinned base SHA')
                observed_base = prs[part['base_pr']]['headRefOid']
                if part.get('base_status') == 'stale_requires_revalidation':
                    require(part['base_sha'] != observed_base, 'stale marker without base drift')
                    require(part.get('observed_base_sha') == observed_base, 'stale observation mismatch')
                    require(part['state'] == 'blocked' and node['state'] == 'blocked' and node['board_status'] == 'blocked', 'stale candidate must remain blocked')
                    require(bool(part.get('revalidation_required')), 'stale candidate needs a revalidation action')
                    require(part.get('evidence_status') == 'historical', 'stale evidence must be historical')
                    for key in ['audit','validation']:
                        if key in part: require(part[key].get('status') == 'historical', 'stale result must be historical')
                    history = [h for n in nodes for s in n['slices'] if s.get('pr') == part['base_pr'] for h in s.get('candidate_history',[])]
                    require(any(h['sha'] == part['base_sha'] and h.get('evidence_url') and h.get('status') == 'historical' for h in history), 'superseded predecessor evidence missing')
                else:
                    require(part['base_sha'] == observed_base, 'candidate base drift: revalidate')
            for key in ['report','audit_binding']:
                if key in part.get('validation',{}): evidence(part['validation'][key])
        if node['state'] == 'done':
            require(node['acceptance'] == 'passed' and node.get('acceptance_evidence'), 'done without acceptance')
            require(node['slices'] and all('pr' in s and prs[s['pr']]['state'] == 'MERGED' for s in node['slices']), 'done before merge')
            require(node.get('merged_candidate_ci_evidence'), 'done without merged-candidate verification')
    evidence(ledger['handoff']['report'])
    evidence(ledger['handoff']['audit_archive'])
    evidence(ledger['management']['snapshot'])
    import hashlib
    require(hashlib.sha256((ROOT / ledger['handoff']['report']).read_bytes()).hexdigest() == ledger['handoff']['report_sha256'], 'handoff record changed')
    return {'status':'checkpoint_consistent','milestones':len(nodes),'prs':len(prs),'runtime_qualification':False,'live_forge_checked':False}

if __name__ == '__main__':
    print(json.dumps(validate(json.loads((ROOT / 'execution-ledger.json').read_text())), indent=2))
