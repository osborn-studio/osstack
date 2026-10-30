from pathlib import Path
import hashlib,json,subprocess,re
O=Path(__file__).parent;S=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-adoption-bundle-20261030');W=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-adoption-bundle');H=lambda b:hashlib.sha256(b).hexdigest();errors=[];checks=[]
b=json.loads((S/'root/final-source-binding.json').read_text())
for e in b['files']:
 raw=(S/'root/final-source'/e['path']).read_bytes();git=subprocess.run(['git','show',b['code_sha']+':'+e['path']],cwd=W,capture_output=True)
 ok=len(raw)==e['bytes'] and H(raw)==e['sha256'] and git.returncode==0 and git.stdout==raw
 checks.append({'path':e['path'],'binding':'final-source + Git '+b['code_sha'],'pass':ok})
 if not ok:errors.append(e['path'])
audits=[]
for name in ['audit','audit-closure']:
 d=S/name;binding=json.loads((d/'binding.json').read_text());response=json.loads((d/'response.json').read_text());prompt=(d/'audit-input.txt').read_bytes();report=(d/'report.md').read_text()
 ok=H(prompt)==binding['prompt_sha256'] and H((d/'response.json').read_bytes())==binding['response_sha256'] and report.strip()==response['result'].strip()
 if not ok:errors.append(name+' prompt/response/report binding')
 audits.append({'path':name,'pass':ok,'modelUsage_keys':list(response['modelUsage']),'exit_code':binding['exit_code'],'is_error':response['is_error'],'report_first_line':report.splitlines()[0],'model_identity':'CLI reported, no independent provider attestation'})
# Verify recorded final input files against snapshot, retained records, or exact Git blob.
for name,rev in [('audit','2389dcd9f9f556df4c79e419bdc3e68561cba128'),('audit-closure',b['code_sha'])]:
 prompt=(S/name/'audit-input.txt').read_bytes()
 for e in json.loads((S/name/'inputs.json').read_text()):
  opts=[S/e['path'],S/'root/final-source'/e['path']]
  candidates=[x.read_bytes() for x in opts if x.is_file()]
  g=subprocess.run(['git','show',rev+':'+e['path']],cwd=W,capture_output=True)
  if g.returncode==0:candidates.append(g.stdout)
  matching=[x for x in candidates if len(x)==e['bytes'] and H(x)==e['sha256']]
  # Documentation may be untracked at audit; verify exact text segment by declared size/hash.
  if not matching:
   marker=e['path'].encode(); at=prompt.find(marker);found=False
   # Search near heading for each newline-aligned content start; bound window to 512 bytes.
   for start in range(max(at,0),min(len(prompt),max(at,0)+512)):
    if start and prompt[start-1:start]!=b'\n':continue
    chunk=prompt[start:start+e['bytes']]
    if H(chunk)==e['sha256']:matching=[chunk];break
  ok=bool(matching) and any(x in prompt for x in matching)
  checks.append({'path':e['path'],'binding':name+' inputs + exact prompt bytes','pass':ok})
  if not ok:errors.append(name+' input '+e['path'])
results=[]
for n in ['root/full-result.json','root/full-node22/full-result.json','root/full-node22-native/full-result.json']:
 x=json.loads((S/n).read_text());results.append({'path':n,**x})
# Recount the successful historical full directly from stdout.
t=(S/'root/full-node22-native/full.stdout').read_text();t=re.sub(r'\x1b\[[0-9;]*m','',t); rows=[]
for line in t.splitlines():
 m=re.search(r'packages/([^ ]+) test:.*Tests\s+(\d+) passed(?: \| (\d+) skipped)?',line)
 if m:rows.append({'package':m[1],'passed':int(m[2]),'skipped':int(m[3] or 0)})
totals={'passed':sum(x['passed'] for x in rows),'skipped':sum(x['skipped'] for x in rows),'failed':0}
if len(rows)!=22 or totals!=json.loads((S/'root/full-node22-native/counts.json').read_text())['totals']:errors.append('full count mismatch')
r={'errors':errors,'final_code_sha':b['code_sha'],'bindings':checks,'audits':audits,'full_runs':results,'historical_full_recount':{'unique_packages':len(set(x['package'] for x in rows)),'totals':totals,'head':results[-1]['head']},'limits':['No runtime/build/test rerun.','Historical full does not cover final audit repairs.','Archive consistency is not provenance authenticity or native host qualification.']}
(O/'bindings.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'errors':errors,'checks':len(checks),'audits':audits,'totals':totals},indent=2))
