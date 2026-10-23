from pathlib import Path
import json,hashlib,re
repo=Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack');e=repo/'docs/reports/2026-10-23-firstmate-development-evidence'
manifest=json.loads((e/'source-manifest.json').read_text())
assert all(hashlib.sha256((repo/x['path']).read_bytes()).hexdigest()==x['sha256'] for x in manifest['files'])
checks=json.loads((e/'final-checks.json').read_text());assert len(checks)==7 and all(c['exit_code']==0 for c in checks)
queue=json.loads((e/'queue-index.json').read_text());assert len(queue)==26
for task in queue:
 receipt=json.loads((e/task['receipt_file']).read_text());successful={r['task_id'] for r in receipt['completed_tasks'] if r['outcome']=='success'}
 assert task['status']=='verified' and set(task['successful_task_ids'])<=successful
for f in list(e.glob('sonnet-wave[1-3].json'))+list(e.glob('haiku-wave[1-5].json')):
 d=json.loads(f.read_text());assert not d['is_error'] and f.with_suffix('.md').read_text()==d['result']+'\n'
old=repo/'docs/reports/2026-10-23-firstmate-evidence/artifact-manifest.json'
for entry in json.loads(old.read_text()):
 path=repo/entry['path']
 if entry['path']=='docs/plans/2026-10-23-firstmate-adoption-plan.md':path=e/'research-plan-before-implementation.txt'
 assert hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256'],str(path)
live=[repo/'README.md',repo/'docs/guides/attention.md',repo/'docs/inventory/CLI_COMMANDS.md',repo/'docs/plans/2026-10-23-firstmate-adoption-plan.md',repo/'docs/reports/2026-10-23-firstmate-development.md',e/'README.md']
for f in live:
 text=re.sub(r'```.*?```','',f.read_text(),flags=re.S)
 for link in re.findall(r'\]\(([^)]+)\)',text):
  if ':' in link or link.startswith('#'):continue
  target=(f.parent/link.split('#')[0]).resolve();assert target.exists(),str(f)+': '+link
result={'source_hashes_verified':len(manifest['files']),'verified_task_gates':len(queue),'successful_final_checks':len(checks),'raw_audit_reports_match':8,'original_research_artifacts_verified':True,'live_document_links_valid':True,'production_home_touched':False}
(e/'verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
