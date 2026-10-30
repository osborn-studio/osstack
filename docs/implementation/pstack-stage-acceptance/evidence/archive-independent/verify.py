from pathlib import Path,PurePosixPath
import json,tarfile,hashlib,datetime,collections,io
P=Path('/Volumes/AIMATE_WORK/Developer/CodeX/.worktrees/osstack/post307-ci-close/docs/implementation/pstack-stage-acceptance/evidence');O=Path(__file__).parent
def h(b):return hashlib.sha256(b).hexdigest()
a=(P/'raw-verification.tar.gz').read_bytes();m=(P/'manifest.json').read_bytes();r=json.loads((P/'receipt.json').read_bytes());assert h(a)==r['archive_sha256']=='6fc0e7a39ad2503f22ea6275aa6e60ed78ec72c5cf6f3a1a3a8b93047ec62642';assert h(m)==r['manifest_sha256'];ex=json.loads(m)['members'];expected={x['path']:x for x in ex};assert len(expected)==len(ex);rows=[];details=[]
with tarfile.open(fileobj=io.BytesIO(a),mode='r:gz') as t:
 members=t.getmembers();names=[x.name.rstrip('/') for x in members];assert len(names)==len(set(names));assert set(names)==set(expected)
 def read(n):return t.extractfile(n).read()
 for member in members:
  name=member.name.rstrip('/');p=PurePosixPath(name);assert not p.is_absolute() and '..' not in p.parts;x=expected[name];typ='file' if member.isfile() else 'directory' if member.isdir() else 'symlink' if member.issym() else 'unsupported';assert typ==x['type'];assert member.mode==x['mode'];v={'path':name,'type':typ,'mode':member.mode}
  if typ=='file':
   b=read(name);assert len(b)==x['bytes']==member.size;assert h(b)==x['sha256'];v.update(bytes=len(b),sha256=h(b))
  elif typ=='symlink':assert member.linkname==x['target'];v['target']=member.linkname
  else:assert typ=='directory'
  rows.append(v)
 counts=collections.Counter(x['type'] for x in rows);total=sum(x.get('bytes',0) for x in rows);assert len(rows)==151 and counts['file']==129 and total==10196188
 full=json.loads(read('final-report-input/original-acceptance.json'));cases=full['cases'];work=full['work_items']['work_items'];assert {x['id'] for x in cases}=={f'A{i:02}' for i in range(1,49)} and len(cases)==48;assert {x['id'] for x in work}=={f'W{i:02}' for i in range(1,20)} and len(work)==19;assert full['new_tests_run'] is False and full['formal_gate_pass'] is False
 upstream=[]
 for x in json.loads(read('upstream/archives.json')):
  b=read('upstream/'+x['archive']);assert h(b)==x['archive_sha256'] and len(b)==x['archive_bytes'];z={'label':x['label'],'commit':x['sha'],'sha256':h(b),'bytes':len(b)}
  with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as nested:
   regular=sum(y.isfile() for y in nested.getmembers());z['regular_files']=regular;assert regular==x['tracked_files']
  upstream.append(z)
 audits=[]
 for label in ['audit','audit-closure']:
  binding=json.loads(read(label+'/binding.json'));inp=read(label+'/audit-input.txt');response=read(label+'/response.json');v=json.loads(response);report=read(label+'/report.md');assert h(inp)==binding['prompt_sha256'];assert h(response)==binding['response_sha256'];assert report==v['result'].encode();assert binding['modelUsage']==v['modelUsage'];assert binding['exit_code']==0 and not binding['is_error'];assert 'claude-sonnet-5-5' in v['modelUsage']
  sourcechecks=[]
  for item in json.loads(read(label+'/input-manifest.json')):
   marker=('\n--- '+('FILE ' if label=='audit' else '')+item['path']+' ---\n').encode();assert inp.count(marker)==1;at=inp.index(marker)+len(marker);payload=inp[at:at+item['bytes']];assert h(payload)==item['sha256'],(label,item['path']);sourcechecks.append({'path':item['path'],'bytes':len(payload),'sha256':h(payload)})
  verdict=report.decode().splitlines()[0];assert 'report' in verdict;audits.append({'label':label,'verdict_line':verdict,'input_sha256':h(inp),'response_sha256':h(response),'report_sha256':h(report),'input_member_bindings':sourcechecks,'modelUsage_keys':list(v['modelUsage'])})
 result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':'all_archive_member_and_requested_binding_checks_match','archive_sha256':h(a),'manifest_sha256':h(m),'archive_bytes':len(a),'members':len(rows),'member_types':dict(counts),'file_bytes':total,'final_report_input':{'cases':48,'work_items':19,'complete_unique_ids':True,'new_tests_run':False,'formal_gate_pass':False},'upstream':upstream,'audits':audits,'scope':'Independent archive bytes/types/modes/hash/size and embedded input binding verification only; no extraction, upstream execution, model/product tests or semantic product acceptance. Sonnet initial PASS_WITH_CORRECTIONS is report accuracy only; closure PASS covers report R1–R7 only.','source_directory_untouched':True}
 (O/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');(O/'members-verified.json').write_text(json.dumps(rows,indent=2)+'\n');(O/'report.md').write_text('# 阶段对账归档独立核验\n\n全部151成员通过：129文件、22目录、无symlink；文件共10,196,188 bytes，逐成员名称/type/mode/hash/size与清单一致。归档SHA `'+h(a)+'`。\n\nfinal-report-input完整包含48个唯一A编号与19个唯一W编号，仍标明无新执行/无gate通过；原/新两份上游tar与archives.json摘要、长度及200/573文件数量一致。两轮Sonnet输入全文、每个嵌入输入成员、原response、result报告及modelUsage均与binding一致。原PASS_WITH_CORRECTIONS与限定R1–R7 PASS均保留，不能解释为产品或用户验收通过。\n\n仅内存读取归档，未解包或运行其中代码；未改冻结目录。\n')
files=[{'path':p.name,'bytes':p.stat().st_size,'sha256':h(p.read_bytes())} for p in sorted(O.iterdir()) if p.is_file() and p.name!='manifest.json'];(O/'manifest.json').write_text(json.dumps({'files':files},indent=2)+'\n');print(json.dumps({'report_sha256':h((O/'report.json').read_bytes()),'manifest_sha256':h((O/'manifest.json').read_bytes()),'audits':[{'label':x['label'],'inputs':len(x['input_member_bindings']),'verdict':x['verdict_line']} for x in audits]}))
