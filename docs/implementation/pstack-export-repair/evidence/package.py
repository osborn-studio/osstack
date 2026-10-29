from pathlib import Path
import os,stat,hashlib,json,tarfile,datetime
ROOT=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-export-repair-20261029');OUT=ROOT/'archive'
roots=['adapter','host','independent','independent-manifest.json'];members=[];excluded=[];states={}
def digest(b):return hashlib.sha256(b).hexdigest()
def visit(f):
 rel=str(f.relative_to(ROOT));st=f.lstat();states[rel]=(st.st_ino,st.st_mode,st.st_size,st.st_mtime_ns)
 if f.name=='__pycache__' or f.suffix=='.pyc':
  excluded.append({'path':rel,'reason':'Python bytecode cache excluded by requested publication scope','kind':'directory' if stat.S_ISDIR(st.st_mode) else 'file'});return
 rec={'path':rel,'mode':stat.S_IMODE(st.st_mode)}
 if stat.S_ISLNK(st.st_mode):
  target=os.readlink(f);b=os.fsencode(target);rec.update(type='symlink',bytes=len(b),sha256=digest(b),link_target=target,hash_basis='link target bytes; target not read or included by dereference')
 elif stat.S_ISDIR(st.st_mode):rec.update(type='directory',bytes=0,sha256=None)
 elif stat.S_ISREG(st.st_mode):
  b=f.read_bytes();rec.update(type='file',bytes=len(b),sha256=digest(b))
 else:raise RuntimeError('unsupported member type:'+rel)
 members.append(rec)
 if rec['type']=='directory':
  for child in sorted(f.iterdir()):visit(child)
for name in roots:visit(ROOT/name)
assert digest((ROOT/'independent-manifest.json').read_bytes())=='ef8e8f4a29a13fab9420aee81545f22693ad48bb6c08610f115918574b22cfdc'
assert digest((ROOT/'independent/graded/graded-results.json').read_bytes())=='e8a85599aeb1b7849bf44c9aa515b429f3a61cde626e366e93cb367d4da84c49'
# Verify all C evidence before packing; no projection substitutes for member verification.
ind=json.loads((ROOT/'independent-manifest.json').read_text())
for e in ind['files']:
 f=ROOT/'independent'/e['path'];st=f.lstat();assert stat.S_ISREG(st.st_mode);b=f.read_bytes();assert len(b)==e['bytes'] and digest(b)==e['sha256'] and stat.S_IMODE(st.st_mode)==e['mode']
archive=OUT/'raw-execution.tar.gz';assert not archive.exists()
with tarfile.open(archive,'w:gz',dereference=False,format=tarfile.PAX_FORMAT) as tf:
 for m in members:tf.add(ROOT/m['path'],arcname=m['path'],recursive=False)
with tarfile.open(archive,'r:gz') as tf:
 actual=tf.getmembers();assert len(actual)==len(members);assert len({m.name for m in actual})==len(actual)
 for e in members:
  m=tf.getmember(e['path']);assert m.mode==e['mode']
  if e['type']=='file':
   assert m.isfile() and m.size==e['bytes'];b=tf.extractfile(m).read();assert len(b)==e['bytes'] and digest(b)==e['sha256']
  elif e['type']=='symlink':assert m.issym() and m.linkname==e['link_target'] and digest(os.fsencode(m.linkname))==e['sha256']
  else:assert m.isdir()
# Confirm sources and complete recursive inventories did not change during packaging.
for rel,before in states.items():
 f=ROOT/rel;st=f.lstat();assert (st.st_ino,st.st_mode,st.st_size,st.st_mtime_ns)==before,rel
for e in members:
 f=ROOT/e['path']
 if e['type']=='file':assert digest(f.read_bytes())==e['sha256']
 elif e['type']=='directory':
  actual={str(x.relative_to(ROOT)) for x in f.iterdir()};expected={p for p in states if str(Path(p).parent)==e['path']};assert actual==expected,e['path']
counts={kind:sum(m['type']==kind for m in members) for kind in ['file','directory','symlink']}
manifest={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive':archive.name,'archive_sha256':digest(archive.read_bytes()),'archive_bytes':archive.stat().st_size,'member_count':len(members),'member_counts_by_type':counts,'regular_file_bytes':sum(m['bytes'] for m in members if m['type']=='file'),'members':members,'exclusions':excluded,'scope_roots':roots,'not_in_scope':['audit/ (still running at packaging time)','other root coordination files not among requested roots'],'all_members_read_back_verified':True,'source_inventory_and_bytes_unchanged_after_packaging':True,'independent_manifest_sha256':digest((ROOT/'independent-manifest.json').read_bytes()),'independent_files_verified':len(ind['files']),'symlinks_dereferenced':False,'workspace_originals_retained':True,'final_grade':'LIMITED; original grade retained without rewriting'}
(OUT/'raw-execution.manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
summary={k:v for k,v in manifest.items() if k!='members'};summary['manifest_sha256']=digest((OUT/'raw-execution.manifest.json').read_bytes());(OUT/'verification.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
