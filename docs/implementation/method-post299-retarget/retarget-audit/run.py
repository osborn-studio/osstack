import subprocess,pathlib,json,hashlib,datetime,os
r=pathlib.Path(__file__).parent
args=['/opt/homebrew/bin/claude','-p','--model','claude-sonnet-5-5','--effort','high','--output-format','json','--disable-slash-commands','--tools','','--strict-mcp-config','--mcp-config',str(r/'empty-mcp.json'),'--safe-mode','--no-session-persistence','--permission-mode','dontAsk','--setting-sources','','--settings',str(r/'settings.json')]
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (r/'audit-input.txt').open() as i,(r/'response.json').open('w') as o,(r/'stderr.txt').open('w') as e:
 try: code=subprocess.run(args,cwd=r,stdin=i,stdout=o,stderr=e,timeout=900,env={**os.environ,"PATH":"/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin"}).returncode
 except subprocess.TimeoutExpired: code=124
try: v=json.loads((r/'response.json').read_text())
except Exception: v={'is_error':True,'result':'Response is not valid JSON; original output retained.'}
(r/'report.md').write_text(v.get('result',''))
b={'started_at':start,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':code,'modelUsage':v.get('modelUsage'),'is_error':v.get('is_error'),'prompt_sha256':hashlib.sha256((r/'audit-input.txt').read_bytes()).hexdigest(),'response_sha256':hashlib.sha256((r/'response.json').read_bytes()).hexdigest()}
(r/'binding.json').write_text(json.dumps(b,indent=2));print(v.get('result',''));print('exit',code)
