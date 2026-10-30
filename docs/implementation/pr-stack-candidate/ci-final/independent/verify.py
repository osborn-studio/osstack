import pathlib,json,re,hashlib,datetime
root=pathlib.Path(__file__).resolve().parent.parent;out=root/'independent'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(name,x): (out/name).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
inputs=[{'path':n,'bytes':len((root/n).read_bytes()),'sha256':sha((root/n).read_bytes())} for n in ['metadata.stdout','full-log.stdout']]
m=json.loads((root/'metadata.stdout').read_bytes());assert m['headSha']=='db0652dde3ec4695ef592b0d7f1c14a14a30917e' and m['status']=='completed' and m['conclusion']=='success' and m['url'].endswith('/40988439592')
raw=(root/'full-log.stdout').read_text().splitlines(); groups={}; packages=[];checkouts=[]
for n,line in enumerate(raw,1):
 parts=line.split('\t',2)
 if len(parts)!=3:continue
 job,step,rest=parts
 rest=re.sub(r'^\ufeff?\d{4}-\d\d-\d\dT[^ ]+ ','',rest)
 rest=re.sub(r'(?:\x1b|\^\[)\[[0-?]*[ -/]*[@-~]','',rest)
 groups.setdefault((job,step),[]).append({'line':n,'text':rest})
 if job=='check' and step=='Test':
  a=re.search(r'packages/([^ ]+) test:\s+Tests\s+(.+)',rest)
  if a:
   counts={k:int(v) for v,k in re.findall(r'(\d+) (passed|skipped|failed)',a[2])};total=int(re.search(r'\((\d+)\)',a[2])[1]);assert sum(counts.values())==total
   packages.append({'package':a[1],'passed':counts.get('passed',0),'skipped':counts.get('skipped',0),'failed':counts.get('failed',0),'total':total,'line':n,'raw':line})
 if 'checkout@' in step and re.fullmatch('[0-9a-f]{40}',rest):checkouts.append({'job':job,'sha':rest,'line':n})
assert len(packages)==len({p['package'] for p in packages})==22
assert len(checkouts)==5 and len({x['sha'] for x in checkouts})==1
jobs=[{k:j[k] for k in ['name','databaseId','status','conclusion','startedAt','completedAt','url']} for j in m['jobs']]
assert sum(j['conclusion']=='success' for j in jobs)==5 and sum(j['conclusion']=='skipped' for j in jobs)==1
check=next(j for j in m['jobs'] if j['name']=='check');steps=[{k:s[k] for k in ['name','number','status','conclusion']} for s in check['steps']]
tap={}
for (job,step),rows in groups.items():
 if job!='check':continue
 c={};ln=[]
 for r in rows:
  a=re.fullmatch(r'# (tests|pass|fail|skipped|cancelled) (\d+)',r['text'])
  if a: assert a[1] not in c;c[a[1]]=int(a[2]);ln.append(r['line'])
 if c:tap[step]={'counts':c,'lines':ln}
def json_objects(step):
 rows=groups['check',step];result=[];i=0
 while i<len(rows):
  t=rows[i]['text']
  if t.startswith('{'):
   start=i
   if t=='{':
    while rows[i]['text']!='}':i+=1
   obj=json.loads('\n'.join(r['text'] for r in rows[start:i+1]));result.append({'start_line':rows[start]['line'],'end_line':rows[i]['line'],'value':obj})
  i+=1
 return result
selected=['Method verification journey (two real local cases)','Full method verification journey (five real local cases)','Maintain fixed skills map (five real local cases)','Project and check actual method evidence','Project and check full five-case method evidence']
actual={s:json_objects(s) for s in selected}; write('actual-logged-json.json',actual)
summary={}
for s in selected[:2]:
 o=actual[s][0]['value'];assert o['status']=='passed'
 summary[s]={'status':o['status'],'cases':[{k:f[k] for k in ['case_id','verification','product_exit','product_status','driver_exit','cleanup']} for f in o['features']], 'line':actual[s][0]['start_line']}
 assert [f['product_exit'] for f in o['features']]==([0,1] if s==selected[0] else [0,1,2,1,0]);assert all(f['driver_exit']==0 and f['verification']=='passed' for f in o['features'])
