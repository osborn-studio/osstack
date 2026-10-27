"""Check research artifact integrity; not product integration acceptance."""
from pathlib import Path
from urllib.parse import urlparse, unquote
from datetime import datetime, timezone
import hashlib, json, re, subprocess
ROOT=Path(__file__).resolve().parent.parent
REPO=ROOT.parents[2]
E=ROOT/'evidence'
lock=json.loads((E/'source-lock.json').read_text())
UP=Path(lock['pstack']['clone'])
sha=lock['pstack']['commit']; base=lock['osstack']['integration_baseline']
checks=[]
def check(name, fn):
    fn(); checks.append({'check':name,'result':'pass'})
def require(condition, message):
    if not condition: raise AssertionError(message)
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def readj(path):return json.loads(path.read_text())
inv=readj(E/'pstack-inventory.json'); idx=readj(E/'osstack-source-index.json')
caps=readj(ROOT/'capability-map.json'); cases=readj(ROOT/'acceptance-cases.json')

def identity():
    require(git(UP,'rev-parse','HEAD').decode().strip()==sha,'upstream HEAD changed')
    require(git(UP,'rev-parse',sha+':pstack').decode().strip()==lock['pstack']['pstack_tree'],'tree mismatch')
    require(not git(UP,'status','--porcelain').strip(),'upstream clone changed')
check('pinned_upstream_identity_and_clean_clone',identity)

def inventory():
    require(len(inv['files'])==200,'file count')
    for f in inv['files']:
        blob=git(UP,'show',sha+':'+f['path'])
        require(hashlib.sha256(blob).hexdigest()==f['sha256'],f['path'])
        require(len(blob)==f['bytes'],f['path']+' bytes')
    for f in idx['files']:
        blob=git(REPO,'show',base+':'+f['path'])
        require(hashlib.sha256(blob).hexdigest()==f['sha256'],f['path'])
        require(f['commit']==base,'wrong baseline')
check('200_upstream_and_51_osstack_blob_hashes',inventory)

def capability_contract():
    require(caps['executable'] is False and caps['status']=='proposed_not_installed','proposal status')
    require(caps['source_commit']==sha and caps['integration_baseline']==base,'capability source identity')
    rows={x['id']:x for x in caps['capabilities']}
    require(len(rows)==24,'capability count')
    seen=set()
    def visit(k,active):
        require(k in rows,'unknown dependency '+k)
        require(k not in active,'capability cycle '+k)
        if k in seen:return
        for d in rows[k]['depends_on']:visit(d,active|{k})
        seen.add(k)
    for k,x in rows.items():
        require(x['enabled'] is False and x['status']=='proposed','not proposed '+k)
        require(x['priority'] in ['P0','P1','P2'],'priority '+k)
        require(x['acceptance'] and x['sources'],'empty capability '+k)
        for f in x['sources']:git(UP,'cat-file','-e',sha+':'+f['path'])
        for f in x['existing_integration_points']:git(REPO,'cat-file','-e',base+':'+f['path'])
        visit(k,set())
    catalog=(ROOT/'capability-catalog.md').read_text()
    skill_paths={f['path'] for f in inv['files'] if re.fullmatch(r'pstack/skills/[^/]+/SKILL.md',f['path'])}
    plays={f['path'] for f in inv['files'] if re.fullmatch(r'pstack/skills/poteto-mode/playbooks/[^/]+\.md',f['path'])}
    require(len(skill_paths)==58 and len(plays)==23,'source counts')
    for p in skill_paths|plays:require('/'+p+')' in catalog,'missing catalog '+p)
check('24_capabilities_acyclic_and_full_58_skill_23_playbook_mapping',capability_contract)

def acceptance():
    require(cases['executed'] is False,'future acceptance confused with results')
    require(len(cases['cases'])==48 and len({c['id'] for c in cases['cases']})==48,'case count')
    spec=(ROOT/'integration-spec.md').read_text()
    work=set(re.findall(r'^### (W\d{2})：',spec,re.M))
    require(len(work)==19,'work package count')
    for c in cases['cases']:
        require(c['status']=='specified_not_implemented','future test status')
        require(set(c['work_packages'])<=work,'unknown work package')
        require(all(c[k] for k in ['given','when','then','test_level']),'incomplete acceptance')
    graph={}
    for match in re.finditer(r'^### (W\d{2})：[^\n]+\n\n依赖：([^。]+)',spec,re.M):
        graph[match[1]]=re.findall(r'W\d{2}',match[2])
    require(len(graph)==19,'work dependency missing')
    done=set()
    def visit(k,active):
        require(k not in active,'work cycle '+k)
        require(k in graph,'unknown dependency')
        if k in done:return
        for d in graph[k]:visit(d,active|{k})
        done.add(k)
    for k in graph:visit(k,set())
    require(graph['W06']==[],'verification tooling is not first')
    require({'W17','W18'} <= set(graph['W03']),'compiler precedes usage/prototype evidence')
    require('W19' in graph['W11'],'qualification omits verification maintenance')
check('48_future_acceptance_cases_and_19_acyclic_work_packages',acceptance)

