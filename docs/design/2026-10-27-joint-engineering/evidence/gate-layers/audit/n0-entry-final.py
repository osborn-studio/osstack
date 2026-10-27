from pathlib import Path
import json,subprocess,hashlib,copy,importlib.util
R=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/joint-gate-layers');D=R/'docs/design/2026-10-27-joint-engineering';O=Path(__file__).resolve().parent;SHA='380e2c618bd5060e2f556f5108fb229d169c932b'
raw=subprocess.check_output(['git','show',SHA+':docs/design/2026-10-27-joint-engineering/validate-design.py'],cwd=R)
ns={'__name__':'independent_candidate','__file__':str(D/'validate-design.py')};exec(compile(raw,str(D/'validate-design.py'),'exec'),ns)
data=ns['load']();assert (D/'validate-design.py').read_bytes()==raw
for name in ns['NAMES']:
 assert (D/name).read_bytes()==subprocess.check_output(['git','show',SHA+':docs/design/2026-10-27-joint-engineering/'+name],cwd=R),name
result=ns['validate'](data);assert result['runtime_cases_executed']==0
frozen=json.loads((O/'oracle-freeze.json').read_text())
for k in ['legacy_release_requirements','release_bindings','local_override']:
 assert data['execution-gates.json'][k]==frozen['frozen_'+k if k!='legacy_release_requirements' else 'frozen_release_requirements'],k
results=[]
def case(d,c):return next(x for x in d['acceptance-cases.json']['cases'] if x['id']==c)
def gate(d,g):return next(x for x in d['execution-gates.json']['gates'] if x['id']==g)
def mutation(label,fn):
 d=copy.deepcopy(data);fn(d);(O/('n0-entry-final-'+label+'.input.json')).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
 try: ns['validate'](d)
 except ValueError as e: results.append({'id':label,'expected':'reject','actual':'reject','error':str(e)})
 else: results.append({'id':label,'expected':'reject','actual':'ACCEPTED'})
mutation('ja01-delete',lambda d:d['acceptance-cases.json']['cases'].remove(case(d,'JA01')))
mutation('ja02-parser-only',lambda d:case(d,'JA02').update(oracle='parser spy only',layer='contract'))
mutation('ja01-completion-rename',lambda d:case(d,'JA01').update(when='request implementation_verified'))
mutation('host-case-list-drop',lambda d:gate(d,'J01.scoped').update(joint_case_requirements=['JA59','JA70']))
mutation('component-false-evidence',lambda d:gate(d,'J01.contracts').update(evidence_state='passed'))
mutation('admission-cycle',lambda d:gate(d,'J01.scoped')['requires'].append('J08.scoped'))
mutation('legacy-case-drop',lambda d:d['legacy-case-map.json']['items'].pop())
mutation('legacy-producer-drop',lambda d:d['execution-gates.json']['legacy_gate_map'].pop())
mutation('release-case-weaken',lambda d:d['execution-gates.json']['legacy_release_requirements']['every_artifact_release'].clear())
mutation('release-contract-only',lambda d:gate(d,'J27.scoped').update(requires=['J01.contracts']))
mutation('default-contract-only',lambda d:gate(d,'J27.default_enable').update(requires=['J01.contracts']))
mutation('full-contract-only',lambda d:gate(d,'J27.full_original_completion').update(requires=['J01.contracts']))
mutation('broker-enabled-override-scope',lambda d:d['execution-gates.json']['local_override'].update(scope='broker_enabled'))
mutation('broker-enabled-override-text',lambda d:d['execution-gates.json']['local_override'].update(forbidden_when='',consumer_override='home-only gate qualifies broker-enabled full legacy recovery'))

# These additional cases are post-audit regressions, not claimed prospectively frozen specifics.
for gid in ['J01.legacy_full','J10.protocol','J27.release_channel','J23.harness']:
 mutation('postaudit-old-edge-'+gid.replace('.','-'),lambda d,gid=gid:gate(d,gid).update(requires=['J01.contracts' if x=='J01.scoped' else x for x in gate(d,gid)['requires']]))
for cid in ['JA01','JA02']:
 mutation('postaudit-oracle-'+cid,lambda d,cid=cid:case(d,cid)['oracle_spec'].update(observation_boundary='parser-only result'))
