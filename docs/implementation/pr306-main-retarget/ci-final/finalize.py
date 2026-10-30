from pathlib import Path
import json,hashlib,datetime
p=Path(__file__).parent
r=json.loads((p/'report.json').read_text()); c=json.loads((p/'synthetic-commit.json').read_text())
assert r['head']=='958eb72295937b96ee8affc32fa87910bbdde512' and r['base']['sha']=='e79fc92687c144969ad91242a979d904f2b2acdf' and r['base']['ref']=='main'
assert c['tree']['sha']=='356296e4949c15e08a65696f6d7d5ced796a2693'
assert [j['conclusion'] for j in r['jobs']].count('success')==5 and [j['conclusion'] for j in r['jobs']].count('skipped')==1
expected=[('healthy',0,'healthy'),('missing-ref',1,'failed'),('drift',2,'drift'),('mixed',1,'failed'),('empty',0,'empty')]
for k,n in [('Method verification journey (two real local cases)',2),('Full method verification journey (five real local cases)',5)]:
 v=r['actual_steps'][k]['json_records'];assert len(v)==1;v=v[0]['value']
 assert v['status']=='passed' and v['model_calls']==0
 assert [(f['case_id'],f['product_exit'],f['product_status'])for f in v['features']]==expected[:n]
 assert all(f['driver_exit']==0 and f['verification']=='passed' and f['cleanup']['fixture_removed'] and f['cleanup']['descendant_termination']=='not_attested' for f in v['features'])
for k in ['Project and check actual method evidence','Project and check full five-case method evidence']:
 v=[x['value'] for x in r['actual_steps'][k]['json_records']];assert [x['status'] for x in v]==['projected','valid']
 assert v[0]['packet_sha256']==v[1]['packet_sha256'] and v[1]['original_evidence_revalidated'] is False
v=r['actual_steps']['Maintain fixed skills map (five real local cases)']['json_records'][0]['value']
assert v['status']=='consistent' and v['exit_code']==0 and v['execution_path']=='runJourney' and v['model_calls']==0 and v['formal_gate_pass'] is False
assert v['map']['unchanged'] and v['map']['before_sha256']==v['map']['after_sha256'] and len(v['rows'])==5 and all(x['matches'] for x in v['rows'])
assert [(f['case_id'],f['product_exit'],f['product_status'])for f in v['journey']['features']]==expected
assert all(f['driver_exit']==0 and f['cleanup']['fixture_removed'] and f['cleanup']['descendant_termination']=='not_attested' for f in v['journey']['features'])
assert v['journey']['receipt_matches_returned'] and v['journey']['status']=='passed'
r['checkout_binding']={'actual_sha':c['sha'],'actual_parents':[x['sha']for x in c['parents']],'actual_tree':c['tree']['sha'],'head_tree_equal':True,'api_base':'e79fc92687c144969ad91242a979d904f2b2acdf','checkout_message_base':'b0ea4e7836dd4be640b4f7c140befba73977837d','base_trees_equal':'31a72ebdb5777ce7d90e54a501bd4ad52083b10e','note':'GitHub run API names current main e79; actual synthetic checkout parent remains b0. Their trees are equal; do not relabel the actual tested commit.'}
r['actual_checks_asserted']=True
(p/'report.json').write_text(json.dumps(r,indent=2)+'\n')
(p/'report.md').write_text('''# PR306 final CI read-only verification

Run **40920378111**, attempt1, completed **success**: five jobs success and the paid DeepSeek job skipped. Expected head `958eb72295937b96ee8affc32fa87910bbdde512`; run API base `main` at `e79fc92687c144969ad91242a979d904f2b2acdf`.

**Actual checkout differs in ancestry from API base label:** CI checked out synthetic merge `057f32d4620d71bec8d26a4fe0f074cc9e921855`, parents `b0ea4e7836dd4be640b4f7c140befba73977837d` and `958eb72295937b96ee8affc32fa87910bbdde512` (log lines3718/3721; Git commit API retained). Its tree `356296e4949c15e08a65696f6d7d5ced796a2693` exactly equals head958e. Base b0 and actual main e79 both have tree `31a72ebdb5777ce7d90e54a501bd4ad52083b10e`. Thus tested source tree matches, but the actual checkout is not relabeled as a synthetic e79 merge.

- Exact check/Test: **22 unique packages, 7142 passed /7 skipped /0 failed**. Matrix and standalone suites excluded from this total.
- Exporter **94 total=93 passed+1 skipped** (global Codex home absent, line8455). Maintenance24, projector88, journey43 and reader14 each all pass without skips/failures.
- Actual default journey product exits0/1; actual full journey0/1/2/1/0. Every driver exit0, each fixture recorded removed; full descendant termination remains not_attested.
- Both actual default/full projection and check steps succeed with matching logged packet hashes. Check explicitly reports original_evidence_revalidated=false. No artifact downloaded or independently rehashed.
- New actual `pnpm smoke:skills-map` ran the production runJourney path: consistent/exit0, all five rows match, real product exits0/1/2/1/0 and driver0. Map before/after SHA both `c1ab436209c3857822b74aebadf914761524f9de645177b20f502cac560e96d8`, unchanged=true; receipt_matches_returned=true. Raw record begins line10346. This CI step verifies the correct map; local deliberately wrong-map RED→corrected-map GREEN remains separate local evidence, not a second CI operation.

Read-only interpretation of saved CI output, not independent test reexecution. Numeric maintenance exit0 is in receipt; other command success is supported by successful bash-e steps and result records. Finite scenario agreement does not establish source-review completeness, runtime qualification, authenticated provenance or model understanding. No PR mutation or rerun/cancel performed.

Original complete log retained as lossless gzip and uncompressed bytes: 2,181,963 bytes, SHA256 `c6d31c0368d571938bc2d8b0aad799fc3f05416c6595326b71da07779172f66f`. ANSI stripping only occurred in parser memory. No parser failure occurred. Full run/jobs/PR JSON and Git ancestry bindings retained; poll snapshots remain in scratch.
''')
selected=['run.json','jobs.json','pr-final.json','pr-final.command.json','pr-final.stderr','synthetic-commit.json','synthetic-commit.command.json','synthetic-commit.stderr','958eb722-git.txt','b0ea4e78-git.txt','e79fc926-git.txt','complete-log.log.gz','complete-log.command.json','complete-log.stderr','report.json','report.md','parse.py','finalize.py']
for name,names in [('final-manifest.json',selected),('manifest.json',[x.name for x in sorted(p.iterdir())if x.is_file() and x.name not in ['manifest.json','final-manifest.json']])]:
 files=[{'path':n,'bytes':(p/n).stat().st_size,'sha256':hashlib.sha256((p/n).read_bytes()).hexdigest()}for n in names]
 (p/name).write_text(json.dumps({'files':files},indent=2)+'\n')
for n in ['report.json','final-manifest.json','manifest.json','complete-log.log.gz']:
 print(n,hashlib.sha256((p/n).read_bytes()).hexdigest())
