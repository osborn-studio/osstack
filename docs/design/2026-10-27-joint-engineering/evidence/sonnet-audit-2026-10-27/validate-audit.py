#!/usr/bin/env python3
"""Verify archived CLI inputs/results; never loads OSStack or opens its DB."""
from pathlib import Path
import gzip,hashlib,json,re
A=Path(__file__).resolve().parent
sha=lambda b:hashlib.sha256(b).hexdigest()
def require(ok,message):
    if not ok:raise ValueError(message)
def verify():
    manifest=json.loads((A/'input-manifest.json').read_text())
    prompts={}
    for mode,info in manifest['prompts'].items():
        b=gzip.decompress((A/(mode+'-input.txt.gz')).read_bytes())
        require(sha(b)==info['sha256'] and len(b)==info['bytes'],'prompt changed: '+mode)
        prompts[mode]=b.decode()
        for item in manifest['files']:
            begin='\n===== BEGIN SOURCE '+item['label']+' =====\n';end='\n===== END SOURCE '+item['label']+' =====\n'
            text=prompts[mode];start=text.index(begin)+len(begin);finish=text.index(end,start);data=text[start:finish].encode()
            require(sha(data)==item['sha256'] and len(data)==item['bytes'],'input file differs: '+item['label'])
    complete=[];partials=[]
    modes=['probe','review','review-recovered','challenge','closeout']
    for extra in ['closeout2','closeout3']:
        if (A/(extra+'-run.json')).exists():modes.append(extra)
    for mode in modes:
        response=json.loads((A/(mode+'-response.json')).read_text());run=json.loads((A/(mode+'-run.json')).read_text())
        require((A/(mode+'-raw.md')).read_text()==response['result'],'raw result modified: '+mode)
        require(run['exit_code']==0 and response.get('is_error') is False,'CLI failed: '+mode)
        usage=response['modelUsage'];require(usage and all(x.get('canonicalModel')=='claude-sonnet-5-5' for x in usage.values()),'wrong actual model: '+mode)
        argv=run['argv'];require(argv[argv.index('--tools')+1]=='' and '--disable-slash-commands' in argv and '--strict-mcp-config' in argv,'nested tool boundary wrong')
        marker='REVIEW' if mode.startswith('review') else ('CLOSEOUT' if mode.startswith('closeout') else mode.upper())
        is_complete=marker+'_BEGIN' in response['result'] and marker+'_END' in response['result']
        if mode=='review':
            require(not is_complete,'historical partial unexpectedly changed');partials.append(mode)
        else:require(is_complete,'incomplete report: '+mode);complete.append(mode)
    for name in ['closeout','closeout2','closeout3']:
        if not (A/(name+'-input-manifest.json')).exists():continue
        m=json.loads((A/(name+'-input-manifest.json')).read_text());b=gzip.decompress((A/(name+'-input.txt.gz')).read_bytes())
        require(sha(b)==m['prompt_sha256'] and len(b)==m['prompt_bytes'],'re-review prompt changed')
        for entry in m['files']:
            marker=('\n===== '+entry['path']+' =====\n').encode();start=b.index(marker)+len(marker);payload=b[start:start+entry['bytes']]
            require(sha(payload)==entry['sha256'],'re-review input mismatch: '+entry['path'])
    rows=json.loads((A/'dispositions.json').read_text())['items'];expected={f'RV{i:02}' for i in range(1,19)}|{f'CH{i:02}' for i in range(1,17)}
    require({x['id'] for x in rows}==expected and len(rows)==34,'original finding disposition missing')
    co=json.loads((A/'closeout-dispositions.json').read_text())['items'];cf=json.loads((A/'closeout2-dispositions.json').read_text())['items']
    require({r['id'] for r in co}=={f'CO{i:02}' for i in range(1,11)} and len(co)==10,'closeout finding missing')
    require({r['id'] for r in cf}=={f'CF{i:02}' for i in range(1,4)} and len(cf)==3,'final finding missing')
    scope=json.loads((A/'scope-check.json').read_text());require(not scope['unexpected_changes'],'unexpected workspace edits')
    return {'status':'passed_audit_integrity_only','actual_model':'claude-sonnet-5-5','initial_input_files':manifest['file_count'],'complete_calls':complete,'partial_calls_preserved':partials,'dispositions':len(rows)+len(co)+len(cf),'round_counts':{'RV_CH':len(rows),'CO':len(co),'CF':len(cf)},'product_runtime_validated':False}
if __name__=='__main__':
    print(json.dumps(verify(),ensure_ascii=False,indent=2))
