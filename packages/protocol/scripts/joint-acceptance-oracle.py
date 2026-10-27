"""Independent standard-library wire/hash regression oracle, not a host authority.

Expectations are fixed inputs, not generated from TypeScript. This program does
not duplicate Zod semantic validation: component samples are canonicalized here;
the TypeScript matrix checks their schema and association boundaries separately.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

DOMAINS = {
    'osstack.joint.' + name for name in (
        'method-binding.v1', 'method-proposal.v1', 'support-profile.v2',
        'source-snapshot.v1', 'artifact-requirements.v1',
        'role-artifact-requirements.v1', 'check-binding.v1', 'intent.v1',
        'method-recipe.v1', 'method-input.v1', 'environment.v1', 'scenario.v1',
        'check-registry.v1', 'schema-spec.v1', 'recovery-subject.v1',
        'trial-root.v1', 'recovery-request-input.v1', 'trial-consumption-input.v1',
        'source-content.v1', 'source-inspection.v1',
    )
}


def require(condition, label):
    if not condition:
        raise ValueError(label)


def invalid(_value=None):
    raise ValueError('INVALID_JOINT_JSON')


def integer(raw):
    value = int(raw)
    if raw == '-0' or abs(value) > 9007199254740991:
        invalid()
    return value


def pairs(items):
    value = {}
    for key, item in items:
        if key in value or not key.isascii():
            invalid()
        value[key] = item
    return value


def validate(value, depth=0):
    if depth > 64:
        invalid()
    if isinstance(value, str):
        if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            invalid()
    elif isinstance(value, dict):
        for key, item in value.items():
            if not key.isascii():
                invalid()
            validate(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            validate(item, depth + 1)


def parse_wire(raw):
    try:
        if len(raw) > 1048576 or raw.startswith(b'\xef\xbb\xbf'):
            invalid()
        text = raw.decode('utf-8', errors='strict')
        value = json.loads(text, object_pairs_hook=pairs, parse_int=integer,
                           parse_float=invalid, parse_constant=invalid)
        validate(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        invalid()


def canonical(value):
    validate(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(domain, value):
    if domain not in DOMAINS:
        raise ValueError('UNKNOWN_JOINT_DIGEST_DOMAIN')
    return hashlib.sha256((domain + '\n' + canonical(value)).encode('utf-8')).hexdigest()


def project(case):
    value = copy.deepcopy(case['input'])
    helper = case['helper']
    if helper == 'bindingDigest':
        del value['binding_digest']
        value['role_materials'].sort(key=lambda row: row['role'])
    elif helper == 'schemaSpecDigest':
        del value['kind']
        del value['schema_version']
        value['expected_lineage_tables'].sort()
    elif helper == 'sourceSnapshotDigest':
        value['files'].sort(key=lambda row: row['path'].encode('utf-8'))
    elif helper == 'checkRegistryDigest':
        value['entries'].sort(key=lambda row: row['ref'])
    return value


def check(fixture):
    require(set(fixture['domains']) == DOMAINS, 'domain registry drift')
    wire = []
    for case in fixture['wire_cases']:
        try:
            value = parse_wire(bytes.fromhex(case['bytes_hex']))
        except ValueError as error:
            require(not case['accepted'], case['id'] + ': unexpected rejection')
            require(str(error) == case['error'], case['id'] + ': wrong error')
            wire.append({'id': case['id'], 'accepted': False, 'error': str(error)})
            continue
        require(case['accepted'], case['id'] + ': unexpected acceptance')
        text = canonical(value)
        hashes = {domain: digest(domain, value) for domain in fixture['domains']}
        require(text == case['canonical'], case['id'] + ': canonical mismatch')
        require(hashes == case['hashes'], case['id'] + ': digest mismatch')
        wire.append({'id': case['id'], 'accepted': True, 'canonical': text, 'hashes': hashes})
    helpers = []
    for case in fixture['helper_cases']:
        prefix = 'trial-' if case['helper'] == 'trialRootEffectId' else ''
        result = prefix + digest(case['domain'], project(case))
        require(result == case['expected'], case['id'] + ': helper digest mismatch')
        helpers.append({'id': case['id'], 'digest': result})
    return {'wire': wire, 'helpers': helpers,
            'components': [{'kind': row['kind'], 'canonical': canonical(row['sample']),
                            'sha256': hashlib.sha256(canonical(row['sample']).encode('utf-8')).hexdigest()}
                           for row in fixture['component_matrix']],
            'authority': 'component_regression_only'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', type=Path, default=Path(__file__).resolve().parents[1] / 'fixtures/joint/acceptance-oracle.json')
    args = parser.parse_args()
    try:
        # The fixture itself also enters through the strict decoder.
        print(json.dumps(check(parse_wire(args.fixture.read_bytes())), ensure_ascii=False))
    except (ValueError, OSError) as error:
        raise SystemExit('FAIL: ' + str(error))
