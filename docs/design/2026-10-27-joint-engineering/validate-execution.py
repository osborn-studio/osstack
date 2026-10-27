#!/usr/bin/env python3
"""Offline checkpoint consistency only; does not observe live CI or qualify a runtime.

V2 hashes bind local evidence bytes. code_head_proof validates an owner's recorded
Git-diff observation structurally; it does not authenticate Git history, CI results,
or whether the supplied patch is the authentic/complete Git diff. V2 does compare
patch headers with declared paths and rejects unsupported patch header forms. Root checkpoints without
v2 remain readable as frozen legacy history, not as new publication evidence.
"""
import hashlib
import json
import re
import shlex
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate(ledger):
    root_v2 = ledger.get('checkpoint_proof_version') == 2
    require('checkpoint_proof_version' not in ledger or root_v2, 'unsupported checkpoint proof version')
    def evidence(path):
        require(isinstance(path, str) and bool(path), 'evidence path missing')
        target = (ROOT / path).resolve()
        require(target.is_relative_to((ROOT / 'evidence').resolve()), 'evidence path escapes checkpoint')
        require(target.is_file(), 'evidence file missing')
        return target
    def sha(value, length):
        return isinstance(value, str) and bool(re.fullmatch(f'[a-f0-9]{{{length}}}', value))
    def hashed_evidence(path, digest):
        target = evidence(path)
        require(sha(digest, 64), 'invalid evidence SHA256')
        require(hashlib.sha256(target.read_bytes()).hexdigest() == digest, 'evidence hash differs')
        return target
    def diff_paths(data):
        # Parse the canonical --no-renames Git header subset used by this project.
        # Patch bodies may contain arbitrary UTF-8; only unprefixed metadata is read.
        if not data: return []
        try: lines = data.decode('utf-8').splitlines()
        except UnicodeDecodeError as error: raise ValueError('unsupported diff encoding') from error
        require(lines and lines[0].startswith('diff --git '), 'malformed diff header')
        paths = []
        for line in lines:
            if line.startswith(('rename from ', 'rename to ', 'copy from ', 'copy to ')):
                raise ValueError('diff must use no-renames headers')
            if not line.startswith('diff '): continue
            require(line.startswith('diff --git ') and line.isascii() and '\\' not in line,
                    'unsupported diff header')
            try: words = shlex.split(line)
            except ValueError as error: raise ValueError('malformed diff header') from error
            require(len(words) == 4 and words[:2] == ['diff', '--git'], 'malformed diff header')
            left, right = words[2:]
            require(left.startswith('a/') and right.startswith('b/') and left[2:] == right[2:], 'diff must use same-path no-renames headers')
            path = left[2:]
            require(path and all(32 <= ord(char) < 127 for char in path)
                    and not any(piece in ('', '.', '..') for piece in path.split('/')), 'unsupported diff path')
            require(path not in paths, 'duplicate diff header path')
            paths.append(path)
        return paths
    def claims_current(part):
        return (part.get('evidence_status') == 'current_for_code_sha'
                or part.get('audit', {}).get('status') == 'current_for_code_sha'
                or part.get('validation', {}).get('status') in ['current_for_code_sha', 'passed_for_code_sha'])
    def current_evidence(part):
        if root_v2: require(part.get('proof_version') == 2, 'current evidence requires proof_version 2')
        require(sha(part.get('code_sha'), 40), 'invalid ready code SHA')
        validation = part.get('validation', {})
        require(validation.get('code_sha') == part['code_sha'], 'validation code differs')
        require(bool(validation.get('audit_binding')), 'ready audit binding missing')
        binding_path = evidence(validation['audit_binding'])
        if part.get('proof_version') == 2:
            hashed_evidence(validation.get('report'), validation.get('report_sha256'))
            hashed_evidence(validation['audit_binding'], validation.get('audit_binding_sha256'))
            if root_v2 and 'archive_manifest' in validation:
                hashed_evidence(validation['archive_manifest'], validation.get('archive_manifest_sha256'))
        binding = json.loads(binding_path.read_text())
        require(binding.get('code_sha', binding.get('code_commit')) == part['code_sha'], 'audit code differs')
        require(binding.get('verdict') == 'PASS', 'audit binding did not pass')
        if part.get('proof_version') == 2:
            require(sha(part.get('base_sha'), 40), 'invalid reviewed base SHA')
            require(binding.get('reviewed_base') == part['base_sha'], 'audit reviewed base differs')
            proof = part.get('code_head_proof')
            require(isinstance(proof, dict), 'code/head proof missing')
            require(sha(part.get('head_sha'), 40), 'invalid observed head SHA')
            require(proof.get('code_sha') == part['code_sha'] and proof.get('head_sha') == part['head_sha'], 'code/head proof identity differs')
            require(sha(proof.get('diff_sha256'), 64), 'invalid code/head diff SHA256')
            if root_v2:
                diff_file = hashed_evidence(proof.get('diff_path'), proof['diff_sha256'])
            paths = proof.get('changed_paths')
            require(isinstance(paths, list), 'code/head changed paths missing')
            require(all(isinstance(path, str) and path.startswith(('docs/', '.changeset/'))
                        and not any(piece in ('', '.', '..') for piece in path.split('/'))
                        and '\\' not in path for path in paths), 'code/head path outside metadata scope')
            require(len(paths) == len(set(paths)), 'duplicate code/head changed path')
            require('net_diff_empty' not in proof or isinstance(proof['net_diff_empty'], bool), 'invalid net diff empty flag')
            if proof.get('net_diff_empty') is True:
                require(not paths and proof['diff_sha256'] == hashlib.sha256(b'').hexdigest(), 'net empty diff proof differs')
            else:
                require(bool(paths) == (part['code_sha'] != part['head_sha']), 'code/head path emptiness differs')
            if root_v2:
                require(set(diff_paths(diff_file.read_bytes())) == set(paths), 'diff headers differ from declared paths')
    require(datetime.fromisoformat(ledger['observed_at']).tzinfo is not None, 'checkpoint observation timezone missing')
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
    def ready(part, pr):
        if root_v2: require(part.get('proof_version') == 2, 'new checkpoint ready slice requires proof_version 2')
        require(pr['state'] == 'OPEN', 'ready PR not open')
        require(not pr['isDraft'], 'ready PR is still draft')
        require(part.get('evidence_status') == 'current_for_code_sha', 'ready evidence is not current')
        require(part.get('audit',{}).get('status') == 'current_for_code_sha', 'ready audit is not current')
        current_evidence(part)
        require(part['validation'].get('failed') == 0 and part['validation'].get('passed',0) > 0, 'ready test counts did not pass')
        require(('base_pr' in part) != (part.get('base_branch') == 'main'), 'ready base must be exactly stacked or main')
        if part.get('base_branch') == 'main': require(part.get('base_sha') == ledger['main_sha'], 'ready main base missing or stale')
        require(part.get('audit',{}).get('verdict') == 'PASS', 'ready without audit pass')
        require(part.get('validation',{}).get('status') == 'passed_for_code_sha', 'ready without candidate validation')

    for node in nodes:
        frozen = next(x for x in plan if x['id'] == node['id'])
        for key in ['depends_on', 'merge_after']:
            require(node[key] == frozen[key], f"{node['id']}: dependency changed")
        require(node['state'] in ['planned','in_progress','candidate_pr_open','blocked','done'], 'unknown state')
        for part in node['slices']:
            require(part['state'] in ['open','merged','revalidating','blocked','candidate_pr_open','ready'], 'unknown slice state')
            if part['state'] == 'ready': require('pr' in part, 'ready without PR')
            if 'pr' in part:
                require(part['pr'] in prs, 'unknown PR')
                pr = prs[part['pr']]
                if root_v2 and pr['state'] == 'MERGED': require(part['state'] == 'merged', 'observed merged PR requires merged slice')
                for key in ['candidate_sha', 'head_sha']:
                    if key in part: require(part[key] == pr['headRefOid'], 'slice head differs from observed PR')
                if 'base_branch' in part: require(part['base_branch'] == pr['baseRefName'], 'slice base differs from observed PR')
                if part['state'] == 'merged': require(pr['state'] == 'MERGED' and pr.get('mergeCommit'), 'merged slice without merged PR')
                if root_v2 and part['state'] == 'merged':
                    require(sha(part.get('merge_sha'), 40) and part['merge_sha'] == pr['mergeCommit'].get('oid'), 'milestone merge SHA differs')
                if part['state'] == 'revalidating': require(pr['isDraft'], 'revalidating PR must remain draft')
                if part['state'] == 'ready':
                    ready(part, pr)
                if part['state'] != 'merged' and part.get('base_branch') == 'main' and 'base_sha' in part:
                    require(part['base_sha'] == ledger['main_sha'], 'main candidate base drift: revalidate')
            if root_v2 and part['state'] != 'ready' and claims_current(part): current_evidence(part)
            if 'retarget_history' in part:
                require(bool(part['retarget_history']), 'empty retarget history')
                for history in part['retarget_history']:
                    require(history.get('status') == 'historical' and history.get('base_pr') in prs and bool(re.fullmatch('[a-f0-9]{40}',history.get('base_sha',''))), 'invalid retarget history')
                    prior=[h for n in nodes for x in n['slices'] if x.get('pr') == history['base_pr'] for h in x.get('candidate_history',[])]
                    require(any(h.get('sha') == history['base_sha'] and h.get('evidence_url') for h in prior), 'retarget predecessor evidence missing')
            if 'base_pr' in part:
                require(part['base_pr'] in prs, 'unknown base PR')
                require(bool(re.fullmatch('[a-f0-9]{40}',part['base_sha'])), 'invalid pinned base SHA')
                if prs[part['base_pr']]['state'] != 'OPEN': require(part['state'] == 'blocked', 'closed predecessor requires blocked retarget')
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
                    require(any(h.get('sha') == part['base_sha'] and h.get('evidence_url') and h.get('status') == 'historical' for h in history), 'superseded predecessor evidence missing')
                else:
                    require(part['base_sha'] == observed_base, 'candidate base drift: revalidate')
            for key in ['report','audit_binding']:
                if key in part.get('validation',{}): evidence(part['validation'][key])
        if node['state'] == 'done':
            require(node['acceptance'] == 'passed' and node.get('acceptance_evidence'), 'done without acceptance')
            require(node['slices'] and all('pr' in s and prs[s['pr']]['state'] == 'MERGED' for s in node['slices']), 'done before merge')
            require(node.get('merged_candidate_ci_evidence'), 'done without merged-candidate verification')
            for key in ['acceptance_evidence', 'merged_candidate_ci_evidence']:
                hashed_evidence(node[key], node.get(f'{key}_sha256'))
            if root_v2:
                acceptance_path = evidence(node['acceptance_evidence'])
                ci_path = evidence(node['merged_candidate_ci_evidence'])
                require(acceptance_path != ci_path, 'done acceptance and CI evidence must differ')
                acceptance = json.loads(acceptance_path.read_text())
                ci = json.loads(ci_path.read_text())
                require(isinstance(acceptance, dict) and acceptance.get('node_id') == node['id']
                        and acceptance.get('status') == 'passed', 'done acceptance node/status differs')
                cases = acceptance.get('cases')
                require(isinstance(cases, list) and bool(cases), 'done acceptance cases missing')
                require(all(isinstance(case, dict) and isinstance(case.get('case_id'), str)
                            and bool(case['case_id']) and case.get('status') == 'passed' for case in cases), 'done acceptance case not passed')
                case_ids = {case['case_id'] for case in cases}
                require(len(case_ids) == len(cases) and set(frozen['acceptance_ids']).issubset(case_ids), 'done acceptance case coverage differs')
                require(isinstance(ci, dict) and ci.get('node_id') == node['id']
                        and ci.get('status') == 'passed', 'done CI node/status differs')
                merges = ci.get('merges')
                require(isinstance(merges, list) and bool(merges), 'done CI merges missing')
                require(all(isinstance(merge, dict) and isinstance(merge.get('pr'), int)
                            and merge.get('status') == 'passed' and sha(merge.get('merge_sha'), 40) for merge in merges), 'done CI merge record invalid')
                require(len({merge['pr'] for merge in merges}) == len(merges)
                        and {merge['pr'] for merge in merges} == {part['pr'] for part in node['slices']}, 'done CI PR coverage differs')
                require(all(merge['merge_sha'] == (prs[merge['pr']].get('mergeCommit') or {}).get('oid')
                            for merge in merges), 'done CI merge SHA differs')
    # Firstmate predecessor deliveries are independent slices, not completion of a joint milestone.
    deliveries = ledger['handoff'].get('successor_deliveries', [])
    require(len({part['pr'] for part in deliveries}) == len(deliveries), 'duplicate successor delivery')
    for part in deliveries:
        require(part.get('proof_version') == 2, 'successor proof_version must be 2')
        require(part['pr'] in prs, 'unknown successor PR')
        pr = prs[part['pr']]
        if root_v2 and pr['state'] == 'MERGED': require(part['state'] == 'merged', 'observed merged PR requires merged successor')
        require(part['head_sha'] == pr['headRefOid'], 'successor head differs')
        require(part['base_branch'] == pr['baseRefName'], 'successor base differs')
        require(part['state'] in ['ready', 'merged', 'blocked', 'revalidating'], 'unknown successor state')
        require(part['runtime_enabled'] is False, 'successor does not qualify runtime')
        require(part.get('card_id') and part.get('scope'), 'successor scope/card missing')
        if part['state'] == 'ready':
            require(part.get('merge_readiness', {}).get('ci') in ['passed', 'pending', 'failed', 'not_observed',
                    'passed_at_observation', 'pending_or_failed_at_observation'], 'successor CI observation missing or invalid')
            ready(part, pr)
        elif ('validation' in part or 'code_head_proof' in part
              or part.get('evidence_status') == 'current_for_code_sha'
              or part.get('audit', {}).get('status') == 'current_for_code_sha'
              or part.get('validation', {}).get('status') in ['current_for_code_sha', 'passed_for_code_sha']):
            current_evidence(part)
        if part['state'] != 'merged' and part.get('base_branch') == 'main' and 'base_sha' in part:
            require(part['base_sha'] == ledger['main_sha'], 'successor main candidate base drift: revalidate')
        if part['state'] == 'revalidating': require(pr['isDraft'], 'successor revalidation requires draft')
        if part['state'] == 'merged':
            require(pr['state'] == 'MERGED' and pr.get('mergeCommit'), 'successor merge unobserved')
            require(sha(part.get('merge_sha'), 40) and part['merge_sha'] == pr['mergeCommit'].get('oid'), 'successor merge SHA differs')
        for key in ['report', 'audit_binding']:
            if key in part.get('validation', {}): evidence(part['validation'][key])
    if root_v2:
        require(isinstance(ledger.get('checkpoint_history'), list) and bool(ledger['checkpoint_history']), 'new checkpoint history missing')
        management = ledger['management']
        require('snapshot_sha256' in management, 'new checkpoint snapshot hash missing')
        receipts = management.get('receipts')
        required_names = {'subagent-dispatch-receipts.json', 'terminal-preflight-receipt.json',
                          'board-final-receipts.json', 'automation-receipt.json'}
        require(isinstance(receipts, list) and len(receipts) == 4, 'new checkpoint four receipts required')
        require(all(isinstance(record, dict) and isinstance(record.get('path'), str) for record in receipts), 'invalid checkpoint receipt record')
        require({Path(record['path']).name for record in receipts} == required_names, 'checkpoint receipt names differ')
    for record in ledger.get('checkpoint_history', []):
        require(isinstance(record, dict), 'invalid checkpoint evidence record')
        hashed_evidence(record.get('path'), record.get('sha256'))
    for record in ledger['management'].get('receipts', []):
        require(isinstance(record, dict), 'invalid checkpoint evidence record')
        hashed_evidence(record.get('path'), record.get('sha256'))
    if 'snapshot_sha256' in ledger['management']:
        hashed_evidence(ledger['management']['snapshot'], ledger['management']['snapshot_sha256'])
    if 'board_snapshots' in ledger['management']:
        snapshots = ledger['management']['board_snapshots']
        require(isinstance(snapshots, list), 'invalid board snapshots')
        for record in snapshots:
            require(isinstance(record, dict), 'invalid board snapshot record')
            hashed_evidence(record.get('path'), record.get('sha256'))
    if 'rpc_helper' in ledger['management']:
        record = ledger['management']['rpc_helper']
        require(isinstance(record, dict), 'invalid RPC helper record')
        hashed_evidence(record.get('path'), record.get('sha256'))
    handoff_report=evidence(ledger['handoff']['report'])
    evidence(ledger['handoff']['audit_archive'])
    evidence(ledger['management']['snapshot'])
    require(hashlib.sha256(handoff_report.read_bytes()).hexdigest() == ledger['handoff']['report_sha256'], 'handoff record changed')
    return {'status':'checkpoint_consistent','milestones':len(nodes),'prs':len(prs),'runtime_qualification':False,'live_forge_checked':False}

def validate_published(ledger):
    require(ledger.get('checkpoint_proof_version') == 2, 'published checkpoint requires root proof_version 2')
    return validate(ledger)

if __name__ == '__main__':
    print(json.dumps(validate_published(json.loads((ROOT / 'execution-ledger.json').read_text())), indent=2))
