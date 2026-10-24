from pathlib import Path
import json,hashlib,subprocess,shutil
repo=Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack');e=repo/'docs/reports/2026-10-23-firstmate-development-evidence';root=Path('/Volumes/AIMATE_WORK/tmp/osstack/smoke/firstmate-development-20261023')
patterns=['packages/core/src/attention.ts','packages/core/src/state/attention*.ts','packages/cli/src/attention*.ts','packages/cli/src/supervision-service.ts','packages/cli/src/daemon-lock-ownership.test.ts','packages/cli/src/daemon-startup-ownership.test.ts','packages/cli/src/daemon-loop-recovery-preservation.test.ts','packages/loop/src/loop-worktree-preservation.test.ts','packages/supervisor/src/attention*.ts','packages/github/src/attention*.ts','packages/protocol/src/attention*.ts','packages/protocol/schemas/attention*.json','packages/protocol/fixtures/*/attention*.json']
files=set()
for pattern in patterns:files.update(str(p.relative_to(repo)) for p in repo.glob(pattern))
files.update(['packages/core/src/index.ts','packages/core/src/state/migrations.ts','packages/core/src/state/session-continuations.ts','packages/cli/src/bin.ts','packages/cli/src/daemon.ts','packages/cli/src/daemon-lock.ts','packages/cli/src/daemon-loop.test.ts','packages/cli/src/daemon-daily.test.ts','packages/cli/src/collaborator-rpc.test.ts','packages/cli/src/session-rpc.test.ts','packages/loop/src/loop-engine.ts','packages/loop/src/loop-engine.test.ts','packages/github/src/index.ts','packages/supervisor/src/index.ts','packages/protocol/src/index.ts','packages/protocol/src/generate.ts','packages/protocol/src/protocol.test.ts','packages/protocol/src/schemas.test.ts'])
manifest={'baseline_head':'b476bcc3fbbfcc11953abd3d154e59f7f85c4660','note':'Hashes of tested working-tree sources. core index includes pre-existing scratch export; that hunk is not part of this change. Tests run against existing user WIP, not a clean checkout.','files':[{'path':f,'sha256':hashlib.sha256((repo/f).read_bytes()).hexdigest()} for f in sorted(files)]}
(e/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/'own-source-files.json').write_text(json.dumps(sorted(files),indent=2))
for f in ['harness-cancel.json','harness-hooks.jsonl','pilot.py','gates.py','gates-native-retry.py']:
 shutil.copyfile(root/f,e/f)
