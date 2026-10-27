from pathlib import Path
import json,subprocess,os,time,datetime,gzip,hashlib,concurrent.futures,sys
S=Path(__file__).parent;A=Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/design/2026-10-27-joint-engineering/evidence/sonnet-audit-2026-10-27')
if sys.argv[1:] == ['refine']:
 m=json.loads((A/'input-manifest.json').read_text());omit=[x for x in m['files'] if x.get('repository')=='firstmate' and ((x['bytes']>70000 and x['path']!='docs/architecture.md') or (x['path'].startswith('tests/') and x['bytes']>40000))]
 for mode in ['review','challenge']:
  p=(S/(mode+'-input.txt')).read_text()
  for x in omit:
   begin='\n===== BEGIN SOURCE '+x['label']+' =====\n';end='\n===== END SOURCE '+x['label']+' =====\n';s=p.index(begin);e=p.index(end,s)+len(end);p=p[:s]+p[e:]
  p+='\nSOURCE COVERAGE LIMIT: Large upstream Firstmate files excluded to keep context bounded. Capability completeness is not a line-by-line upstream audit. Omitted:\n'+'\n'.join(x['label'] for x in omit)+'\n'
  b=p.encode();(S/(mode+'-input.txt')).write_bytes(b);(A/(mode+'-input.txt.gz')).write_bytes(gzip.compress(b,mtime=0));m['prompts'][mode]={'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)}
 m['files']=[x for x in m['files'] if x not in omit];m['omitted_primary_sources']=omit;m['file_count']=len(m['files']);m['source_bytes']=sum(x['bytes'] for x in m['files']);(A/'input-manifest.json').write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n');print(m['file_count'],m['source_bytes']);sys.exit()
def run(mode):
 args=['/opt/homebrew/bin/claude','-p','--model','claude-sonnet-5-5','--effort',('medium' if mode.startswith('closeout') else 'high'),'--output-format','json','--disable-slash-commands','--tools','','--strict-mcp-config','--mcp-config',str(S/'empty-mcp.json'),'--safe-mode','--no-session-persistence','--permission-mode','dontAsk','--setting-sources','','--settings',str(S/'settings.json')]
 env=os.environ.copy();env['CLAUDE_CODE_MAX_OUTPUT_TOKENS']='128000';started=datetime.datetime.now(datetime.timezone.utc).isoformat();t=time.monotonic()
 with (S/(mode+'-input.txt')).open('rb') as inp,(A/(mode+'-response.json')).open('wb') as out,(A/(mode+'-stderr.log')).open('wb') as err:
  p=subprocess.Popen(args,stdin=inp,stdout=out,stderr=err,cwd=S,env=env)
  (A/(mode+'-running.json')).write_text(json.dumps({'pid':p.pid,'started_at_utc':started,'argv':args},indent=2)+'\n');code=p.wait()
 record={'mode':mode,'argv':args,'cli_version':'2.1.291','requested_model':'claude-sonnet-5-5','max_output_tokens_env':128000,'started_at_utc':started,'elapsed_seconds':round(time.monotonic()-t,2),'exit_code':code}
 try:
  data=json.loads((A/(mode+'-response.json')).read_text());result=data.get('result','');(A/(mode+'-raw.md')).write_text(result)
  record.update({'is_error':data.get('is_error'),'subtype':data.get('subtype'),'model_usage':data.get('modelUsage'),'usage':data.get('usage'),'session_id':data.get('session_id'),'num_turns':data.get('num_turns'),'result_characters':len(result),'complete_markers':('CLOSEOUT' if mode.startswith('closeout') else mode.split('-')[0].upper())+'_BEGIN' in result and ('CLOSEOUT' if mode.startswith('closeout') else mode.split('-')[0].upper())+'_END' in result})
 except Exception as exc:record['parse_error']=str(exc)
 (A/(mode+'-run.json')).write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n');print(json.dumps(record,ensure_ascii=False),flush=True)
if __name__=='__main__':
 modes=sys.argv[1:] or ['review','challenge']
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(run,modes))
