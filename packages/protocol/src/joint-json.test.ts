import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJointJson, jointDigest, parseJointJson, parseJointJsonBytes } from './joint-json.js';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/joint/digest-vectors.json', import.meta.url), 'utf8')).vectors as Array<{
  id: string; valid: boolean; domain: string; input: unknown; canonical_json: string; sha256: string; raw_json: string;
}>;
describe('joint-canonical-v1', () => {
  for (const vector of vectors) {
    it(vector.id, () => {
      if (!vector.valid) { expect(() => parseJointJson(vector.raw_json)).toThrow(); return; }
      expect(canonicalJointJson(vector.input)).toBe(vector.canonical_json);
      expect(jointDigest(vector.domain, vector.input)).toBe(vector.sha256);
    });
  }
  it('checks duplicate decoded keys before JSON.parse can discard them', () => {
    expect(() => parseJointJson('{"a":1,"\\u0061":2}')).toThrow();
  });
  it('sorts numeric-looking keys lexically, not JS insertion order', () => {
    expect(canonicalJointJson(parseJointJson('{"2":2,"10":10}'))).toBe('{"10":10,"2":2}');
  });
  it('retains __proto__ as data without changing the prototype', () => {
    expect(canonicalJointJson(parseJointJson('{"__proto__":{"x":1}}'))).toBe('{"__proto__":{"x":1}}');
  });
  it.each(['1e0', '01', 'true false', '[1,]', '{"a":1,}', '{"a":NaN}', '{"é":1}', '"\ud800"'])('rejects %s', raw => {
    expect(() => parseJointJson(raw)).toThrow();
  });
  it('rejects non-JSON JS values, holes, getters and cycles', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [undefined, NaN, -0, 1n, new Date(), Array(2), { get x() { throw Error('must not read'); } }, cycle]) {
      expect(() => canonicalJointJson(value)).toThrow();
    }
  });
  it('bounds raw bytes and nesting', () => {
    expect(() => parseJointJson(' '.repeat(1_048_577))).toThrow();
    expect(() => parseJointJson('['.repeat(65) + '0' + ']'.repeat(65))).toThrow();
  });
  it('rejects an unregistered digest domain', () => {
    expect(() => jointDigest('osstack.joint.trial-profile.v1', {})).toThrow();
  });
});
it('enforces the audited vector categories', () => {
  expect(vectors.filter(v=>v.valid)).toHaveLength(24);
  expect(vectors.filter(v=>!v.valid)).toHaveLength(5);
});
it('bounds expansion of shared object DAGs before allocating an exponential result', () => {
  let value: unknown = 'x'; for(let i=0;i<60;i++) value=[value,value];
  expect(()=>canonicalJointJson(value)).toThrow('INVALID_JOINT_JSON');
});

it('rejects malformed UTF-8 and BOM before text parsing', () => {
  for(const bytes of [new Uint8Array([34,0xc0,0xaf,34]),new Uint8Array([0xef,0xbb,0xbf,123,125])]) expect(()=>parseJointJsonBytes(bytes)).toThrow();
  expect(parseJointJsonBytes(new TextEncoder().encode('{"a":1}'))).toEqual({a:1});
});
