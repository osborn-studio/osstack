from pathlib import Path,PurePosixPath
import tarfile,json,hashlib,re,os,subprocess,stat
r=Path(__file__).parent;s=r.parent;repo=Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack');archive=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pr305-retarget-ledger/docs/implementation/skills-check-map-maintenance/evidence/raw-verification.tar.gz');sha=lambda b:hashlib.sha256(b).hexdigest();expected='bebda658b5adff1de4de2fbd133bab9a372220b2a95d7cb24cc666b44f787886';assert sha(archive.read_bytes())==expected
with tarfile.open(archive,'r:gz') as t:
 members=t.getmembers();names=[m.name for m in members];assert len(names)==len(set(names));mraw=t.extractfile('archive-manifest.json').read();manifest=json.loads(mraw);assert mraw==(s/'archive-manifest.json').read_bytes();entries=manifest['members'];assert set(names)=={'archive-manifest.json'}|{f['path'] for f in entries};nbytes=0;symlinks=[];count=0
 for f in entries:
  p=PurePosixPath(f['path']);assert not p.is_absolute() and '..' not in p.parts
  item=t.getmember(f['path']);assert item.mode==f['mode'];original=(Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pr305-main-retarget-20261030/maintenance-independent')/str(p.relative_to('independent'))) if p.parts[0]=='independent' else s/str(p)
  if f['type']=='symlink':
   assert item.issym() and item.linkname==f['target']==os.readlink(original);symlinks.append({'path':str(p),'target':item.linkname,'extraction_warning':'absolute test symlink intentionally stored; verified without extracting or following'})
  else:
   assert item.isfile();b=t.extractfile(item).read();assert len(b)==item.size==f['bytes'] and sha(b)==f['sha256'];assert b==original.read_bytes();nbytes+=len(b);count+=1
 assert (len(entries),count,len(symlinks),nbytes)==(1215,1214,1,21119793)
 def raw(p):return t.extractfile(p).read()
 def load(p):return json.loads(raw(p))
 audit=[]
 for name in ['audit','audit-closure','audit-closure-final']:
  b=load(name+'/binding.json');response=raw(name+'/response.json');prompt=raw(name+'/audit-input.txt');assert sha(prompt)==b['prompt_sha256'] and sha(response)==b['response_sha256'];resp=json.loads(response);report=raw(name+'/report.md').decode();assert report.strip()==resp['result'].strip();audit.append({'name':name,'report_sha256':sha(report.encode()),'verdict_line':report.splitlines()[0]})
 before=load('root/full-before.json');after=load('root/full-after.json');assert before==after and len(before)==8471;binding=load('root/full-binding.json');assert binding['tracked_bytes_unchanged'] and binding['exit_code']==0 and binding['head']=='4cc8ff7e25a80e6193bb83db2ac93c1b16e9c57f';dirty=[l[3:] for l in binding['dirty_before'].splitlines()];assert len(dirty)==4 and all(p.startswith('packages/knowledge/dist/') for p in dirty)
 log=raw('root/full.log').decode();log=re.sub(r'\x1b\[[0-9;]*m','',log);rows=[]
 for line in log.splitlines():
  m=re.search(r'^(packages/[^ ]+) test:\s+Tests\s+(.+)',line)
  if m:
   c={k:int((re.search(r'(\d+) '+k,m[2]) or [None,0])[1]) for k in ['passed','skipped','failed']};rows.append({'package':m[1],**c})
 assert len(rows)==len({v['package'] for v in rows})==22;totals={k:sum(v[k] for v in rows) for k in ['passed','skipped','failed']};assert totals=={'passed':7144,'skipped':5,'failed':0}
 runs=[];manifests=0
 for phase,exit in [('red',1),('green',0)]:
  prefix='root/actual-'+phase;v=load(prefix+'/maintenance.json');j=load(prefix+'/journey/journey.json');assert v['exit_code']==exit and v['execution_path']=='runJourney';assert v['map']['unchanged'] and sha(raw(prefix+'/map-before.json'))==v['map']['before_sha256']==v['map']['after_sha256'];assert sha(raw(prefix+'/journey/journey.json'))==v['journey']['receipt_sha256'];assert sha(raw(prefix+'/journey/journey-manifest.json'))==v['journey']['manifest_sha256'];assert v['journey']['receipt_matches_returned']
  assert [f['product_exit'] for f in j['features']]==[0,1,2,1,0];assert all(f['driver_exit']==0 and f['verification']=='passed' and f['cleanup']['fixture_removed'] and not Path(f['cleanup']['fixture_path']).exists() for f in j['features'])
  for p in [prefix+'/journey/journey-manifest.json']+[prefix+'/journey/cases/'+f['case_id']+'/manifest.json' for f in j['features']]:
   ma=load(p)
   for f in ma['files']:
    b=raw(str(PurePosixPath(p).parent/f['path']));assert len(b)==f['bytes'] and sha(b)==f['sha256']
   manifests+=1
  runs.append({'phase':phase,'exit':v['exit_code'],'status':v['status'],'bindings':j['features'][0]['bindings'],'fixtures_observed_absent':5})
 assert runs[0]['bindings']==runs[1]['bindings'];a=load('root/actual-red/map-before.json');b=load('root/actual-green/map-before.json');delta=[(i,k,x[k],y[k]) for i,(x,y) in enumerate(zip(a['features'],b['features'])) for k in x if x[k]!=y[k]];assert delta==[(1,'expected_product_exit',0,1)]
paths=['scripts/maintain-skills-check-map.mjs','scripts/maintain-skills-check-map.test.mjs','docs/implementation/skills-check-map-maintenance/map.json','docs/implementation/skills-check-map-maintenance/README.md'];sources=[]
for p in paths:
 a=subprocess.check_output(['git','show','4cc8ff7e:'+p],cwd=repo);b=subprocess.check_output(['git','show','671f9d7e:'+p],cwd=repo);assert a==b;sources.append({'path':p,'sha256':sha(a)})
report={'status':'verified','archive_sha256':expected,'payload_members':len(entries),'files':count,'symlinks':symlinks,'file_bytes':nbytes,'archive_manifest_sha256':sha(mraw),'all_payload_matches_live_frozen_originals':True,'audits':audit,'full':{'head':binding['head'],'packages':rows,'totals':totals,'tracked_bytes_equal_count':len(before),'preexisting_dirty':dirty},'root_alias_runs':runs,'map_only_delta':delta,'nested_journey_manifests_verified':manifests,'source4cc_equals671':sources,'limits':['No tests/models rerun.','Stored absolute test symlink verified as link metadata, not extracted/followed.','Author8ed actual runs remain bound8ed; root alias runs bind4cc, not retroactive author rebinding.','Initial REVISE, source closure with conditional CI REVISE, and final conditional-only PASS remain raw and unchanged.','Byte/source/build equality is not authenticated compilation, fixture absence is not all-descendant termination.']}
(r/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'status':'verified','receipt_sha256':sha((r/'receipt.json').read_bytes()),'files':count,'bytes':nbytes,'full':totals}))