o=actual[selected[2]][0]['value'];assert o['status']=='consistent' and o['exit_code']==0 and o['map']['unchanged'] is True and len(o['rows'])==5 and all(r['matches'] for r in o['rows']);summary[selected[2]]={'status':o['status'],'rows':o['rows'],'line':actual[selected[2]][0]['start_line']}
for s in selected[3:]:
 vals=actual[s];assert [x['value']['status'] for x in vals]==['projected','valid'];assert vals[0]['value']['packet_sha256']==vals[1]['value']['packet_sha256'];summary[s]=vals
individual=[]
for r in groups['check','Test']:
 if re.search(r'packages/github test:.*src/(?:pr-candidate-snapshot|pr-stack-candidate)\.test\.ts \(',r['text']):individual.append(r)
report={'schema_version':1,'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Independent parsing of supplied immutable CI metadata/log bytes only; no product/test/model execution or remote artifact download.','run':40988439592,'head_sha':m['headSha'],'base_sha_from_checkout_merge_message':'e4643324b9de1d2db51c744e59ccd7c05146b0a6','base_branch':'not independently present in these two inputs','synthetic_checkout':checkouts,'jobs':jobs,'check_steps':steps,'package_counts':packages,'totals':{k:sum(p[k] for p in packages) for k in ['passed','skipped','failed','total']},'unique_packages':22,'individual_github_files':individual,'standalone_contract_counts':tap,'actual_step_summary':summary,'input_bindings':inputs,'limitations':['CI stdout summaries and reported manifest/packet hashes were inspected, but remote artifacts were not downloaded or independently rehashed.','Synthetic merge checkout is distinct from PR head and base.','Package aggregate counts include package tests only; standalone contracts and matrix repeats are not added.','Expected negative product exits 1/2 are distinct from successful driver/verification outcomes.','No new source audit, host execution, formal qualification, PR mutation or ledger mutation.']}
write('report.json',report);write('input-hashes.json',inputs)
t=report['totals'];md=f'''# PR310 CI 独立日志核验

运行 `40988439592`，head `{m['headSha']}`。五个适用 job 成功，Paid DeepSeek semantic smoke 跳过。

- 实际 synthetic checkout `{checkouts[0]['sha']}`；checkout merge message 的 base 为 `e4643324b9de1d2db51c744e59ccd7c05146b0a6`。两个输入未独立提供 base 分支名。
- 仅 `check/Test` 的 22 个唯一包：**{t['passed']} passed / {t['skipped']} skipped / {t['failed']} failed**。GitHub 224 passed，CLI 2764 passed / 6 skipped；其他 skip 来自 loop 1。
- GitHub 单项：PR candidate snapshot 47 tests，PR stack candidate 29 tests。
- standalone：export 94 总数＝93 pass＋1 skip；reader 14，journey 43，projection 88，map 24；单 PR CLI 14、新增 ordered stack CLI 29 全通过。Lint 与 Inventory freshness 成功。
- 真实 default journey 两项 product exits `0/1`；full journey 五项 `0/1/2/1/0`，每项 driver 0、verification passed。五项 map actual/expected 全部 matches。
- default/full 分别实际执行 project 和 check，均 `projected → valid`，对应 packet SHA 在日志内一致。该核验没有下载远端 artifact，未独立复算其内容 hash；stdout 的 cleanup/manifest 声明不扩展为全后代进程或宿主资格。

原日志逐行定位、22 包原始汇总、完整 step 状态及实际 JSON 在 `report.json` 与 `actual-logged-json.json`；输入 bytes/hash 在 `input-hashes.json`。未运行产品、模型或测试，未修改 PR/账本。
''';(out/'report.md').write_text(md)
write('manifest.json',[{'path':p.name,'bytes':len(p.read_bytes()),'sha256':sha(p.read_bytes())} for p in sorted(out.iterdir()) if p.is_file() and p.name!='manifest.json'])
print(json.dumps({'totals':t,'report_sha256':sha((out/'report.json').read_bytes()),'manifest_sha256':sha((out/'manifest.json').read_bytes())}))
