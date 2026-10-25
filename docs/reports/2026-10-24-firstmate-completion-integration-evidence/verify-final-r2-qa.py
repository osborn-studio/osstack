import json,pathlib,subprocess
r=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/smoke/firstmate-completion-20261024');repo=pathlib.Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-completion-final')
x=json.loads((r/'final-r2-qa-results.json').read_text())
assert x['head']==subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'source HEAD changed'
subprocess.run(['git','diff','--exit-code','HEAD','--','packages',':!packages/knowledge/dist/**'],cwd=repo,check=True,stdout=subprocess.DEVNULL)
assert len(x['checks'])==8 and all(c['exit_code']==0 for c in x['checks']), 'local qualification stage failed'
print('Eight final integrated local checks passed on unchanged HEAD; Claude post-fix audit and real-environment qualification remain separate.')
