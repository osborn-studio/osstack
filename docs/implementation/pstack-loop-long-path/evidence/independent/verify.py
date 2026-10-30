from pathlib import Path,PurePosixPath
import json,hashlib,tarfile,stat,os,datetime
O=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-loop-long-path-archive-check-20261030')
E=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-permission-preflight/docs/implementation/pstack-loop-long-path/evidence')
roots={k:Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/'+v) for k,v in [('permission','pstack-permission-preflight-20261030'),('task','pstack-loop-long-path-20261030')]}
H=lambda b:hashlib.sha256(b).hexdigest()
M=json.loads((E/'manifest.json').read_text()); AH=H((E/'raw-verification.tar.gz').read_bytes()); MH=H((E/'manifest.json').read_bytes())
assert AH==M['archive_sha256']=='41375939d745385d3cf64831586e5aee266cc60bed02b65c37b11f19afde2e16';assert MH=='eb8d2b541fe6d37c8a74057a9e1c6339c4660cae67040502c0f1b3345e6cae15'
listed={x['path']:x for x in M['members']};assert len(listed)==len(M['members'])==688
count={'file':0,'directory':0,'symlink':0};payload=0;verified=[]
def original(n):
 parts=PurePosixPath(n).parts;assert parts and parts[0] in roots and not PurePosixPath(n).is_absolute() and '..' not in parts
 p=roots[parts[0]]
 for part in parts[1:]:
  assert not p.is_symlink();p=p/part
 return p
with tarfile.open(E/'raw-verification.tar.gz','r:gz') as t:
 mem=t.getmembers();assert len(mem)==688 and len({x.name for x in mem})==688 and set(x.name for x in mem)==set(listed)
 for x in mem:
  q=listed[x.name];p=original(x.name);s=p.lstat();kind='directory' if x.isdir() else 'symlink' if x.issym() else 'file' if x.isfile() else 'unsupported'
  sk='directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'unsupported'
  assert kind==sk==q['type'] and x.mode==q['mode']==stat.S_IMODE(s.st_mode);assert x.size==q['size'];count[kind]+=1
  if kind=='file':
   data=t.extractfile(x).read();assert len(data)==s.st_size==q['size'];assert H(data)==q['sha256']==H(p.read_bytes());payload+=len(data)
  elif kind=='symlink':assert x.linkname==os.readlink(p)==q['target']
  else:assert x.size==0
  verified.append({'path':x.name,'type':kind,'mode':x.mode,'size':x.size,'sha256':q.get('sha256'),'source_equal':True})
 assert count=={'file':460,'directory':228,'symlink':0} and payload==10817650
 # Binding facts read directly from archive, not loose report assertions.
 def b(n):return t.extractfile(n).read()
 def j(n):return json.loads(b(n))
 native=j('task/independent-native/verification.json');final=j('task/independent-final/report.json')
 assert final['full']['totals']=={'passed':7449,'skipped':5,'failed':0};assert final['full']['commit']=='cd30b6ccddbd0e02d5607683a97c36d3ba96db11'
 assert j('task/validation/full-before.json')==j('task/validation/full-after.json')
 prompt=b('task/audit/prompt.txt');source_checks=[]
 for x in j('task/audit/input-manifest.json'):
  leaf=PurePosixPath(x['path']).name;data=b('task/audit/'+leaf);assert H(data)==x['sha256'] and data in prompt
  if leaf!='types.ts':assert data==b('task/independent-native/candidate-source/'+x['path'])==b('task/native-candidate/'+leaf)
  source_checks.append(x)
 assert H(b('task/audit/response.json'))==j('task/audit/dispositions.json')['review_response_sha256']
 response=j('task/audit/response.json');assert 'PASS_WITH_CONCERNS' in response['result'] and 'no confirmed defect' in response['result']
 inv=j('task/run/invocation-start.json');assert H(inv['argv'][-1].encode())==native['actual_argv_prompt']['sha256']
 for ref in j('task/run/context-receipt-refs.json'):
  n='task/'+str(Path(ref['path']).relative_to(roots['task']));assert H(b(n))==ref['digest'];assert j(n)['prompt_sha256']==native['actual_argv_prompt']['sha256']
 # Internal independent manifests remain exactly bound.
 for n in ['task/independent-native/manifest.json','task/independent-final/manifest.json','permission/independent/manifest.json']:
  d=j(n)
  for row in (d if isinstance(d,list) else d.get('files',[])):
   name=str(PurePosixPath(n).parent/row['path']);assert H(b(name))==row['sha256'] and len(b(name))==row['bytes']
excluded=[]
assert len(M['excluded'])==2
for x in M['excluded']:
 assert x['path'] not in listed and x['path'].endswith('.sqlite') and x['reason']=='generated database retained locally, never committed'
 p=original(x['path']);s=p.lstat();assert stat.S_ISREG(s.st_mode);data=p.read_bytes();assert len(data)==x['size'] and H(data)==x['sha256'];assert data[:16]==b'SQLite format 3\x00'
 parent=json.loads((p.parent/'manifest.json').read_text());record=next(r for r in parent['files'] if r['path']==p.name);assert record['sha256']==x['sha256']
 excluded.append({**x,'source_exists_regular':True,'sqlite_header_matches':True,'local_manifest_agrees':True,'archive_absent':True,'database_opened_or_embedded':False})
actual=set()
for prefix,r in roots.items():
 for base,dirs,files in os.walk(r,followlinks=False):
  for name in dirs+files:actual.add(prefix+'/'+str((Path(base)/name).relative_to(r)))
assert actual==set(listed)|{x['path'] for x in excluded}, {'unlisted':sorted(actual-set(listed)-{x['path'] for x in excluded}),'missing':sorted(set(listed)-actual)}
report={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'verified','archive_sha256':AH,'manifest_sha256':MH,'members':len(verified),'counts':count,'file_bytes':payload,'all_archive_members_match_manifest_and_original_type_mode_size_hash_or_target':True,'original_inventory_covered_except_exact_declared_two':True,'excluded':excluded,'bindings':{'full_commit':final['full']['commit'],'full_totals':final['full']['totals'],'tracked_unchanged_count':9172,'initial_dirty_four_dist_preserved':True,'native_audit_source_matches':source_checks,'actual_argv_and_two_receipts_match':True,'audit_verdict':'PASS_WITH_CONCERNS','confirmed_defects_reported':0,'old_node26':'BLOCKED unchanged','permission_results':'PP01 config blocked; PP02 named-profile limited success; NP one adapter diagnostic limited success; distinct from native repair'},'limits':['No extraction or symlink dereference; tar payload read in memory only.','Excluded databases hashed as ordinary read-only byte streams, not opened with SQLite or embedded; generated/local reason agrees with diagnostic placement and original manifest, not a DB-content authentication claim.','Archive integrity does not prove provider wire, principal/authorization authenticity, all filesystem effects or general sandbox boundaries.','Full belongs to cd30b6cc with unchanged recorded 9172 tracked paths; later docs/changeset note not upgraded to whole-tree full.','No model, product test, build, PR or ledger action performed.']}
(O/'receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');(O/'members-verified.json').write_text(json.dumps(verified,indent=2)+'\n');print(json.dumps({'status':'verified','members':len(verified),'counts':count,'file_bytes':payload,'excluded':len(excluded)},indent=2))
