from pathlib import Path,PurePosixPath
import json,hashlib,os,stat,tarfile,subprocess,datetime
src=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-first-use-20261030');out=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-first-use-archive-check-20261030');wt=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-first-use');ev=wt/'docs/implementation/pstack-first-use/evidence';archive=ev/'raw-verification.tar.gz';mp=ev/'raw-manifest.json';sha=lambda b:hashlib.sha256(b).hexdigest();m=json.loads(mp.read_text());assert sha(archive.read_bytes())=='1b1146ff92916ea675d26c53b56560a032694984f541a984418f3a9a1571c098';assert sha(mp.read_bytes())=='f0ef2d26521a0faa3b4143319d7002ca72298ae68ee5871e893f90364db97191';entries={e['path']:e for e in m['entries']};assert len(entries)==len(m['entries'])==419
verified=[];types={'file':0,'directory':0,'symlink':0};total=0
with tarfile.open(archive,'r:gz') as t:
 members=t.getmembers();assert len(members)==419 and len(set(v.name for v in members))==419 and set(v.name for v in members)==set(entries)
 for member in members:
  n=member.name;p=PurePosixPath(n);assert not p.is_absolute() and '..'not in p.parts and str(p)==n
  e=entries[n];live=src/n
  for parent in live.parents:
   if parent==src:break
   assert not parent.is_symlink()
  st=live.lstat();typ='file'if member.isfile()else'directory'if member.isdir()else'symlink'if member.issym()else'unsupported';assert typ==e['type'];assert member.mode==e['mode']==stat.S_IMODE(st.st_mode)
  if typ=='file':
   assert stat.S_ISREG(st.st_mode);b=t.extractfile(member).read();assert len(b)==member.size==e['size']==st.st_size;assert sha(b)==e['sha256'];assert live.read_bytes()==b;total+=len(b)
  elif typ=='directory':assert stat.S_ISDIR(st.st_mode) and member.size==0
  else:assert stat.S_ISLNK(st.st_mode) and member.linkname==e['target']==os.readlink(live) and member.size==0
  types[typ]+=1;verified.append(n)
assert types=={'file':311,'directory':102,'symlink':6} and total==11968136
# Manifest-listed raw sources and archived bytes are exact above. Additional logical bindings below.
load=lambda p:json.loads((src/p).read_text());candidate=[]
for e in load('candidate-binding/manifest.json'):
 b=(src/'candidate-binding'/e['path']).read_bytes();git=subprocess.check_output(['git','show',e['git_head']+':'+e['path']],cwd=wt);assert b==git and len(b)==e['size']and sha(b)==e['sha256'];candidate.append({'path':e['path'],'git_head':e['git_head'],'sha256':e['sha256']})
prompt=(src/'audit/prompt.txt').read_text();audit=[]
for e in load('audit/input-manifest.json'):
 b=(src/'audit'/e['path']).read_bytes();assert len(b)==e['size']and sha(b)==e['sha256'];assert b.decode()in prompt;audit.append(e)
response=load('audit/response.json');assert response['result'].strip()==(src/'audit/review.md').read_text().strip();assert response['is_error']==False
iv=load('run/invocation-start.json');prompt0=iv['argv'][-1];block=prompt0.split('<OSSTACK_METHOD_REFERENCE_V1>\n',1)[1].split('\n</OSSTACK_METHOD_REFERENCE_V1>',1)[0];data=json.loads(block[block.index('{'):]);assert len(data['materials'])==1;mat=data['materials'][0];mb=mat['text'].encode();assert mb==(src/'prepared-workspace-bundle/builder.md').read_bytes();assert sha(mb)==mat['sha256']and len(mb)==mat['bytes'];receipts=[]
for ref in load('run/context-receipt-refs.json'):
 path=Path(ref['path']);rel=str(path.relative_to(src));assert rel in entries;rc=json.loads(path.read_text());assert rc['prompt_sha256']==sha(prompt0.encode())and rc['prompt_bytes']==len(prompt0.encode());compiled=rc['method_context']['compiled'];cb=(src/'prepared-workspace-bundle/compiled.json').read_bytes();assert sha(cb)==compiled['sha256']and len(cb)==compiled['bytes'];receipts.append({'path':rel,'phase':rc['phase'],'sha256':sha(path.read_bytes()),'prompt_sha256':rc['prompt_sha256']})
freeze=load('freeze.json');assert datetime.datetime.fromisoformat(freeze['utc']).timestamp()<iv['started_unix']<load('run/native-exit.json')['ended_unix'];assert all(sha((src/n).read_bytes())==h for n,h in freeze['files'].items())
assert load('independent/attempt-01/grade.json')['overall']=='blocked_incomplete';assert load('independent-scratch-access/new-run/results.json')['pass']==27;assert load('independent-scratch-access/old-run/results.json')['fail']==18;assert load('independent-full/report.json')['all_tracked_bytes_unchanged']==False
x={'verified_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'verified','archive':str(archive),'archive_sha256':sha(archive.read_bytes()),'manifest_sha256':sha(mp.read_bytes()),'members':len(verified),'types':types,'file_bytes':total,'all_listed_members_match_frozen_originals':True,'symlinks_not_dereferenced':True,'extraction_performed':False,'candidate_git_bindings':candidate,'audit':{'inputs_exact_and_present_in_prompt':audit,'raw_response_matches_review':True,'model_usage_keys':list(response.get('modelUsage',{})),'scope':'Actual tool-less static PASS_WITH_CONCERNS, not native product repair success.'},'native':{'prompt_bytes':len(prompt0.encode()),'prompt_sha256':sha(prompt0.encode()),'material_bytes':len(mb),'material_sha256':sha(mb),'receipts':receipts,'freeze_precedes_invocation':True,'outcome':'blocked_incomplete'},'preserved_results':{'original_P6':'blocked; scratch EPERM before tests, no patch','new_adapter_independent':'27/27 fake-binary tests; not an actual model retry','old_adapter_comparison':'9 pass /18 unsupported new-option failures, not 18 prior promised-contract bugs','root_full':'7448/5/0 at1438;9docs changed during run, product/scripts stable; no allbytesunchanged claim','inventory':'wrong filename MODULE_NOT_FOUND retained, corrected generate-inventory exit0 retained'},'limits':['Checks frozen manifest snapshot, not a new whole-filesystem audit.','Absolute / symlink control retained as link target only; never traversed.','No product/model/full execution; no remote artifacts redownloaded.','No provider wire/model comprehension, universal sandbox or complete descendant cleanup certification.']}
(out/'receipt.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n');(out/'receipt.md').write_text('# 归档独立核验通过\n\n419成员：311文件、102目录、6symlink，11968136文件字节。全部name/type/mode/size/hash及link target与清单、冻结原件一致。未解压、未解引用（包括target `/`控制）。\n\n源码3文件与Git1438对应；原审计3输入逐字在prompt，response与review一致。原模型argv材料32286字节、prompt36134字节与两持久收据相符；原P6仍BLOCKED。新增adapter27/27为fake CLI验证，不是原任务重试成功。\n\n原完整日志、失败、9docs变化的full绑定及wrongfilename inventory错误均保留。\n')
print(json.dumps({'members':len(verified),'types':types,'file_bytes':total,'receipt_sha256':sha((out/'receipt.json').read_bytes())}))
