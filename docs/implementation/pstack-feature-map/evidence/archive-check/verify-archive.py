#!/usr/bin/env python3
"""Read-only tar/manifest/original snapshot comparison. Never extract or follow symlinks."""
import os,sys,stat,json,hashlib,tarfile,pathlib,datetime,collections
OUT=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-feature-map-archive-check-20261030')
EVIDENCE=pathlib.Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-feature-map/docs/implementation/pstack-feature-map/evidence')
ARCHIVE=EVIDENCE/'raw-verification.tar.gz'; MANIFEST=EVIDENCE/'raw-manifest.json'
SOURCE=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-feature-map-20261030')
EXPECTED_ARCHIVE='ae8ff3fbaf43af9f40f31f90939f3cb76c76ebc5c59e06b8688589d82f631c2d'
EXPECTED_MANIFEST='024c4ea062da9b635712470cded1d3bf7f3239938e0bc41da1866a9cc373990b'
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b): return hashlib.sha256(b).hexdigest()
def canonical(name):
    p=pathlib.PurePosixPath(name)
    if not name or p.is_absolute() or str(p)!=name or any(x in ('','.','..') for x in p.parts): raise ValueError('noncanonical member '+repr(name))
    return name
def kind(st):
    if stat.S_ISREG(st.st_mode):return 'file'
    if stat.S_ISDIR(st.st_mode):return 'directory'
    if stat.S_ISLNK(st.st_mode):return 'symlink'
    return 'unsupported'
def inventory():
    result={}
    def scan(directory,prefix=''):
        for entry in sorted(os.scandir(directory),key=lambda x:x.name):
            name=canonical(prefix+entry.name);s=entry.stat(follow_symlinks=False);t=kind(s)
            row={'type':t,'mode':stat.S_IMODE(s.st_mode),'raw_size':s.st_size,'mtime_ns':s.st_mtime_ns,'ctime_ns':s.st_ctime_ns,'device':s.st_dev,'inode':s.st_ino}
            if t=='symlink':row['target']=os.readlink(entry.path)
            result[name]=row
            if t=='directory':scan(entry.path,name+'/')
    assert kind(os.lstat(SOURCE))=='directory';scan(SOURCE);return result

