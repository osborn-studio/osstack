from pathlib import Path
import tarfile,json,hashlib,os,stat,datetime
OUT=Path(__file__).parent
E=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-adoption-bundle/docs/implementation/pstack-adoption-bundle/evidence')
S=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-adoption-bundle-20261030')
H=lambda b:hashlib.sha256(b).hexdigest()
m=json.loads((E/'raw-manifest.json').read_text());expected={e['path']:e for e in m['members']};errors=[];observations=[]
archivehash=H((E/'raw-verification.tar.gz').read_bytes())
if archivehash!=m['archive_sha256']:errors.append('archive SHA mismatch')
with tarfile.open(E/'raw-verification.tar.gz','r:gz') as t:
 members=t.getmembers();names=[x.name.rstrip('/') for x in members]
 if len(names)!=len(set(names)):errors.append('duplicate tar member')
 if set(names)!=set(expected):errors.append({'archive_vs_manifest':{'extra':sorted(set(names)-set(expected)),'missing':sorted(set(expected)-set(names))}})
 for a in members:
  n=a.name.rstrip('/');e=expected.get(n)
  if not e:continue
  typ='file' if a.isfile() else 'directory' if a.isdir() else 'symlink' if a.issym() else 'unsupported'
  o={'path':n,'type':typ,'mode':a.mode,'size':a.size}
  if typ=='file':o['sha256']=H(t.extractfile(a).read())
  if typ=='symlink':o['target']=a.linkname
  for k in ['type','mode','size','sha256','target']:
   if k in e and o.get(k)!=e[k]:errors.append({'path':n,'axis':'archive','key':k,'actual':o.get(k),'expected':e[k]})
  f=S/n
  try:
   st=f.lstat();s={'type':'symlink' if stat.S_ISLNK(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode) else 'unsupported','mode':stat.S_IMODE(st.st_mode),'size':st.st_size if typ=='file' else 0}
   if s['type']=='file':s['sha256']=H(f.read_bytes())
   if s['type']=='symlink':s['target']=os.readlink(f)
   for k in ['type','mode','size','sha256','target']:
    if k in e and s.get(k)!=e[k]:errors.append({'path':n,'axis':'source','key':k,'actual':s.get(k),'expected':e[k]})
  except OSError as ex:errors.append({'path':n,'source_error':str(ex)})
  observations.append(o)
sourcepaths=[]
for root,dirs,files in os.walk(S,followlinks=False):
 for name in dirs+files:sourcepaths.append(str((Path(root)/name).relative_to(S)))
source_extra=sorted(set(sourcepaths)-set(expected))
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_sha256':archivehash,'manifest_sha256':H((E/'raw-manifest.json').read_bytes()),'member_count':len(observations),'file_count':sum(x['type']=='file' for x in observations),'directory_count':sum(x['type']=='directory' for x in observations),'symlink_count':sum(x['type']=='symlink' for x in observations),'file_bytes':sum(x['size'] for x in observations if x['type']=='file'),'errors':errors,'source_entries_not_in_archive':source_extra,'no_extraction':True}
(OUT/'verification.json').write_text(json.dumps(r,indent=2)+'\n');(OUT/'verified-members.json').write_text(json.dumps(observations,indent=2)+'\n');print(json.dumps(r,indent=2))