def sliceof(d):return next(x for x in d['work-packages.json']['items'] if x['id']=='J08')['component_slices'][0]
mutation('postaudit-slice-extra-path',lambda d:sliceof(d)['write_paths'].append('packages/core/src/state/migrations.ts'))
mutation('postaudit-slice-effects',lambda d:sliceof(d).update(effects='dispatch'))
mutation('postaudit-obsolete-j05-coupling',lambda d:gate(d,'J08.admission_boundary')['requires'].append('J05.scoped'))
mutation('postaudit-positive-control-weaken',lambda d:case(d,'JA71').update(then='always reject admission'))
mutation('postaudit-same-entry-weaken',lambda d:case(d,'JA72').update(then='a different entry may dispatch without checks'))
mutation('postaudit-ja02-owner-spoof',lambda d:case(d,'JA02')['oracle_spec'].update(implementation_producer_work_item='J01',implementation_owner_role='contract-owner'))
mutation('postaudit-binding-rule-drop',lambda d:d['execution-gates.json'].pop('component_evidence_binding_rule'))


mutation('postaudit-e0-host-coupling',lambda d:gate(d,'J01.scoped')['requires'].append('J25.e0'))
mutation('postaudit-e0-legacy-release-coupling',lambda d:gate(d,'legacy:V06.release_channel')['requires'].append('J25.e0'))

# Final audit additions are retrospective regressions, not part of the prospective oracle.
def work(d,wid):return next(x for x in d['work-packages.json']['items'] if x['id']==wid)
mutation('postaudit-j07-graph-invalidation-drop',lambda d:work(d,'J07')['invalidates_component_evidence']['paths'].remove('packages/cli/src/graph-verification.ts'))
mutation('postaudit-j08-entry-invalidation-drop',lambda d:work(d,'J08')['invalidates_component_evidence']['paths'].remove('packages/cli/src/method-host-admission.ts'))
mutation('postaudit-j08-harness-invalidation-drop',lambda d:work(d,'J08')['invalidates_component_evidence']['paths'].remove('packages/cli/src/method-host-admission.test.ts'))
def drop_joint_json_owner(d):
 w=work(d,'J01');path='packages/protocol/src/joint-json.ts';w['write_paths'].remove(path);w['invalidates_component_evidence']['paths'].remove(path)
mutation('postaudit-j01-owner-and-invalidation-drop',drop_joint_json_owner)

# Independent graph/source comparison (does not call the candidate closure implementation).
baseline=json.loads((O/'execution-gates.json').read_text());bg={x['id']:x for x in baseline['gates']};cg={x['id']:x for x in data['execution-gates.json']['gates']}
def ancestors(graph,start):
 seen=set();todo=list(graph[start]['requires'])
 while todo:
  at=todo.pop()
  if at in seen:continue
  seen.add(at);todo.extend(graph[at]['requires'])
 return seen
impact=json.loads((D/'evidence/gate-layers/transitive-impact.json').read_text());assert impact['baseline_requires']=={k:v['requires'] for k,v in bg.items()}
new_e0=[g for g in bg if 'J25.e0' not in ancestors(bg,g) and 'J25.e0' in ancestors(cg,g)];assert not new_e0
for gid in [g for g in bg if g.startswith('legacy:')]:
 assert bg[gid]['requires']==cg[gid]['requires'],gid+' inherited safety edge changed'
 assert bg[gid].get('case_requirements')==cg[gid].get('case_requirements'),gid+' case lost'
assert cg['J05.scoped']['requires']==bg['J05.scoped']['requires']
assert cg['J05.scoped']['decision_requirements']==bg['J05.scoped']['decision_requirements']
registry=json.loads((D/'evidence/gate-layers/component-slice-specs.json').read_text());jp=next(x for x in registry['component_slices']['J08'] if x['id']=='JP-08a')
assert set(jp['write_paths'])=={'packages/cli/src/method-host-admission.ts','packages/cli/src/method-host-admission.test.ts'}
assert jp['requires']==['J01.contracts']
for w in data['work-packages.json']['items']:
 if w['id']!='J08':assert not set(jp['write_paths'])&set(w['write_paths']),w['id']+' conflicting shared ownership'
for path in registry['frozen_contract_artifacts']:subprocess.check_output(['git','cat-file','-e',SHA+':'+path],cwd=R)
assert not set(registry['frozen_contract_artifacts'])&set(registry['tracked_contract_extension_paths'])
(O/'n0-entry-final-positive-graph.json').write_text(json.dumps({'candidate_sha':SHA,'baseline_graph_exact_git_source':True,'newly_inherits_E0':new_e0,'all_original_legacy_direct_safety_edges_preserved':True,'legacy_case_requirements_unchanged':True,'J05_original_E0_value_gate_preserved':True,'unique_JP08a_paths':jp['write_paths'],'tracked_future_extensions_not_initial_prerequisites':True},indent=2)+'\n')

report={'candidate_sha':SHA,'oracle_sha256':hashlib.sha256((O/'oracle-freeze.json').read_bytes()).hexdigest(),'baseline_result':result,'source_release_semantics_equal':True,'results':results}
(O/'n0-entry-final-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2));raise SystemExit(any(x['actual']=='ACCEPTED' for x in results))
