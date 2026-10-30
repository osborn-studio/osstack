from pathlib import Path,PurePosixPath
import json,hashlib,tarfile,os,stat,subprocess,datetime
OUT=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-method-bridge-archive-check-20261030/independent')
WT=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-method-bridge')
E=WT/'docs/implementation/pstack-method-bridge/evidence';A=E/'raw-verification.tar.gz';M=E/'raw-manifest.json'
h=lambda b:hashlib.sha256(b).hexdigest();manifest=json.loads(M.read_bytes());S=Path(manifest['source_root']);issues=[];checks=[]
def ck(ok,label,detail=None):
 if not ok:issues.append({'check':label,'detail':detail})
 return bool(ok)
ck(h(A.read_bytes())=='ef0900ac9672c5d7cc0c48ef268bd97510235ad3e58c56dbb981a836f486511e','archive hash')
ck(h(M.read_bytes())=='dde230cd3c1c09ac79bbb59082ac8524cedcc1810a15a2e49ad7d71e1acdde2f','manifest hash')
listed={r['path']:r for r in manifest['members']};ck(len(listed)==len(manifest['members'])==1578,'manifest unique member count')
with tarfile.open(A,'r:gz') as t:
 members=t.getmembers();actual={m.name.rstrip('/'):m for m in members};ck(len(actual)==len(members),'no duplicate tar names');ck(set(actual)==set(listed),'exact tar manifest member set',{'missing':sorted(set(listed)-set(actual)),'extra':sorted(set(actual)-set(listed))})
 for name,r in listed.items():
  before=len(issues);parts=PurePosixPath(name).parts;ck(bool(parts) and not name.startswith('/') and all(x not in ['.','..',''] for x in parts),'safe relative name',name)
  # No extraction and no source symlink dereference, including parent chain.
  safe=True
  for i in range(1,len(parts)):
   parent=S.joinpath(*parts[:i]);ps=parent.lstat();safe=ck(stat.S_ISDIR(ps.st_mode) and not stat.S_ISLNK(ps.st_mode),'regular original ancestor',str(parent)) and safe
  if not safe:continue
  src=S/name;ss=src.lstat();m=actual.get(name)
  if m is None:continue
  expected=r['type'];stype='symlink' if stat.S_ISLNK(ss.st_mode) else 'directory' if stat.S_ISDIR(ss.st_mode) else 'file' if stat.S_ISREG(ss.st_mode) else 'other';ttype='symlink' if m.issym() else 'directory' if m.isdir() else 'file' if m.isreg() else 'other'
  ck(expected==stype==ttype,'member type',name);ck(r['mode']==stat.S_IMODE(ss.st_mode)==m.mode,'member mode',name)
  if expected=='file':
   fd=os.open(src,os.O_RDONLY|os.O_NOFOLLOW)
   with os.fdopen(fd,'rb') as f:b=f.read()
   ab=t.extractfile(m).read();ck(len(b)==ss.st_size==r['size']==m.size==len(ab),'file size',name);ck(h(b)==r['sha256']==h(ab),'file SHA and original bytes',name)
  elif expected=='symlink':
   ck(os.readlink(src)==m.linkname==r['target'],'symlink target exact without dereference',name);ck(r['size']==m.size==0,'symlink archive payload zero',name)
  elif expected=='directory':ck(r['size']==m.size==0,'directory payload zero',name)
  checks.append({'path':name,'type':expected,'passed':len(issues)==before})
# Bind exact final-source copies to actual Git object, not merely current working tree.
final=json.loads((S/'final-source/binding.json').read_bytes());head=final['head'];ck(head=='b3fa2962c675bcfe10b6938613d5df4cb0d9d042','final source commit')
source_checks=[]
for r in final['files']:
 n=r['path'];b=(S/'final-source'/n).read_bytes();g=subprocess.check_output(['git','-C',str(WT),'show',head+':'+n]);ok=ck(h(b)==r['sha256']==h(g) and len(b)==r['bytes'],'final Git source exact',n);source_checks.append({'path':n,'sha256':h(b),'git_equal':ok})
# Audit prompt/response and copied input manifests are immutable snapshot bindings.
audits=[]
for folder in ['audit','audit-closure']:
 root=S/folder;binding=json.loads((root/'binding.json').read_bytes());im=json.loads((root/'input-manifest.json').read_bytes());n=0
 ck(h((root/'audit-input.txt').read_bytes())==binding['prompt_sha256'],'audit prompt hash',folder);ck(h((root/'response.json').read_bytes())==binding['response_sha256'],'audit response hash',folder)
 for row in im:
  relative=row['path'] if row['path'].startswith('inputs/') else 'inputs/'+row['path'];b=(root/relative).read_bytes();ck(len(b)==row['bytes'] and h(b)==row['sha256'],'audit copied input exact',folder+'/'+relative);n+=1
 response=json.loads((root/'response.json').read_bytes());report=(root/'report.md').read_text();text=response.get('result');ck(isinstance(text,str) and text.rstrip()==report.rstrip(),'audit report retained raw result text',folder)
 audits.append({'folder':folder,'inputs':n,'prompt_sha256':binding['prompt_sha256'],'response_sha256':binding['response_sha256'],'modelUsage_keys':list(binding.get('modelUsage',{})),'report_matches_response':isinstance(text,str) and text.rstrip()==report.rstrip()})
