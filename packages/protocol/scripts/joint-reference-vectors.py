"""Verify independent reference vectors; optional J11 SQL/catalog verification.
No TypeScript implementation is loaded. Inputs are frozen in reference-vectors.json.
"""
import argparse, copy, hashlib, json
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--check',action='store_true')
parser.add_argument('--recovery-root',type=Path)
args=parser.parse_args()
def require(condition,message):
    if not condition:raise SystemExit('FAIL: '+message)
root=Path(__file__).resolve().parents[1]
canon=lambda obj:json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def digest(domain,obj):return hashlib.sha256((domain+'\n'+canon(obj)).encode()).hexdigest()
path=root/'fixtures/joint/reference-vectors.json'
output=json.loads(path.read_text())
for vector in output['vectors']:
    value=copy.deepcopy(vector['input']); helper=vector['helper']; prefix=''
    if helper=='bindingDigest':
        value.pop('binding_digest'); value['role_materials'].sort(key=lambda r:r['role'])
    elif helper=='schemaSpecDigest':
        value.pop('kind'); value.pop('schema_version'); value['expected_lineage_tables'].sort()
    elif helper=='trialRootEffectId':prefix='trial-'
    elif helper not in ['recoverySubjectDigest','recoveryRequestInputDigest','trialConsumptionInputDigest']:raise ValueError(helper)
    expected=prefix+digest(vector['domain'],value)
    if args.check:require(vector['expected']==expected,helper)
    else:vector['expected']=expected
if args.recovery_root:
    recovery=args.recovery_root
    manifest=json.loads((recovery/'manifest.json').read_text())
    for key,name in [('ddl_digest','bootstrap.sql'),('fixture_digest','source-hold.sql')]:
        require(manifest['spec'][key]==hashlib.sha256((recovery/name).read_bytes()).hexdigest(),key)
    for key in ['source','target']:
        require(manifest['spec'][key+'_schema_digest']==hashlib.sha256(canon(manifest[key+'_schema']).encode()).hexdigest(),key+'_schema_digest')
    frozen=next(v for v in output['vectors'] if v['helper']=='schemaSpecDigest')
    require(frozen['input']==manifest['spec'],'frozen spec input')
    require(frozen['expected']==manifest['schema_spec_digest'],'schema spec digest')
    require(manifest['future_storage_digest']==hashlib.sha256((recovery/'future-storage.sql').read_bytes()).hexdigest(),'future storage digest')
if not args.check:path.write_text(json.dumps(output,indent=2,ensure_ascii=False)+'\n')
print('independent vectors verified'+('; raw DDL/catalog hashes verified' if args.recovery_root else ''))
