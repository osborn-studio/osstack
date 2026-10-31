import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as joint from './joint.js';
import { SourcePinShape } from './joint-shapes.js';
import * as source from './source.js';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/joint/digest-vectors.json', import.meta.url), 'utf8')).vectors as Array<{
  valid: boolean; domain: string; input: unknown; canonical_json: string; sha256: string; raw_json: string;
}>;
const pin = { kind: 'source_pin', schema_version: 1, repository: 'repo', commit: 'a'.repeat(40), subdir: '.',
  content_sha256: 'b'.repeat(64), license_refs: ['sha256:' + 'c'.repeat(64)] };
const file = (path: string) => ({ path, mode: '100644', blob: 'd'.repeat(40) });

describe('neutral source contracts', () => {
  it('keeps the joint subpath on the same contract objects', () => {
    expect(joint.SourcePin).toBe(source.SourcePin);
    expect(joint.SourceSnapshot).toBe(source.SourceSnapshot);
    expect(joint.sourceSnapshotDigest).toBe(source.sourceSnapshotDigest);
    expect(SourcePinShape).toBe(source.SourcePinShape);
  });
  it('produces the pinned joint vectors without the joint registry', () => {
    for (const v of vectors.filter(v => v.valid)) {
      expect(source.canonicalJson(v.input)).toBe(v.canonical_json);
      expect(source.domainDigest(v.domain, v.input)).toBe(v.sha256);
    }
    const snapshot = { kind: 'source_snapshot', schema_version: 1, pin, files: [file('z'), file('a')], dependencies: [] };
    expect(source.sourceSnapshotDigest(snapshot)).toBe(joint.jointDigest('osstack.joint.source-snapshot.v1', { ...snapshot, files: [file('a'), file('z')] }));
    for (const domain of ['osstack.joint.source-content.v1', 'osstack.joint.source-inspection.v1'])
      expect(source.sourceDigest(domain, { pin })).toBe(joint.jointDigest(domain, { pin }));
  });
  it('accepts only source digest domains and keeps each subpath error code', () => {
    expect(() => source.sourceDigest('osstack.joint.method-binding.v1', {})).toThrow('UNKNOWN_SOURCE_DIGEST_DOMAIN');
    const invalid = vectors.find(v => !v.valid)!;
    expect(() => source.parseCanonicalJson(invalid.raw_json)).toThrow('INVALID_CANONICAL_JSON');
    expect(() => joint.parseJointJson(invalid.raw_json)).toThrow('INVALID_JOINT_JSON');
    expect(() => source.canonicalJson(-0)).toThrow('INVALID_CANONICAL_JSON');
    expect(() => joint.canonicalJointJson(-0)).toThrow('INVALID_JOINT_JSON');
    expect(() => joint.jointDigest('osstack.joint.intent.v1', -0)).toThrow('INVALID_JOINT_JSON');
  });
  it('loads the source subpath without joint method contracts', () => {
    const code = "const s = await import('@osstack/protocol/source'); if ('decodeJointContract' in s || 'MethodBinding' in s || typeof s.sourceSnapshotDigest !== 'function') process.exit(1); console.log('ok');";
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('../', import.meta.url), encoding: 'utf8' }).trim()).toBe('ok');
  });
});