# C's frozen manifests and receipt/body details remain exact archive members.
critical=['independent/manifest.json','independent/final-report.json','independent-audit-followup/manifest.json','independent-audit-followup/before/result.json','independent-audit-followup/after/result.json','independent-audit-followup/before-binding.json','independent-audit-followup/after-binding.json','independent/prototype-delivery-final/1-real-cli-three-role-delivery/captured-and-receipts.json','prototype/request.json']
for name in critical:ck(name in listed,'critical evidence archived',name)
ck(h((S/'independent/manifest.json').read_bytes())=='fabc997e60bdd603ca8656c5faa1ac20b2646680d6af91692d3e9f246fab92fb','original independent manifest unchanged')
ck(h((S/'independent-audit-followup/manifest.json').read_bytes())=='74b16eb9eccb551de7d785ae1e678183a2d5cbe7585f4a7c631bf0a3f2a22f3f','off guard independent manifest unchanged')
base=S/'independent/prototype-delivery-final/1-real-cli-three-role-delivery';records=json.loads((base/'captured-and-receipts.json').read_bytes());compiled=json.loads((base/'repo/bundle/compiled.json').read_bytes());byrole={m['role']:m for m in compiled['materials']};caps={r['method_context']['capability_id']:r['method_context']['role'] for r in records['receipts']};receipt_checks=[]
ck(len(records['captured'])==3 and len(records['receipts'])==6,'prototype three invocations/six receipts')
for task in records['captured']:
 role=caps[task['capability_id']];prompt=task['prompt'];data=[]
 for line in prompt.splitlines():
  try:v=json.loads(line)
  except ValueError:continue
  if isinstance(v,dict) and 'materials' in v:data.append(v)
 ck(len(data)==1 and data[0]['role']==role and len(data[0]['materials'])==1,'role data block',role)
 mat=data[0]['materials'][0];ck(mat['text']==byrole[role]['text'] and h(mat['text'].encode())==byrole[role]['sha256'],'prototype exact material text',role)
 for r in [r for r in records['receipts'] if r['capability_id']==task['capability_id']]:ck(r['prompt_sha256']==h(prompt.encode()) and r['prompt_bytes']==len(prompt.encode()),'actual material prompt receipt binding',role)
 receipt_checks.append({'role':role,'material_bytes':len(mat['text'].encode()),'sha256':h(mat['text'].encode()),'prompt_bytes':len(prompt.encode())})
before=json.loads((S/'independent-audit-followup/before/result.json').read_bytes());after=json.loads((S/'independent-audit-followup/after/result.json').read_bytes());bb=json.loads((S/'independent-audit-followup/before-binding.json').read_bytes());ab=json.loads((S/'independent-audit-followup/after-binding.json').read_bytes());ck(before['failed']==2 and after['passed']==5 and after['failed']==0,'off guard old/new result');ck(bb['probe_sha256']==ab['probe_sha256'],'off guard same probe');ck(ab['source_sha256']==h((S/'final-source/packages/cli/src/execution-context.ts').read_bytes()),'off guard final source equality')
counts={typ:sum(r['type']==typ for r in manifest['members']) for typ in ['file','directory','symlink']};filebytes=sum(r['size'] for r in manifest['members'] if r['type']=='file');ck(counts=={'file':1109,'directory':461,'symlink':8} and filebytes==16997593,'declared counts and bytes')
result={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passed':not issues,'archive':str(A),'archive_sha256':h(A.read_bytes()),'manifest_sha256':h(M.read_bytes()),'members':len(checks),'counts':counts,'file_bytes':filebytes,'source_root':str(S),'symlink_policy':'lstat/readlink only; no extraction, no target dereference. Symlink size is zero archive payload, original link target string checked separately.','all_member_checks':checks,'final_source':{'head':head,'files':source_checks},'audits':audits,'actual_material_receipts':receipt_checks,'off_guard':{'before':{'passed':before['passed'],'failed':before['failed']},'after':{'passed':after['passed'],'failed':after['failed']},'same_probe':bb['probe_sha256']},'issues':issues,'limits':['Archive integrity and preserved bindings only, not new product/model/full execution','Current file hashes do not authenticate upstream facts or authorize execution','Original material delivery is controlled adapter, not native provider or comprehension','Audit raw output preserved, not a new audit or gate certification']}
(OUT/'receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['all_member_checks','final_source','audits','actual_material_receipts']},ensure_ascii=False));raise SystemExit(0 if not issues else 1)