def article_traceability():
    sources=readj(E/'author-articles.json')
    articles={x['id']:x for x in sources['articles']}
    require(set(articles)=={'ART1','ART2'},'article inventory')
    require(articles['ART1']['dom_body_text_characters']==19145 and articles['ART2']['dom_body_text_characters']==19581,'article observation metadata')
    ds=readj(E/'article-design-deltas.json')
    require(ds['status']=='design_only_not_implemented','design execution status')
    require(len(ds['deltas'])==12,'delta count')
    capids={c['id'] for c in caps['capabilities']}
    caseids={c['id'] for c in cases['cases']}
    spec=(ROOT/'integration-spec.md').read_text()
    work=set(re.findall(r'^### (W\d{2})：',spec,re.M))
    for d in ds['deltas']:
        require(set(d['article_ids'])<=set(articles),'unknown article')
        require(set(d['capability_ids'])<=capids,'unknown capability')
        require(set(d['work_packages'])<=work,'unknown article work package')
        require(set(d['acceptance_ids'])<=caseids,'unknown article acceptance')
        for c in d['capability_ids']:
            row=next(x for x in caps['capabilities'] if x['id']==c)
            require(d['id'] in row['design_delta_ids'],'missing capability backlink')
        for a in d['acceptance_ids']:
            row=next(x for x in cases['cases'] if x['id']==a)
            require(d['id'] in row['design_delta_ids'],'missing acceptance backlink')
    require(caps['report_revision']==2 and cases['report_revision']==2,'revision mismatch')
    require(lock['supplemental_sources']['upstream_git_pin_unchanged'] is True,'source pin changed')
    require('本轮不创建任何定时任务' in (ROOT/'README.md').read_text(),'automation boundary missing')
    require('尚未实现' in spec,'spec presented as implementation')
check('two_primary_articles_12_design_deltas_bidirectional_traceability',article_traceability)

cache={}
def links():
    for p in ROOT.glob('*.md'):
        t=p.read_text()
        require(t.count('```')%2==0,'unclosed code fence '+p.name)
        for link in re.findall(r'\[[^\]\n]+\]\(([^)\s]+)\)',t):
            u=urlparse(link)
            if not u.scheme:
                target=(p.parent/unquote(u.path)).resolve()
                require(target.is_relative_to(ROOT),'local link escaped '+link)
                require(target.exists(),'missing link '+link)
            elif u.netloc=='github.com':
                m=re.fullmatch(r'/(cursor/plugins|osborn-studio/osstack)/(blob|tree)/([a-f0-9]{40})/(.+)',u.path)
                require(bool(m),'unpinned github link '+link)
                repo=UP if m[1]=='cursor/plugins' else REPO
                expected=sha if repo==UP else base
                require(m[3]==expected,'wrong github baseline')
                key=(str(repo),m[3],m[4])
                if key not in cache:cache[key]=git(repo,'show',m[3]+':'+m[4])
                if u.fragment:
                    n=re.fullmatch(r'L(\d+)(?:-L(\d+))?',u.fragment)
                    require(bool(n),'unsupported line anchor')
                    require(max(int(n[1]),int(n[2] or 0))<=len(cache[key].splitlines()),'line beyond file')
check('markdown_links_pinned_sources_and_fences',links)

def observed_results():
    data=readj(E/'research-checks.json')
    require(data['scratch_removed'] is True,'scratch not removed')
    require(len(data['results'])==5,'research check count')
    for x in data['results']:require(x['code']==0 and not x['timed_out'],x['id'])
    require('82 pass' in (E/'upstream-tools-tests.log').read_text(),'test log missing')
    probe=readj(E/'semantic-probes.log')
    require(probe['status']=='pass' and len(probe['probes'])==6,'probe count')
check('actual_research_results_82_tests_6_probes',observed_results)

def workspace():
    before=(E/'workspace-status-at-article-revision.txt').read_text().splitlines()
    after=git(REPO,'status','--short').decode().splitlines()
    clean=lambda lines:{x for x in lines if 'docs/reports/2026-10-26-pstack/' not in x and x.strip()}
    require(clean(before)==clean(after),'workspace path status changed outside report; inspect manually')
check('preexisting_workspace_path_status_preserved',workspace)

for p in ROOT.rglob('*'):
    if p.is_file() and p.suffix in {'.md','.json','.py','.ts','.mjs'}:
        for n,line in enumerate(p.read_text().splitlines(),1):
            require(line.rstrip()==line,f'trailing whitespace {p.name}:{n}')
checks.append({'check':'report_text_whitespace','result':'pass'})
result={'generated_at_utc':datetime.now(timezone.utc).isoformat(),'status':'pass','scope':'report_integrity_not_product_acceptance','checks':checks,'counts':{'upstream_files':200,'osstack_source_files':len(idx['files']),'skills':58,'playbooks':23,'capability_groups':24,'work_packages':19,'future_acceptance_cases':48,'author_articles_read':2,'article_design_deltas':12,'upstream_tests_passed':82,'semantic_probes_passed':6}}
(E/'report-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