def read_original_no_symlinks(name):
    parts=pathlib.PurePosixPath(name).parts
    fd=os.open(SOURCE,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
        file_fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            before=os.fstat(file_fd);assert stat.S_ISREG(before.st_mode)
            h=hashlib.sha256();total=0
            while True:
                b=os.read(file_fd,1024*1024)
                if not b:break
                total+=len(b);h.update(b)
            after=os.fstat(file_fd)
            assert (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
            assert total==after.st_size
            return {'size':total,'sha256':h.hexdigest()}
        finally:os.close(file_fd)
    finally:os.close(fd)

start=now(); failures=[];checks=[];archive_bytes=ARCHIVE.read_bytes();manifest_bytes=MANIFEST.read_bytes()
assert sha(archive_bytes)==EXPECTED_ARCHIVE
assert sha(manifest_bytes)==EXPECTED_MANIFEST
manifest=json.loads(manifest_bytes);assert manifest['source_root']==str(SOURCE);assert manifest['archive_sha256']==EXPECTED_ARCHIVE
manifest_rows=manifest['members'];assert len(manifest_rows)==789
m={}
for row in manifest_rows:
    name=canonical(row['path']);assert name not in m;m[name]=row
source_before=inventory()
with tarfile.open(ARCHIVE,'r:gz') as archive:
    members=archive.getmembers();t={}
    for member in members:
        name=canonical(member.name);assert name not in t;t[name]=member
    inventory_check={'manifest_count':len(m),'tar_count':len(t),'source_count':len(source_before),'tar_only':sorted(t.keys()-m.keys()),'manifest_only_in_tar':sorted(m.keys()-t.keys()),'source_only':sorted(source_before.keys()-m.keys()),'manifest_only_in_source':sorted(m.keys()-source_before.keys())}
    if not (set(m)==set(t)==set(source_before)):failures.append({'inventory':inventory_check})
    for name,row in m.items():
        item={'path':name,'manifest':row,'checks':{},'passed':False}
        try:
            member=t[name];s=source_before[name]
            tk='file' if member.isfile() else 'directory' if member.isdir() else 'symlink' if member.issym() else 'unsupported'
            tarrow={'type':tk,'mode':member.mode,'header_size':member.size}
            original={'type':s['type'],'mode':s['mode'],'raw_size':s['raw_size']}
            c=item['checks'];c['type']=row['type']==tk==s['type'] and tk!='unsupported';c['mode']=row['mode']==member.mode==s['mode']
            if row['type']=='file':
                # extractfile streams only a confirmed regular tar member; no filesystem extraction.
                assert member.isfile() and not member.islnk();stream=archive.extractfile(member);assert stream is not None
                h=hashlib.sha256();n=0
                with stream:
                    while True:
                        b=stream.read(1024*1024)
                        if not b:break
                        h.update(b);n+=len(b)
                tarrow.update({'size':n,'sha256':h.hexdigest()});original.update(read_original_no_symlinks(name))
                c['size']=row['size']==member.size==n==s['raw_size']==original['size'];c['sha256']=row['sha256']==tarrow['sha256']==original['sha256']
            elif row['type']=='symlink':
                tarrow.update({'target':member.linkname,'logical_size':len(os.fsencode(member.linkname))})
                original.update({'target':s['target'],'logical_size':len(os.fsencode(s['target']))})
                c['target']=row['target']==member.linkname==s['target']
                c['size']=row['size']==s['raw_size']==tarrow['logical_size']==original['logical_size']
                c['tar_link_payload_empty']=member.size==0
                c['not_dereferenced']=True
            elif row['type']=='directory':
                # Directory st_size is filesystem metadata, not archived file content.
                tarrow['logical_size']=0;original['logical_size']=0;c['size']=row['size']==member.size==0
            else:raise ValueError('unsupported member type')
            item.update({'tar':tarrow,'original':original});item['passed']=all(c.values())
            if not item['passed']:failures.append({'path':name,'failed_checks':[k for k,v in c.items() if not v]})
        except Exception as e:
            item['error']=type(e).__name__+': '+str(e);failures.append({'path':name,'error':item['error']})
        checks.append(item)
source_after=inventory();stable=source_before==source_after
if not stable:failures.append({'source_metadata_changed':sorted(k for k in source_before.keys()|source_after.keys() if source_before.get(k)!=source_after.get(k))})
archive_after=sha(ARCHIVE.read_bytes());manifest_after=sha(MANIFEST.read_bytes())
if archive_after!=EXPECTED_ARCHIVE or manifest_after!=EXPECTED_MANIFEST:failures.append({'frozen_input_changed':True})
counts=collections.Counter(row['type'] for row in manifest_rows);filebytes=sum(row['size'] for row in manifest_rows if row['type']=='file')
assert counts=={'file':660,'symlink':4,'directory':125};assert filebytes==5239883
member_report={'schema_version':1,'started_at':start,'finished_at':now(),'inventory':inventory_check,'members':checks,'failures':failures}
(OUT/'member-checks.json').write_text(json.dumps(member_report,ensure_ascii=False,indent=2)+'\n')
receipt={'schema_version':1,'status':'passed' if not failures else 'failed','started_at':start,'finished_at':now(),'argv':sys.argv,'cwd':os.getcwd(),'archive':str(ARCHIVE),'manifest':str(MANIFEST),'source_root':str(SOURCE),'archive_sha256':EXPECTED_ARCHIVE,'manifest_sha256':EXPECTED_MANIFEST,'archive_and_manifest_unchanged_after_check':archive_after==EXPECTED_ARCHIVE and manifest_after==EXPECTED_MANIFEST,'source_metadata_unchanged_during_check':stable,'member_count':len(checks),'passed_members':sum(x['passed'] for x in checks),'counts':dict(counts),'file_bytes':filebytes,'symlinks_not_dereferenced':True,'tar_size_convention':'Directories: zero archive content bytes; original directory stat size is filesystem-specific. Symlinks: tar header size zero, manifest/source size checked against byte length of exact link target. Regular file size/hash compared across all three.','inventory':inventory_check,'failures':failures,'script_sha256':sha(pathlib.Path(__file__).read_bytes()),'member_checks_sha256':sha((OUT/'member-checks.json').read_bytes()),'limits':['Snapshot consistency and complete membership, not authenticity of evidence producers or validation of all underlying test claims.','No extraction, product execution, model execution, source modification or symlink target reads.','Original paths may be absolute in preserved symlinks; exact text was compared without accessing destinations.']}
(OUT/'receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
(OUT/'receipt.md').write_text(f'''# Independent raw archive verification

Status: **{receipt['status']}**. All **{len(checks)}** manifest members were checked against the tar stream and original scratch: **{counts['file']} regular files**, **{counts['directory']} directories**, **{counts['symlink']} symlinks**, **{filebytes:,} regular-file bytes**.

Compared exact membership (no duplicates/missing/extras), type, mode, file size/SHA-256 and symlink target/target-byte size. Symlinks were never dereferenced. Tar directory/link payload sizes are zero; original directory stat sizes are filesystem metadata. Symlink sizes in the manifest match original lstat and target-byte length, while tar header sizes remain zero.

Archive SHA-256: `{EXPECTED_ARCHIVE}`
Manifest SHA-256: `{EXPECTED_MANIFEST}`

The archive/manifest hashes remained unchanged after verification; original tree type/mode/size/identity/mtime/ctime/link-target snapshots remained unchanged. Detailed checks are in member-checks.json and the machine receipt is receipt.json; verify-archive.py is retained for reproduction.

This checks byte/member consistency, not producer authenticity or the truth of every underlying test claim. No extraction, product, model, old packet, live test, or shared-file modification was performed. This report lives outside the frozen source tree.
''')
print(json.dumps(receipt,ensure_ascii=False,indent=2))
sys.exit(0 if not failures else 1)
