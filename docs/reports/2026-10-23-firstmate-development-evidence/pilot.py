import os,json,subprocess,pathlib,uuid,socket,struct,time,sqlite3,shlex,hashlib,signal
repo=pathlib.Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack')
evidence=repo/'docs/reports/2026-10-23-firstmate-development-evidence'
root=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/smoke')/('attention-pilot-'+uuid.uuid4().hex[:6]);root.mkdir()
home=root/'home';home.mkdir();sock=root/'d.sock';cli=repo/'packages/cli/dist/bin.js'
env={**os.environ,'OSSTACK_HOME':str(home),'OSSTACK_SOCKET':str(sock),'OSSTACK_SCRATCH_ROOT':'/Volumes/AIMATE_WORK/tmp/osstack','OSSTACK_ATTENTION':'1','OSSTACK_UPDATE_CHECK':'0','OSSTACK_DASHBOARD_PORT':'0'}
log=(root/'daemon.log').open('w');p=subprocess.Popen(['node',str(cli),'serve'],cwd=repo,env=env,stdout=log,stderr=log)
def rpc(method,params):
 s=socket.socket(socket.AF_UNIX);s.settimeout(30);s.connect(str(sock));body=json.dumps({'id':1,'method':method,'params':params}).encode();s.sendall(struct.pack('>I',len(body))+body)
 def read(n):
  b=b''
  while len(b)<n:
   x=s.recv(n-len(b))
   if not x:raise RuntimeError('eof')
   b+=x
  return b
 n=struct.unpack('>I',read(4))[0];res=json.loads(read(n));s.close()
 if not res['ok']:raise RuntimeError(str(res))
 return res['result']
try:
 for i in range(200):
  if sock.exists():break
  if p.poll() is not None:raise RuntimeError((root/'daemon.log').read_text())
  time.sleep(.05)
 db=sqlite3.connect(home/'state.db');db.execute("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('pilot','pilot','running',1,1)")
 for i in range(100):
  sid=f's{i:03d}';rid=f'r{i:03d}'
  db.execute("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES(?,'pilot',?,'codex-cli','code','execute',1)",(rid,sid))
  db.execute("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES(?,'pilot',?,'codex-cli',?,?,'awaiting_decision',1,1,1,?)",(sid,rid,'a'*64,str(root),'native-'+sid))
  for t in range(10):db.execute("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES(?,?,?,'awaiting_decision',?,1,1)",(f'{sid}-t{t}',sid,t+1,json.dumps({'decision_id':'d','question':f'Question {t}','choices':[]})))
 db.commit();before=time.perf_counter();view=rpc('attention.watch',{'task_id':'pilot','repo_path':str(root),'default_tenant':True});watch_ms=(time.perf_counter()-before)*1000;scope=view['scope']['scope_id']
 assert view['subject_total']==100 and view['admitted']==100 and view['coverage']=='covered',view
 assert db.execute('SELECT COUNT(*) FROM attention_items').fetchone()[0]==1000
 timings=[]
 for i in range(100):
  a=time.perf_counter();rpc('attention.inventory',{'scope_id':scope});timings.append((time.perf_counter()-a)*1000)
 # Record one real harness Stop routed through the actual built CLI + Unix RPC.
 fg=rpc('attention.foreground',{'scope_id':scope,'subjects':[{'subject_id':'s000','source_version':1}]})
 native=str(uuid.uuid4());binding=root/'binding.json';binding.write_text(json.dumps({**fg,'scope_id':scope,'session_id':native,'harness_version':'2.1.291'}));binding.chmod(0o600)
 command=' '.join(shlex.quote(x) for x in ['node',str(cli),'attention','claude-hook','--binding-file',str(binding)])
 settings=root/'settings.json';settings.write_text(json.dumps({'disableAllHooks':False,'enabledPlugins':{},'autoMemoryEnabled':False,'hooks':{'Stop':[{'hooks':[{'type':'command','command':command,'timeout':10}]}]}}))
 empty=root/'mcp.json';empty.write_text('{"mcpServers":{}}')
 result=subprocess.run(['/opt/homebrew/bin/claude','--print','--model','claude-haiku-5-5','--session-id',native,'--output-format','json','--disable-slash-commands','--tools','','--settings',str(settings),'--setting-sources','','--strict-mcp-config','--mcp-config',str(empty),'--no-session-persistence','Reply READY and stop.'],cwd=root,env=env,capture_output=True,text=True,timeout=90)
 response=json.loads(result.stdout);assert not response.get('is_error'),response
 reminded=db.execute('SELECT reminder_sent FROM attention_foregrounds WHERE client_id=?',(fg['client_id'],)).fetchone()[0];assert reminded==1,(result.stderr,response)
 duplicate=rpc('attention.turn-end',{'scope_id':scope,'client_id':fg['client_id'],'token':fg['token'],'role':'foreground_owner'});assert duplicate['reminder'] is None
 brief=rpc('attention.brief',{'scope_id':scope,'actor':'owner'});assert brief['total']==1000 and len(brief['items'])==3
 report={'subjects':100,'historical_turns':1000,'items':1000,'coverage':view['coverage'],'watch_ms':watch_ms,'inventory_rpc_p95_ms':sorted(timings)[94],'inventory_samples':100,'hook_version':'2.1.291','hook_model_usage':list(response.get('modelUsage',{})),'hook_reminder_sent':reminded,'duplicate_reminder':duplicate['reminder'],'brief_total':brief['total'],'brief_returned':len(brief['items']),'scratch':str(root),'production_home_touched':False,'model_calls_in_observer':0}
 (evidence/'runtime-pilot.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2));db.close()
finally:
 p.send_signal(signal.SIGTERM)
 try:p.wait(timeout=20)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 log.close()
