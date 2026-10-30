import pathlib,json,hashlib,tarfile,stat,os,datetime,difflib
r=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-c0-usage-20261030');e=pathlib.Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-c0-usage/docs/implementation/pstack-c0-usage/evidence');o=r/'archive-check'
h=lambda b:hashlib.sha256(b).hexdigest();J=lambda p:json.loads(p.read_text())
archive=e/'raw-verification.tar.gz';mp=e/'raw-manifest.json';ah=h(archive.read_bytes());mh=h(mp.read_bytes());manifest=J(mp);fail=[];checked=[]
assert ah=='64f9c081d1a370627fb6798918299a40b23f568eb91ee39801c31a847ebe35e7';assert mh=='ae63264d7e4f96575310511c6b86d57ff426c45202e084e342c0a1d0918f5716'
with tarfile.open(archive,'r:gz') as t:
 members=t.getmembers(); names=[x.name for x in members];assert len(set(names))==len(names) and set(names)=={x['path'] for x in manifest}
 for x in manifest:
  n=x['path'];p=pathlib.PurePosixPath(n);assert not p.is_absolute() and '..' not in p.parts
  a=t.getmember(n);s=r/n;st=s.lstat();actualtype='file' if a.isfile() else 'directory' if a.isdir() else 'symlink' if a.issym() else 'unsupported'; sourcetype='file' if stat.S_ISREG(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode) else 'symlink' if stat.S_ISLNK(st.st_mode) else 'unsupported'
  assert actualtype==sourcetype==x['type'];assert a.mode==stat.S_IMODE(st.st_mode)==x['mode']
  result={'path':n,'type':actualtype,'mode':a.mode,'source_match':True}
  if actualtype=='file':
   b=t.extractfile(a).read();sb=s.read_bytes();assert a.size==len(b)==len(sb)==x['size'] and h(b)==h(sb)==x['sha256'];result.update(size=len(b),sha256=h(b))
  elif actualtype=='symlink':
   assert a.linkname==os.readlink(s)==x['target'];result['target']=a.linkname
  checked.append(result)
filecount=sum(x['type']=='file' for x in checked);total=sum(x.get('size',0) for x in checked);assert(len(checked),filecount,total)==(334,310,5010452)
# Frozen independent directory is unchanged. Prior snapshots that root extended are retained under phase1 names.
im=J(r/'independent/manifest.json');assert h((r/'independent/manifest.json').read_bytes())=='31928cb0e033b42cbff78ae76f99a06dd959d54d398cdb318fb354109b897e81';assert all(h((r/'independent'/x['path']).read_bytes())==x['sha256'] for x in im['files'])
relocations=[]
for x in J(r/'independent/input-bindings.json')['files']:
 p=r/x['path']
 if h(p.read_bytes())!=x['sha256']:
  alt=p.with_name(p.stem+'-phase1'+p.suffix);assert alt.is_file() and h(alt.read_bytes())==x['sha256'];assert str(alt.relative_to(r)) in names;relocations.append({'original_path':x['path'],'original_sha256':x['sha256'],'preserved_at':str(alt.relative_to(r)),'current_path_is_later_snapshot':True})
usage=J(r/'root-closure/model-usage.json');audits=[]
for folder in ['audit','audit-closure']:
 u=usage['actual_claude_calls'][folder];assert h((r/folder/'audit-input.txt').read_bytes())==u['prompt_sha256'] and h((r/folder/'response.json').read_bytes())==u['response_sha256']
 report=(r/folder/'report.md').read_text();assert 'PASS_WITH_CONCERNS' in report;audits.append({'folder':folder,'report_sha256':h(report.encode()),'prompt_sha256':u['prompt_sha256'],'response_sha256':u['response_sha256'],'preserved_verdict':'PASS_WITH_CONCERNS','scope':'limited static supplied-text review; not product rerun'})
bind=J(r/'root-closure/journey-tool-binding.json');old=(r/'author/tested-tutorial.md').read_bytes();assert h(old)==bind['tutorial_tested_sha256']=='92700fcf1bb6043edcde92e9cb2bc7975ef4dd092d5af867caf4b1512dd8f902';assert old==(r/'cold/records/00-tutorial.stdout').read_bytes()
final=pathlib.Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-c0-usage/docs/verification/method-control-tutorial.md').read_bytes();assert h(final)==bind['tutorial_final_sha256']
diff=''.join(difflib.unified_diff(old.decode().splitlines(keepends=True),final.decode().splitlines(keepends=True),fromfile='tested-92700fcf',tofile='final-documentation'));assert diff==(r/'root-closure/tutorial-post-run.diff').read_text()
for path,x in bind['current_sources'].items():assert h((r/'root-closure'/pathlib.Path(path).name).read_bytes())==x['sha256']
receipt={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'verified_with_explicit_scope','archive':str(archive),'archive_sha256':ah,'manifest_sha256':mh,'member_count':len(checked),'files':filecount,'directories':len(checked)-filecount,'file_bytes':total,'member_type_mode_size_hash_target_and_current_source_match':True,'safe_member_paths_and_no_duplicates':True,'independent_7files_and_manifest_unchanged':True,'original_snapshot_relocations':relocations,'audits':audits,'tutorial':{'tested_sha256':h(old),'final_sha256':h(final),'stored_diff_exact':True,'post_run_changes':'documentation clarifications only; no third model or product rerun evidenced/claimed'},'limitations':['Archive integrity is not evidence authenticity or a complete tool trace.','CU01 unknown and CU08 limited remain unchanged; no full A39/W17/C0 acceptance.','The two audit verdicts retain concerns; later root clarification is not a third audit PASS.','No product, model, native host or full test was run for this receipt.','Only manifest snapshot members are required; later package-external files are not retrospectively in the archive.']}
(o/'member-checks.json').write_text(json.dumps(checked,ensure_ascii=False,indent=2)+'\n');(o/'receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
(o/'receipt.md').write_text('# C0 归档独立核验\n\n334 成员（310 文件、24 目录；5,010,452 文件字节）逐类型/权限/大小/哈希与源 scratch 同路径一致，无重复或越界路径。原 C 独立 7 文件和 manifest 未变。\n\n两轮 Sonnet 的 PASS_WITH_CONCERNS 原文及 prompt/response hash 留存，未改成无保留通过。测试教程仍为92700fcf，最终教程57226b50；保存的逐行diff与两版本实际字节相符。后续澄清不冒称第三轮模型或产品实跑。\n\nroot把较早 product-stability 快照保存在 phase1 路径，后补停写后快照；原独立输入绑定能在原或phase1归档路径找到相同字节，详细见JSON。CU01 unknown / CU08 limited及原有限结论保持。本次未重跑产品、模型或全仓。\n')
files=[{'path':p.name,'bytes':p.stat().st_size,'sha256':h(p.read_bytes())} for p in sorted(o.iterdir()) if p.is_file() and p.name!='manifest.json'];(o/'manifest.json').write_text(json.dumps({'files':files},indent=2)+'\n');print(json.dumps({'receipt_sha256':h((o/'receipt.json').read_bytes()),'manifest_sha256':h((o/'manifest.json').read_bytes()),'relocations':relocations}))
