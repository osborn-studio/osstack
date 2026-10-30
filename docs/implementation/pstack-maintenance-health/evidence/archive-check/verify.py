import pathlib,json,hashlib,stat,tarfile,datetime,os
OUT=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-maintenance-health-archive-check-20261030')
E=pathlib.Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-maintenance-health/docs/implementation/pstack-maintenance-health/evidence')
A=E/'raw-verification.tar.gz';M=E/'raw-manifest.json'
def digest_file(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def digest_stream(f):
 h=hashlib.sha256();size=0
 for b in iter(lambda:f.read(1048576),b''):h.update(b);size+=len(b)
 return h.hexdigest(),size
m=json.loads(M.read_bytes());root=pathlib.Path(m['source_root']);expected='abec101cbe7795973b403041e2c119a40b6e6efef6a451430672a30ee744dbc1';actual=digest_file(A);assert actual==expected==m['archive_sha256'];rows=m['members'];assert len(rows)==4155;by={x['path']:x for x in rows};assert len(by)==len(rows)
checks=[];errors=[];counts={};payload=0
with tarfile.open(A,'r:gz') as tf:
 ts=tf.getmembers();assert len(ts)==len(rows);assert len(set(t.name for t in ts))==len(ts);assert set(t.name for t in ts)==set(by)
 for t in ts:
  r=by[t.name];q=pathlib.PurePosixPath(t.name);assert not q.is_absolute() and all(x not in ('..','.') for x in q.parts)
  p=root/t.name;s=p.lstat();typ='directory' if t.isdir() else 'symlink' if t.issym() else 'file' if t.isfile() else 'unsupported';styp='directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'unsupported';fail=[]
  if not typ==styp==r['type']:fail.append('type')
  if not t.mode==stat.S_IMODE(s.st_mode)==r['mode']:fail.append('mode')
  if t.size!=r['size']:fail.append('tar_size')
  if typ=='file':
   for ancestor in p.relative_to(root).parents:
    if ancestor==pathlib.Path('.'):continue
    assert not (root/ancestor).is_symlink(),str(p)
   with tf.extractfile(t) as f:h,n=digest_stream(f)
   if not h==digest_file(p)==r['sha256']:fail.append('sha256')
   if not n==s.st_size==r['size']:fail.append('file_size')
   payload+=n
  elif typ=='symlink':
   if not t.linkname==os.readlink(p)==r['target']:fail.append('link_target')
  counts[typ]=counts.get(typ,0)+1;checks.append({'path':t.name,'type':typ,'matched':not fail,'errors':fail})
  if fail:errors.append(checks[-1])
 assert payload==m['file_bytes']==86889274
 required=['docs/actual-tool-repair/attempt-01/maintenance.json','docs/actual-tool-repair/attempt-02/maintenance.json','docs/actual-tool-repair/records/repair.json','independent/criteria-v1.json','independent/report-initial.json','independent/remaining-retained-run/01-raw.json','independent/post-inspection/results.json','independent/closure/report.json','independent/final-manifest.json','independent-audit-check/report.json','closure-check/report.json','audit/report.md','audit/response.json','audit-closure/report.md','audit-closure/response.json']
 assert all(x in by for x in required)
 full=[n for n in by if n.startswith('root/') and ('full' in n or 'tracked' in n)]
 assert full
 verdicts={n:tf.extractfile(n).read().decode().splitlines()[0] for n in ['audit/report.md','audit-closure/report.md']}
(OUT/'member-checks.json').write_text(json.dumps(checks,indent=2)+'\n')
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed' if not errors else 'failed','archive':str(A),'archive_sha256':actual,'manifest_sha256':digest_file(M),'members':len(rows),'types':counts,'file_bytes':payload,'errors':errors,'source_root':str(root),'required_evidence_present':required,'root_full_bindings_present':full,'audit_first_lines':verdicts,'scope':['Every listed archive member matched source type/mode/file size+SHA256 or symlink target.','Exact archive/member name set; no extraction or symlink dereference.','Absolute symlink targets preserved as original data, not a portable/extraction-safe runtime claim.','No product/test/model execution; raw contents retained does not recertify every prior claim.']}
(OUT/'report.json').write_text(json.dumps(r,indent=2)+'\n')
(OUT/'report.md').write_text(f"归档逐成员核验通过：{len(rows)} members，{counts}，{payload} 文件字节。tar SHA256 {actual}。\n\n全部清单项与原 scratch 的类型、权限、文件字节/hash、符号链接目标一致；tar 无额外或遗漏路径。未解包、未解引用链接。两次真实 full5 原记录、旧失败、两轮审计及 full 绑定原件均存在。没有重新执行产品或测试，保留不等于重新认证所有历史结论。\n")
fm={'files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':digest_file(p)} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='manifest.json']};(OUT/'manifest.json').write_text(json.dumps(fm,indent=2)+'\n');print(json.dumps({**{k:r[k] for k in ['status','members','types','file_bytes']},'report_sha256':digest_file(OUT/'report.json'),'manifest_sha256':digest_file(OUT/'manifest.json')}))
