#!/usr/bin/env python3
"""Verify sealed bytes without extraction or executing archived sources.
Use --originals only while the original scratch paths remain accessible.
"""
from pathlib import Path
import argparse, collections, datetime, hashlib, io, json, os, stat, tarfile
parser=argparse.ArgumentParser();parser.add_argument('--originals',action='store_true');args=parser.parse_args()
root=Path(__file__).resolve().parent
manifest=json.loads((root/'raw-manifest.json').read_text());archive=root/manifest['archive'];checks=[]
assert hashlib.sha256(archive.read_bytes()).hexdigest()==manifest['archive_sha256'],'archive digest'
with tarfile.open(archive,'r:gz') as tar:
 members=tar.getmembers();assert len({m.name for m in members})==len(members),'duplicate member'
 assert {m.name for m in members}=={e['path']for e in manifest['members']},'member set'
 for e in manifest['members']:
  m=tar.getmember(e['path']);kind='file' if m.isfile()else 'directory'if m.isdir()else 'symlink'if m.issym()else 'unsupported'
  assert kind==e['type'] and m.mode==e['mode'] and m.size==e['size'],e['path']
  if kind=='file':assert hashlib.sha256(tar.extractfile(m).read()).hexdigest()==e['sha256'],e['path']
  if kind=='symlink':assert m.linkname==e['target'],e['path']
  if args.originals:
   p=Path(e['original_path']);s=p.lstat();actual='symlink'if stat.S_ISLNK(s.st_mode)else 'directory'if stat.S_ISDIR(s.st_mode)else 'file'if stat.S_ISREG(s.st_mode)else 'unsupported'
   assert actual==kind and stat.S_IMODE(s.st_mode)==e['mode'],e['path']
   if kind=='file':assert s.st_size==e['size'] and hashlib.sha256(p.read_bytes()).hexdigest()==e['sha256'],e['path']
   if kind=='symlink':assert os.readlink(p)==e['target'],e['path']
  checks.append({'path':e['path'],'type':kind,'mode':m.mode,'size':m.size,'tar_matches_manifest':True,'original_matches':True if args.originals else None})
 lock_bytes=tar.extractfile('source/source-lock.json').read();lock=json.loads(lock_bytes)
 assert (root.parent/'source-lock.json').read_bytes()==lock_bytes,'published lock differs'
 raw=tar.extractfile('source/pstack-v0.15.36.tar').read();assert hashlib.sha256(raw).hexdigest()==lock['archive_sha256'],'source archive digest'
 with tarfile.open(fileobj=io.BytesIO(raw))as upstream:
  files=[m for m in upstream.getmembers()if m.isfile()];assert len(files)==len(lock['files'])==573
  assert {m.name for m in files}=={x['path']for x in lock['files']},'source file set'
  assert all(m.isfile()or m.isdir()for m in upstream.getmembers()),'source special member'
  source_checks=[]
  for row in lock['files']:
   m=upstream.getmember(row['path']);body=upstream.extractfile(m).read()
   assert m.size==row['bytes'] and hashlib.sha256(body).hexdigest()==row['sha256'],row['path']
   # git archive adds group write permission; compare Git regular/executable mode.
   git_mode='100755'if m.mode&0o111 else '100644';assert git_mode==row['mode'],row['path']
   source_checks.append({'path':row['path'],'tar_mode':m.mode,'git_mode':git_mode,'size':m.size,'sha256':row['sha256'],'matches_lock':True})
report={'schema_version':1,'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_sha256':manifest['archive_sha256'],'members':len(checks),'types':dict(collections.Counter(x['type']for x in checks)),'file_bytes':sum(x['size']for x in checks),'originals_checked':args.originals,'all_match':True,'source_archive_files_verified':len(source_checks),'source_archive_mode_note':'Git tar 0664/0775 regular modes retain executable bit; normalized to lock 100644/100755. No extraction, source execution or symlink dereference.','qualification':'none'}
for name,value in [('member-checks.json',checks),('source-member-checks.json',source_checks),('archive-check.json',report)]:
 with (root/name).open('x')as out:json.dump(value,out,indent=2);out.write('\n')
print(json.dumps(report,indent=2))
