from pathlib import Path,PurePosixPath
import json,hashlib,tarfile,subprocess,datetime
D=Path(__file__).resolve().parent;R=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/method-continuity-control');P=R/'docs/implementation/method-continuity-delivery';E=P/'evidence';sha=lambda b:hashlib.sha256(b).hexdigest()
a=json.loads((E/'archive.json').read_text());members=json.loads((E/'members.json').read_text());blob=(E/'raw-verification.tar.gz').read_bytes()
assert sha(blob)==a['sha256']=='1b9d20a3a70db7f0fd3fd8aafe42b97cac51a71e513e5007d3e730653a5845d5';assert len(blob)==a['bytes']
expect={x['path']:x for x in members};assert len(expect)==len(members)==1151
observed=[];total=0;grades=None
with tarfile.open(E/'raw-verification.tar.gz','r:gz') as t:
 for m in t:
  pp=PurePosixPath(m.name);assert m.isreg() and not pp.is_absolute() and '..'not in pp.parts and '\\'not in m.name and m.name==pp.as_posix();assert m.name in expect;assert m.name not in [x['path']for x in observed]
  b=t.extractfile(m).read();x=expect[m.name];assert len(b)==m.size==x['bytes'];assert sha(b)==x['sha256'];assert m.mode==x['mode'];total+=len(b);observed.append({'path':m.name,'bytes':len(b),'sha256':sha(b),'mode':m.mode})
  if m.name=='independent/host-framing/graded/results.json':grades=json.loads(b);assert b==(Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/method-continuity-20261029')/m.name).read_bytes()
assert len(observed)==a['members']==1151;assert total==a['payload_bytes']==7643942
(D/'observed-members.json').write_text(json.dumps(observed,indent=2)+'\n')
commands=[]
def git(args):
 p=subprocess.run(['/usr/bin/git']+args,cwd=R,capture_output=True);n=len(commands);(D/f'git-{n}.stdout').write_bytes(p.stdout);(D/f'git-{n}.stderr').write_bytes(p.stderr);commands.append({'argv':['/usr/bin/git']+args,'cwd':str(R),'exit_code':p.returncode,'stdout_sha256':sha(p.stdout),'stderr_sha256':sha(p.stderr)});assert p.returncode==0;return p.stdout
base='a9e480d39b9fcff206f356cee75a72cc9cc4d9e4';author='98b6cbad02ba29cb4fa78447b1117c763c2a1866';root='adfb03def56ed183e151977a94642933dceff895'
paths=git(['diff','--name-only',base,author]).decode().splitlines();assert len(paths)==11
binding=[]
for path in paths:
 b=git(['show',author+':'+path]);c=git(['show',root+':'+path]);assert b==c;assert (R/path).read_bytes()==b;binding.append({'path':path,'bytes':len(b),'sha256':sha(b)})
report=(P/'host-report.md').read_text();assert 'both hosts `LIMITED_not_overall_PASS`'in report and 'Both independent overall grades are **LIMITED_not_overall_PASS**'in report
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':'PASS_scoped_archive_integrity_lineage_and_report_claim_check','archive_sha256':sha(blob),'archive_bytes':len(blob),'members':len(observed),'payload_bytes':total,'member_sha256_size_mode':'all_match','path_safety':'unique canonical relative regular files; no links/special files/absolute or parent traversal; archive not extracted','author':author,'root':root,'request_revision_typo':'adfb11 was not resolvable; actual root object confirmed by HEAD and README is adfb03def56ed183e151977a94642933dceff895','all_eleven_author_paths_equal_root_and_current_files':binding,'commands':commands,'host_report_sha256':sha((P/'host-report.md').read_bytes()),'graded_results_sha256':sha((Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/method-continuity-20261029/independent/host-framing/graded/results.json')).read_bytes()),'semantic_check':'Both LIMITED conclusions retained. Codex explicit-cat/native-availability and unresolved-model/final-channel limits retained. Claude wrong same-built-artifacts comparison, narrowed proposal deliverable and local-evidence wording limits retained. Task-framing source a9 remains distinct from new continuity candidate. Inventory equality is parsed maps, not raw bytes. Cleanup claim is scoped historical analysis only.','limits':'Archive integrity is not credential absence proof, runtime qualification, formal principal independence or reexecution of model/tests. No original files changed.'}
(D/'report.json').write_text(json.dumps(out,indent=2)+'\n');(D/'report.md').write_text('# Publication verification\n\nPASS for the requested limited checks: all 1,151 archive members match their exact hash, size and mode; payload is 7,643,942 bytes. Canonical relative regular paths are unique and safe; no extraction performed. Archive SHA is '+sha(blob)+'.\n\nAll eleven author paths at 98b6 match actual root adfb03def56ed183e151977a94642933dceff895 and current checkout bytes. The request abbreviation adfb11 was not an existing object; the actual binding is explicit in report.json.\n\nThe final host report preserves both LIMITED_not_overall_PASS conclusions, source/candidate separation and observed-trace/identity/cleanup limitations. The original independent grade inside the archive matches its frozen source exactly. No model, test or runtime was rerun; no original files were modified.\n')
print(json.dumps({'result':out['result'],'report_sha256':sha((D/'report.json').read_bytes()),'paths':len(paths)}))
