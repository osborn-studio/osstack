#!/usr/bin/env python3
"""Freeze/check offline broker bytes. Never opens a file-backed or serving database."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parent
BASE = 'd3fa7ef681efc79a5fb2dff92172ef1be0978774'

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()

def generate():
    assert sha((ROOT/'oracle-freeze.json').read_bytes()) == '51b34e498292099fa706ecb1f8fe0eccf5f505e715fcae9c880607ad77670c79', 'oracle criteria bytes changed'
    ddl = (ROOT / 'schema.sql').read_bytes()
    fixture = (ROOT / 'held-orphan.sql').read_bytes()
    with sqlite3.connect(':memory:') as db:
        assert sqlite3.sqlite_version_info >= (3,37,0), 'SQLite STRICT support required'
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript(ddl.decode())
        db.executescript(fixture.decode())
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        catalog = [dict(zip(('type', 'name', 'tbl_name', 'sql'), row)) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' ORDER BY type,name")]
        assert db.execute('PRAGMA user_version').fetchone()[0] == 1
        assert db.execute("SELECT state,recovery_revision FROM broker_leases").fetchall() == [('held_orphan', 0)]
    spec = dict(kind='migration_spec', schema_version=1, schema_change_id='broker-dedicated-recovery-candidate-v1', source_schema=0, target_schema=1,
                ddl_digest=sha(ddl), fixture_digest=sha(fixture), source_schema_digest=sha('[]'), target_schema_digest=sha(canonical(catalog)),
                expected_lineage_tables=sorted(x['name'] for x in catalog if x['type']=='table'))
    digest_body = {key: value for key, value in spec.items() if key not in ('kind', 'schema_version')}
    manifest = dict(status='candidate_spec_only', base_commit=BASE,
        storage=dict(deployment='dedicated_sqlite', decision_status='proposed_for_adoption', namespace='osstack.resource-broker', allocation='not_reserved', deployment_qualified=False, runtime_registered=False, actual_deployment_path=None),
        spec=spec, schema_spec_digest=sha('osstack.joint.schema-spec.v1\n'+canonical(digest_body)),
        source_catalog=[], target_catalog_file='catalog.json', qualification=dict(J11_scoped='not_asserted', J17_schema_spec='not_asserted', J17_recovery='not_run', file_backed_crash_recovery='not_run', authenticated_operator='not_run'),
        dependencies=dict(candidate_material_requires=['joint recovery contracts'], schema_qualification_requires=['J11.scoped'], recovery_qualification_requires=['J17.schema_spec','J12.scoped'], runtime_storage_requires=['J14.scoped','J12.scoped','J17.recovery'], recovery_requires_runtime_controller=False),
        oracle_prefreeze=dict(path='oracle-freeze.json', claim='prospective_criteria_only_not_candidate_qualification', frozen_at='2026-10-27T16:16:01Z', sha256='51b34e498292099fa706ecb1f8fe0eccf5f505e715fcae9c880607ad77670c79', identity_independence_certified=False),
        paths=['packages/core/fixtures/broker-recovery/**','packages/core/src/state/broker-recovery-spec.test.ts','docs/design/broker-recovery-schema.md','docs/implementation/joint-broker-spec/**'])
    return {'catalog.json': catalog, 'manifest.json': manifest}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check', action='store_true');args=parser.parse_args()
    for name,value in generate().items():
        encoded=json.dumps(value, ensure_ascii=False, indent=2)+'\n'
        if args.check:
            if (ROOT/name).read_bytes()!=encoded.encode('utf-8'):raise SystemExit(f'{name}: stale candidate bytes')
        else:(ROOT/name).write_bytes(encoded.encode('utf-8'))
    print('broker candidate bytes verified' if args.check else 'broker candidate bytes frozen; no gate or deployment qualification')

if __name__=='__main__':main()
