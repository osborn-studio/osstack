from pathlib import Path,PurePosixPath
import json,tarfile,hashlib,datetime,collections
P=Path('/Volumes/AIMATE_WORK/Developer/CodeX/.worktrees/osstack/post307-ci-close/docs/implementation/pr-stack-candidate/evidence'); O=Path(__file__).parent
def h(b):return hashlib.sha256(b).hexdigest()
archive=P/'raw-verification.tar.gz';mb=(P/'manifest.json').read_bytes();a=archive.read_bytes();expected=json.loads(mb)['members'];receipt=json.loads((P/'receipt.json').read_text());issues=[];results=[]
assert h(a)=='2a26d78cafcedc9befbc7eead73150fc610674fc4caf716bd6286d0099c43fe6'
assert h(mb)=='9427827db90e0105ae5f76d91e9045e1c643705760f4b4e14d8b0932caae467b'
exp={x['path']:x for x in expected};assert len(exp)==len(expected)
with tarfile.open(archive,'r:gz') as t:
 members=t.getmembers(); names=[x.name.rstrip('/') for x in members];assert len(set(names))==len(names);assert set(names)==set(exp)
 for member in members:
  name=member.name.rstrip('/');x=exp[name];p=PurePosixPath(name);assert not p.is_absolute() and '..' not in p.parts
  kind='file' if member.isfile() else 'directory' if member.isdir() else 'symlink' if member.issym() else 'unsupported'
  check={'path':name,'type':kind,'mode':member.mode,'matches':kind==x['type'] and member.mode==x['mode']}
  if kind=='file':
   b=t.extractfile(member).read();check.update(bytes=len(b),sha256=h(b));check['matches'] &= len(b)==x['bytes']==member.size and h(b)==x['sha256']
  elif kind=='symlink':
   check['target']=member.linkname;check['matches'] &= member.linkname==x.get('target',x.get('linkname'))
  elif kind!='directory':check['matches']=False
  if not check['matches']:issues.append(check)
  results.append(check)
assert not issues,issues
counts=collections.Counter(x['type'] for x in results);total=sum(x.get('bytes',0) for x in results);assert len(results)==1124 and counts['file']==936 and counts['symlink']==3 and total==19356574
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':'all_declared_archive_members_match','archive':str(archive),'archive_sha256':h(a),'archive_bytes':len(a),'manifest_sha256':h(mb),'members':len(results),'counts':dict(counts),'file_bytes':total,'symlinks':[x for x in results if x['type']=='symlink'],'limitations':['No extraction or symlink dereference; literal link targets checked only. Historical missing target is not an archive defect.','This is independent archive byte/type/mode/member verification, not re-execution of tests or audit and not authenticity or correctness certification.','No repository, ledger, PR, product or original evidence writes.'],'issues':issues}
(O/'members-verified.json').write_text(json.dumps(results,indent=2)+'\n');(O/'report.json').write_text(json.dumps(r,indent=2)+'\n');(O/'report.md').write_text(f'# 栈前沿归档独立核验\n\n归档 SHA256 `{h(a)}`、清单 `{h(mb)}` 精确匹配。1124 个成员全部核对名称/类型/mode；936 文件逐字节 hash/长度一致，合计 19,356,574 bytes；185 目录与3 symlink目标字面一致。没有解包或解引用，历史工作树目标已删除不影响本次归档核验。\n\n仅核验归档字节，不重跑测试/模型，不认证历史真实性或签发 gate。\n')
f=[{'path':x.name,'sha256':h(x.read_bytes()),'bytes':x.stat().st_size} for x in sorted(O.iterdir()) if x.is_file() and x.name!='manifest.json'];(O/'manifest.json').write_text(json.dumps({'files':f},indent=2)+'\n');print(json.dumps({'counts':dict(counts),'report_sha256':h((O/'report.json').read_bytes()),'manifest_sha256':h((O/'manifest.json').read_bytes())}))
