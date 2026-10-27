import { createHash } from 'node:crypto';

export type JointJson = null | boolean | number | string | JointJson[] | { [key: string]: JointJson };
const MAX_BYTES = 1_048_576;
const MAX_DEPTH = 64;
export const JOINT_DIGEST_DOMAINS = Object.freeze([
  'method-binding.v1', 'method-proposal.v1', 'support-profile.v2', 'source-snapshot.v1',
  'artifact-requirements.v1', 'role-artifact-requirements.v1', 'check-binding.v1', 'intent.v1',
  'method-recipe.v1', 'method-input.v1', 'environment.v1', 'scenario.v1', 'check-registry.v1',
  'schema-spec.v1', 'recovery-subject.v1', 'trial-root.v1',
  'recovery-request-input.v1', 'trial-consumption-input.v1',
  'source-content.v1', 'source-inspection.v1',
].map(name => `osstack.joint.${name}`));
const domains = new Set(JOINT_DIGEST_DOMAINS);

function invalid(): never { throw new Error('INVALID_JOINT_JSON'); }
function unicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
  }
}
function key(value: string): void {
  if ([...value].some(char => char.charCodeAt(0) > 127)) invalid();
}

/** Parse raw wire text before duplicate keys or -0 can be lost by JSON.parse. */
export function parseJointJson(raw: string): JointJson {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) invalid();
  let offset = 0;
  const ws = () => { while (' \t\r\n'.includes(raw[offset] ?? '\0')) offset++; };
  function string(): string {
    const start = offset++;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === '"') {
        let value: unknown;
        try { value = JSON.parse(raw.slice(start, offset)); } catch { return invalid(); }
        if (typeof value !== 'string') invalid();
        unicode(value); return value;
      }
      if (char === '\\') offset++;
    }
    return invalid();
  }
  function value(depth: number): JointJson {
    if (depth > MAX_DEPTH) invalid();
    ws(); const char = raw[offset];
    if (char === '"') return string();
    if (char === '[' || char === '{') {
      offset++; ws(); const array = char === '[';
      const out: JointJson[] = []; const object: { [key: string]: JointJson } = Object.create(null);
      const close = array ? ']' : '}';
      if (raw[offset] === close) { offset++; return array ? out : object; }
      while (offset < raw.length) {
        if (array) out.push(value(depth + 1));
        else {
          ws(); if (raw[offset] !== '"') invalid();
          const name = string(); key(name); ws();
          if (Object.hasOwn(object, name) || raw[offset++] !== ':') invalid();
          object[name] = value(depth + 1);
        }
        ws(); const separator = raw[offset++];
        if (separator === close) return array ? out : object;
        if (separator !== ',') invalid();
      }
      return invalid();
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(raw.slice(offset));
    if (!match) invalid();
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || Object.is(number, -0)) invalid();
    return number;
  }
  const result = value(0); ws(); if (offset !== raw.length) invalid(); return result;
}

/** Canonicalize JSON values only. Schema validation and authority checks are separate. */
export function canonicalJointJson(value: unknown): string {
  const ancestors = new Set<object>();
  let bytes = 0;
  const chunks: string[] = [];
  function emit(chunk: string): void {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_BYTES) invalid();
    chunks.push(chunk);
  }
  function encode(item: unknown, depth: number): void {
    if (depth > MAX_DEPTH) invalid();
    if (item === null || typeof item === 'boolean') { emit(JSON.stringify(item)); return; }
    if (typeof item === 'string') {
      if (item.length > MAX_BYTES) invalid();
      unicode(item); emit(JSON.stringify(item)); return;
    }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) invalid();
      emit(JSON.stringify(item)); return;
    }
    if (typeof item !== 'object' || ancestors.has(item)) invalid();
    ancestors.add(item);
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid();
    const names = Reflect.ownKeys(item);
    if (names.length > MAX_BYTES || names.some(name => typeof name !== 'string')) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(d => !('value' in d))) invalid();
    if (array) {
      if (names.length !== item.length + 1) invalid();
      emit('[');
      for (let i = 0; i < item.length; i++) { if (i) emit(','); encode(descriptors[i]?.value, depth + 1); }
      emit(']');
    } else {
      emit('{');
      for (const [i, name] of (names as string[]).sort().entries()) {
        key(name); if (!descriptors[name]?.enumerable) invalid();
        if (i) emit(','); emit(JSON.stringify(name)); emit(':'); encode(descriptors[name]?.value, depth + 1);
      }
      emit('}');
    }
    ancestors.delete(item);
  }
  encode(value, 0); return chunks.join('');
}

/** Fatal UTF-8 decoding prevents replacement characters from hiding invalid wire bytes. */
export function parseJointJsonBytes(raw: Uint8Array): JointJson {
  if (raw.byteLength > MAX_BYTES || (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)) invalid();
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { return invalid(); }
  return parseJointJson(decoded);
}

export function jointDigest(domain: string, value: unknown): string {
  if (!domains.has(domain)) throw new Error('UNKNOWN_JOINT_DIGEST_DOMAIN');
  return createHash('sha256').update(domain + '\n' + canonicalJointJson(value), 'utf8').digest('hex');
}
