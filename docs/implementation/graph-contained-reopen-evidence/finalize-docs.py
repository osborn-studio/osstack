from pathlib import Path
import json,re,hashlib,subprocess,shutil
root=Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation'); original=Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack'); out=Path('/Volumes/AIMATE_WORK/tmp/g25-reopen')
load=lambda p: json.loads(p.read_text())
sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
loop=load(out/'acceptance-result.json');task=loop['completedTasks'][0]
assert loop['executedTaskCount']==1 and loop['skippedTaskCount']==0 and task['outcome']=='escalated'
assert len(task['verify_commands'])==10 and sum(x['exit_code']==0 for x in task['verify_commands'])==9
recheck=load(out/'recheck-result.json'); final=recheck['completedTasks'][0]
assert recheck['executedTaskCount']==1 and recheck['skippedTaskCount']==0 and final['outcome']=='success'
assert len(final['verify_commands'])==2 and all(x['exit_code']==0 for x in final['verify_commands'])
assert load(out/'retained-evidence-result.json')['passed']
counts=[int(x) for x in re.findall(r'Tests\s+(\d+) passed', (out/'accepted-full-tests.txt').read_text())]
assert len(counts)==22
matrix=load(out/'matrix.json');assert matrix['passed'] and matrix['sourceUnchanged'] and matrix['artifactsUnchanged']
assert all(x['passed'] for x in matrix['runs'])
for name in ['kimi-reopen','kimi-final-2']:
    payload=load(out/(name+'-result.json'))[-1]['payload'];review=payload['review']
    assert payload['status']=='completed' and review['verdict']=='approved' and all(j['pass'] for j in review['judgments'])
    assert review['runtime_identity']['model_id']=='kimi-code/k3'
assert load(out/'real-final.json')['passed'] and len(load(out/'real-final.json')['checks'])==6
assert '12 passed' in (out/'accepted-candidate.txt').read_text()
assert load(out/'ledger-crash-result.json')['passed']
assert '3 passed' in (out/'accepted-reopen.txt').read_text()
assert all(sha(root/p)==v for p,v in load(out/'accepted-source-hashes.json').items())
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert subprocess.check_output(['git','log','-1','--format=%s'],cwd=root,text=True).strip()=='feat(graph): reopen contained tests from fenced action journals'
validation=f"实际 OSStack Loop `{loop['loop_id']}` 完成 22 个包、{sum(counts):,} 项测试，9/10 项 verifier 通过；唯一失败是本轮 harness 漏建 real-evidence 目录，10 个真实容器链用例写报告时 ENOENT。补建目录后，新 Loop `{recheck['loop_id']}` 重跑 12 项受影响的真实测试，执行 1、跳过 0、outcome=success，2 项 verifier（恢复测试、既有证据哈希核验）通过。第一次 escalated 记录原样保留，没有改写为成功，也没有无理由重跑已通过的全套测试。固定 seed {matrix['seed']}/{matrix['seed']+1} 故障矩阵共 {sum(len(x['tests']) for x in matrix['runs'])} 次测试执行，{len(matrix['sourceHashes'])} 个源文件及构建产物哈希前后一致并在补验时再次核对。本轮共满足原定 10 类验证，包含既有 6 项真实容器故障检查、12 项候选/完整 GraphDelivery 容器链检查、3 项新恢复检查；另有独立的账本绑定 SIGKILL 场景。"

