"""Validate this review archive, not product acceptance or review correctness."""
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter
from urllib.parse import urlparse, unquote
import gzip
import hashlib
import json
import re
import subprocess

HERE = Path(__file__).resolve().parent
REPORT = HERE.parent.parent
REPO = REPORT.parents[2]
manifest = json.loads((HERE / 'input-manifest.json').read_text())
checks = []


def require(ok, message):
    if not ok:
        raise AssertionError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


for mode, info in manifest['prompts'].items():
    raw = gzip.decompress((HERE / (mode + '-input.txt.gz')).read_bytes())
    require(digest(raw) == info['sha256'] and len(raw) == info['bytes'], mode + ' input changed')
checks.append('exact_submitted_inputs_retained')

for item in manifest['files']:
    if item['path'].startswith('report/'):
        raw = (REPORT / item['path'].removeprefix('report/')).read_bytes()
    else:
        repository = Path(manifest['source_lock']['pstack']['clone']) if item['kind'] == 'pinned_upstream_source' else REPO
        raw = subprocess.check_output(['git', '-C', str(repository), 'show', item['commit'] + ':' + item['path']])
    require(digest(raw) == item['sha256'], 'reviewed input changed: ' + item['path'])
checks.append('all_45_reviewed_file_hashes_unchanged')

for mode in ['audit', 'audit-recovered', 'challenge']:
    run = json.loads((HERE / (mode + '-run.json')).read_text())
    response = json.loads((HERE / (mode + '-response.json')).read_text())
    require(run['exit_code'] == 0 and response['is_error'] is False, mode + ' CLI failed')
    usage = response['modelUsage']
    require(set(usage) == {'claude-fable-5-1'}, mode + ' unexpected model')
    require(usage['claude-fable-5-1']['canonicalModel'] == 'claude-fable-5-1', mode + ' canonical model mismatch')
    require((HERE / (mode + '-raw.md')).read_text() == response['result'] + '\n', mode + ' result modified')
    args = run['argv']
    require(args[args.index('--tools') + 1] == '', mode + ' tool access changed')
    require('--disable-slash-commands' in args and '--strict-mcp-config' in args and '--safe-mode' in args, mode + ' isolation flags missing')
require(json.loads((HERE / 'audit-run.json').read_text())['complete_report'] is False, 'initial partial run must stay marked')
checks.append('three_actual_fable_5_1_calls_and_faithful_raw_outputs')

for mode, prefix, count in [('audit-recovered', 'AU', 12), ('challenge', 'CH', 10)]:
    raw = (HERE / (mode + '-raw.md')).read_text()
    ids = re.findall(r'^\*\*(' + prefix + r'\d{2})\s*[｜|]', raw, re.M)
    require(ids == [prefix + str(i).zfill(2) for i in range(1, count + 1)], mode + ' finding sequence incomplete')
    name = 'audit' if mode == 'audit-recovered' else 'challenge'
    rows = json.loads((HERE / (name + '-dispositions.json')).read_text())['rows']
    require([r['id'] for r in rows] == ids, mode + ' missing disposition')
checks.append('12_audit_and_10_challenge_findings_all_dispositioned')

probe = json.loads((HERE / 'frozen-brief-probe.log').read_text())
require(probe['status'] == 'pass', 'negative probe failed')
require(probe['appended_brief'] == 'delivery_contract_digest_mismatch', 'wrong observed rejection')
require(probe['database_access'] is False and probe['commands_executed'] == [], 'unexpected probe effects')
checks.append('frozen_brief_negative_probe_completed')

before = (HERE / 'workspace-before.txt').read_text().splitlines()
after = subprocess.check_output(['git', '-C', str(REPO), 'status', '--porcelain'], text=True).splitlines()
outside = lambda lines: {line for line in lines if 'docs/reports/2026-10-26-pstack/' not in line and line.strip()}
require(outside(before) == outside(after), 'workspace path status changed outside report; inspect manually')
checks.append('outside_report_workspace_path_status_preserved')

audit = REPORT / 'claude-audit.md'
body = audit.read_text()
require(body.count('```') % 2 == 0, 'unclosed code fence')
for link in re.findall(r'\[[^\]\n]+\]\(([^)\s]+)\)', body):
    parsed = urlparse(link)
    if not parsed.scheme:
        target = (REPORT / unquote(parsed.path)).resolve()
        require(target.is_relative_to(REPORT), 'local link escaped report')
        if target != HERE / 'audit-validation.json':
            require(target.exists(), 'missing link ' + link)
    elif parsed.netloc == 'github.com':
        require('/' + manifest['source_lock']['osstack']['integration_baseline'] + '/' in link, 'unpinned source link')
checks.append('summary_local_links_and_pinned_source_links')

rows = []
for mode in ['audit', 'challenge']:
    rows.extend(json.loads((HERE / (mode + '-dispositions.json')).read_text())['rows'])
result = {
    'generated_at_utc': datetime.now(timezone.utc).isoformat(),
    'status': 'pass',
    'scope': 'audit_archive_integrity_not_product_acceptance_or_semantic_correctness',
    'checks': checks,
    'completed_review_passes': 2,
    'cli_invocations_including_partial_retry': 3,
    'review_opinions_including_duplicate_topics': 22,
    'dispositions': dict(Counter(row['disposition'] for row in rows)),
    'host_additional_findings': 1,
    'reviewed_original_report_files_unchanged': 7,
}
(HERE / 'audit-validation.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
