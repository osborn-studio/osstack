from pathlib import Path
import subprocess,json,hashlib,datetime
W=Path('/Volumes/AIMATE_WORK/Developer/CodeX/.worktrees/osstack/pr306-control');R=Path(__file__).parent
base='6c9a3e8f11f2664f15b4ce4a26c5014d68fdcd4b';head='5744e8999da71d181b3cdd0bd339a47a95c04c6f'
def git(*args):return subprocess.check_output(['git',*args],cwd=W)
def save(n,b):(R/n).write_bytes(b)
def sha(b):return hashlib.sha256(b).hexdigest()
status=git('status','--porcelain=v1');save('working-status.txt',status)
paths=git('diff','--name-only',base,head).decode().splitlines();save('committed-name-status.txt',git('diff','--name-status',base,head));save('committed-stat.txt',git('diff','--stat',base,head));save('pending-control.diff',git('diff','--','docs'))
core=['.github/workflows/ci.yml','package.json','packages/github/src/index.ts','packages/github/src/pr-candidate-snapshot.ts','packages/github/src/pr-candidate-snapshot.test.ts','scripts/report-pr-candidate.mjs','scripts/report-pr-candidate.test.mjs','osstack-methods-skill/references/pr-readiness.md']
assert set(p for p in paths if not p.startswith('docs/'))==set(core)
save('source-ci.diff',git('diff',base,head,'--',*core))
bp=json.loads(git('show',base+':package.json'));hp=json.loads(git('show',head+':package.json'))
assert {k:v for k,v in bp.items()if k!='scripts'}=={k:v for k,v in hp.items()if k!='scripts'}
assert set(hp['scripts'])-set(bp['scripts'])=={'test:pr-candidate','inspect:pr-candidate'}
assert all(hp['scripts'][k]==v for k,v in bp['scripts'].items())
assert git('diff',base,head,'--','pnpm-lock.yaml','pnpm-workspace.yaml','packages/*/package.json')==b''
changesets=git('ls-tree','-r','--name-only',head,'.changeset').decode().splitlines()
coverage=[p for p in changesets if p.endswith('.md') and b'@osstack/github' in git('show',head+':'+p)]
assert coverage==[]
meta={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'base':base,'head':head,'head_tree':git('rev-parse',head+'^{tree}').decode().strip(),'files_changed':len(paths),'source_ci_paths':core,'documentation_paths':[p for p in paths if p.startswith('docs/')],'dependency_delta':{'root_non_scripts_fields_changed':False,'lockfile_changed':False,'workspace_or_package_manifests_changed':False,'new_scripts':{k:hp['scripts'][k]for k in set(hp['scripts'])-set(bp['scripts'])}},'release_coverage':{'public_package':'@osstack/github','matching_existing_changesets':coverage,'finding':'Missing changeset at this pinned head; release-sensitive src/index export changes meet existing coverage rule. Static code inspection, not executed CI.'},'working_tree_status_at_read':status.decode(),'scope':'Pinned committed diff plus separately preserved pending control-doc snapshot; not a final published-head verification.','no_execution':['No full/targeted tests, model calls, forge writes, repository edits.'],'source_hashes':[{'path':p,'sha256':sha(git('show',head+':'+p))}for p in core]}
save('report.json',(json.dumps(meta,indent=2)+'\n').encode())
(R/'report.md').write_text('''# Publication scope review (provisional)

Pinned committed candidate **5744e8999da71d181b3cdd0bd339a47a95c04c6f**, compared directly with actual main **6c9a3e8f11f2664f15b4ce4a26c5014d68fdcd4b**. This is not the future PR307 published head. Root has pending control/evidence edits; their state is recorded separately and must be rebound after final commit.

## Scope

All 8 non-documentation changed paths are the agreed tool and wiring: GitHub collector plus its tests/index exports, standalone report CLI plus tests, package scripts, one offline CI step, and the existing pr-readiness reference. No unrelated runtime, DB, daemon, provider or global configuration path changed. Remaining committed paths are joint control ledgers and PR305/306 publication/validation evidence plus new tool documentation.

Collector imports existing zod and defaultDeliveryCommandRunner; all constructed forge commands use fixed `gh api graphql` read queries. CLI imports the built collector dynamically and writes only acquired report outputs. Existing delivery implementation is unchanged. This is a scope inspection, not a new comprehensive safety or behavior audit.

Root package.json adds only `test:pr-candidate` and `inspect:pr-candidate`. CI adds only `Read-only PR snapshot contracts (offline)` running the former; no existing gate or matrix removed/relaxed, and no live forge query added to CI. The package's normal Vitest test file remains covered by the existing full suite.

No dependency declarations, lockfile or package manifests changed. Method count remains unchanged; pr-readiness gains the actual checkout command and explicit limits (report exit0 is not a Ready verdict).

## Confirmed prepublication gap

At this pinned head, no `.changeset/*.md` mentions public **@osstack/github**. Existing `scripts/check-changeset-coverage.mjs` treats its new src implementation/index export as release-sensitive and requires a matching changeset. Add a scoped release entry before publication, then bind that new head separately. This finding is based on actual source/changeset inspection; the coverage script was not executed in this read-only task.

The diff includes prior PR305/306 CI/board/archive evidence, so it is larger than the new feature code alone. Those artifacts are in agreed control/documentation locations; this task has not independently revalidated their entire archive contents. Original full-independent evidence remains unchanged. No source edits, test/model execution or forge mutations occurred.
''')
files=[{'path':f.name,'bytes':f.stat().st_size,'sha256':sha(f.read_bytes())}for f in sorted(R.iterdir())if f.is_file() and f.name!='manifest.json'];save('manifest.json',(json.dumps({'files':files},indent=2)+'\n').encode())
print(json.dumps({'changed':len(paths),'report_sha256':sha((R/'report.json').read_bytes()),'manifest_sha256':sha((R/'manifest.json').read_bytes())}))