report=(out/'report-draft.md').read_text().replace('__VALIDATION__',validation).replace('__AUDIT__','两次有效的实际 Kimi K3 源码审查均为 `approved`，各五项 criteria 全通过，reported model 为 `kimi-code/k3`。一次补充审查因 rule_id 不符合 schema 被严格拒绝，不计通过；同模型重试后通过。源代码、审查输入/输出、失败记录及验证日志保存在 [本轮证据](../implementation/graph-contained-reopen-evidence/admission.json)。')
report+=f'\n源码提交：`{commit}`。\n'
reportPath=root/'docs/reports/graph-contained-reopen-validation.md';reportPath.write_text(report)
handoffPath=root/'docs/implementation/2026-09-17-graph-reopen-next-context.md';handoffPath.write_text((out/'handoff-draft.md').read_text().replace('__COMMIT__',commit).replace('__VALIDATION__',validation))
rel='docs/implementation/graph-contained-reopen-evidence';dest=root/rel;dest.mkdir(parents=True,exist_ok=True)
files=['acceptance.mjs','acceptance-command.mjs','acceptance-result.json','acceptance-LOOP-STATE.json','acceptance-STATE.md','acceptance.log','accepted-source-hashes.json','build-child.mjs','reopen-child.mjs','ledger-crash-probe.mjs','ledger-crash-result.json','ledger-crash.txt','real-reopen.txt','core-focused.txt','focused-first.txt','focused.txt','build.txt','typecheck-final.txt','matrix.json','real-final.json','kimi-audit.mjs','finalize-docs.py','report-draft.md','handoff-draft.md','candidate-first-failed.txt','recheck.mjs','recheck-result.json','recheck-LOOP-STATE.json','recheck-STATE.md','recheck.log','retained-evidence.mjs','retained-evidence-result.json']
files += sorted(p.name for p in out.glob('accepted-*.txt'))
files += sorted(p.name for p in out.glob('kimi-*-*.json')) + sorted(p.name for p in out.glob('kimi-*-*.jsonl')) + sorted(p.name for p in out.glob('kimi-*.log'))
for name in set(files):
    assert (out/name).is_file(),name
    shutil.copy2(out/name,dest/name)
shutil.copytree(out/'matrix.json.evidence',dest/'matrix.json.evidence',dirs_exist_ok=True)
shutil.copytree(out/'real-evidence',dest/'real-evidence',dirs_exist_ok=True)
# No DB, home, socket, node_modules, VM data or Docker config is copied.
(dest/'.gitattributes').write_text('*.txt -whitespace\n*.log -whitespace\n*.jsonl -whitespace\n*-STATE.md -whitespace\n')
admission={'schemaVersion':1,'date':'2026-09-17','status':'passed_bounded_slice','scope':'Host-only per-action contained tests journal reopening; no business settlement, worker stop, resource release or takeover authority','productionReady':False,'taskStatus':'in_progress','completedTaskCount':25,'totalTaskCount':30,'acceptedCodeCommit':commit,'loop':{'id':loop['loop_id'],'executed':1,'skipped':0,'outcome':'escalated','tests':sum(counts),'packages':len(counts),'verifiersPassed':9,'verifiersTotal':10,'failure':'missing report directory ENOENT'},'recheckLoop':{'id':recheck['loop_id'],'executed':1,'skipped':0,'outcome':'success','executionTests':12,'verifiersPassed':2},'distinctCheckGroupsSatisfied':10,'matrix':{'testExecutions':sum(len(x['tests']) for x in matrix['runs']),'seed':matrix['seed'],'repeat':matrix['repeat'],'sourceUnchanged':True,'artifactsUnchanged':True},'realChecks':{'existingExecutorFaults':6,'candidateAndDelivery':12,'reopeningTests':3,'independentLedgerBoundSigkillScenario':True},'audits':{'model':'kimi-code/k3','validApproved':['kimi-reopen','kimi-final-2'],'rejectedSchemaAttempt':'kimi-final'},'limitations':['No Graph worker quiescence attestation','No all-admission executor inventory','No business result inference or G15 settlement','No release or takeover','Concurrent stop may conservatively fail; not coalesced','Whole suite macOS Node26; Linux containers only; no Node20/22 admission']}
(dest/'admission.json').write_text(json.dumps(admission,ensure_ascii=False,indent=2)+'\n')
(dest/'review-adjudication.md').write_text('''# Kimi K3 审查判定

两次有效审查 approved，五项 criteria 均通过。`kimi-final` 的 rule_id schema 错误被边界拒绝，保留记录、不计通过；`kimi-final-2` 为新的一次真实模型审查。

首轮信息项：conditional child / real daemon 覆盖已通过本轮显式环境与独立 SIGKILL 探针实际执行；并发 stop 未作合并，竞争者保守错误不会授权结算/释放，该用例随整图 G15 集成补测。第二次审查的原始信息项见完整 result.json；没有隐藏、改写或将审查器的失败转成通过。

本轮只批准单动作 journal 重建与精确容器停止，不批准 G25 整体完成或生产恢复。
''')
plan=root/'docs/implementation/2026-09-13-osstack-graph-upgrade.tasks.json';data=load(plan);g25=next(x for x in data['tasks'] if x['id']=='G25');assert g25['status']=='in_progress'
for p in ['packages/core/src/state/graph-recovery.ts','packages/core/src/state/graph-recovery.test.ts','packages/cli/src/graph-contained-recovery.ts','packages/cli/src/graph-contained-recovery.test.ts','docs/reports/graph-contained-reopen-validation.md']:
    if p not in g25['files']:g25['files'].append(p)
g25['progressNote']='第五阶段已验收：由原子action/admission/historical owner与canonical journal重建单个contained tests，当前权限与完整fence重复核验；真实独立进程与SIGKILL场景通过，仍保留unknown/held。整图worker/全部执行器停止、G15业务对账、精确释放、artifact锁与完整矩阵仍待完成。'
for p in ['docs/reports/graph-contained-reopen-validation.md','docs/implementation/2026-09-17-graph-reopen-next-context.md',rel+'/admission.json']:
    if p not in g25['evidence']:g25['evidence'].append(p)
data['updatedAt']='2026-09-17';data['implementation'].update({'acceptedCodeCommit':commit,'report':'docs/reports/graph-contained-reopen-validation.md','reviewNote':f'实际Kimi K3两次有效审查approved；真实Loop {sum(counts)} 测试通过；报告目录缺失导致首轮9/10检查通过，补验Loop成功并以哈希确认原证据有效，最终满足10类验证。单动作journal重建限定阶段，G25整体/G15整图恢复未准入。'})
assert sum(x['status']=='completed' for x in data['tasks'])==25
plan.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
p=root/'docs/implementation/2026-09-13-osstack-graph-upgrade.md';s=p.read_text();needle='G00–G24 已完成，**25/30；C7 本地限定准入通过，M0–M2 完成，M3 实施中**。';assert needle in s
pos=s.rindex(needle);s=s[:pos]+needle+'G25 已完成按账本重建单个受控容器执行器与独立进程精确停止，实际 Kimi K3 两次有效审查通过；按 [G25 最新接续上下文](2026-09-17-graph-reopen-next-context.md) 继续原 Graph worker/全部执行器停止证明、G15 业务对账、精确资源释放及 artifact 锁恢复，随后完成兼容、发行、性能与试点。\n';p.write_text(s)
# Mirror only owned docs after verifying the original checkout was not changed concurrently.
for name,value in load(out/'original-before.json').items(): assert sha(original/name)==value,name
owned=['docs/implementation/2026-09-13-osstack-graph-upgrade.md','docs/implementation/2026-09-13-osstack-graph-upgrade.tasks.json',str(reportPath.relative_to(root)),str(handoffPath.relative_to(root))]+[str(p.relative_to(root)) for p in dest.rglob('*') if p.is_file()]
for name in owned:
    target=original/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,target);assert sha(root/name)==sha(target)
assert sha(original/'AGENTS.md')==load(out/'original-before.json')['AGENTS.md']
(out/'mirrored-docs.json').write_text(json.dumps(owned,indent=2)+'\n')
print(json.dumps({'tests':sum(counts),'matrix':admission['matrix'],'sourceCommit':commit,'mirroredFiles':len(owned)},indent=2))
