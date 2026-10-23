import { types } from 'node:util';
import type { Checkpoint, SerializerProtocol } from '@langchain/langgraph-checkpoint';

export interface CheckpointCodecOptions {
  allowBytes?: boolean;
  maxWireBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxStringLength?: number;
  maxBytes?: number;
}

// Callers may tighten, but never raise, these per-message allocation ceilings.
const CEILINGS = Object.freeze({
  maxWireBytes: 1_048_576, maxDepth: 64, maxNodes: 50_000,
  maxStringLength: 262_144, maxBytes: 262_144,
});
type Limits = Record<keyof typeof CEILINGS, number>;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
function byteInfo(value: Uint8Array) {
  return {
    buffer: bufferGetter.call(value) as ArrayBuffer,
    length: lengthGetter.call(value) as number,
    offset: offsetGetter.call(value) as number,
  };
}
const WIRE_TYPE = 'osstack-checkpoint-v1';
const unsafeKey = (key: string) => key === '__proto__' || key === 'constructor' || key === 'prototype';
function fail(reason: string): never { throw new Error(`CHECKPOINT_CODEC_INVALID: ${reason}`); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !types.isProxy(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Bounded, deterministic JSON wire. No engine runtime imports or class revival.
 * Arrays/objects are tagged so an ordinary user array can never become bytes.
 * Inbound byte/depth/token limits are checked before JSON.parse; decoded bytes
 * are length checked before allocation. This is a codec, not authorization.
 */
export class CheckpointCodec implements SerializerProtocol {
  private readonly limits: Readonly<Limits>;
  private readonly allowBytes: boolean;

  constructor(options: CheckpointCodecOptions = {}) {
    const limits: Limits = { ...CEILINGS };
    for (const key of Object.keys(CEILINGS) as (keyof typeof CEILINGS)[]) {
      const value = options[key] ?? CEILINGS[key];
      if (!Number.isSafeInteger(value) || value <= 0 || value > CEILINGS[key]) fail(`invalid ${key}`);
      limits[key] = value;
    }
    if (options.allowBytes !== undefined && typeof options.allowBytes !== 'boolean') fail('invalid allowBytes');
    this.limits = Object.freeze(limits);
    this.allowBytes = options.allowBytes ?? false;
  }

  encode(value: unknown): Uint8Array {
    let nodes = 0;
    let size = 0;
    const chunks: string[] = [];
    const ancestors = new Set<object>();
    const emit = (chunk: string) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > this.limits.maxWireBytes) fail('wire bytes limit');
      chunks.push(chunk);
    };
    const string = (value: string) => {
      if (value.length > this.limits.maxStringLength) fail('string limit');
      emit(JSON.stringify(value));
    };
    const visit = (value: unknown, depth: number): void => {
      if (++nodes > this.limits.maxNodes) fail('node limit');
      if (depth > this.limits.maxDepth) fail('depth limit');
      if (value === null || typeof value === 'boolean') { emit(String(value)); return; }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('nonfinite number');
        emit(JSON.stringify(value)); return;
      }
      if (typeof value === 'string') { string(value); return; }
      if (typeof value !== 'object' || types.isProxy(value)) fail('unsupported value');
      if (ancestors.has(value)) fail('cycle');
      const proto = Object.getPrototypeOf(value);
      if (proto === Uint8Array.prototype) {
        if (!types.isUint8Array(value)) fail('forged bytes');
        const bytes = value as Uint8Array;
        const info = byteInfo(bytes);
        if (!this.allowBytes || types.isSharedArrayBuffer(info.buffer)) fail('bytes disabled or shared');
        if (info.length > this.limits.maxBytes) fail('bytes limit');
        if (Reflect.ownKeys(bytes).length !== info.length) fail('byte properties');
        emit('["bytes","');
        // Check expansion before creating the hex string.
        if (size + info.length * 2 + 2 > this.limits.maxWireBytes) fail('wire bytes limit');
        emit(Buffer.from(info.buffer, info.offset, info.length).toString('hex'));
        emit('"]'); return;
      }
      const array = Array.isArray(value);
      if (array ? proto !== Array.prototype : !record(value)) fail('class or prototype');
      if (array && value.length > this.limits.maxNodes - nodes) fail('node limit');
      const keys = Reflect.ownKeys(value);
      if (keys.length > this.limits.maxNodes + 1) fail('property limit');
      for (const key of keys) {
        if (typeof key !== 'string' || unsafeKey(key)) fail('unsafe key');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) fail('accessor or hidden property');
      }
      ancestors.add(value);
      if (array) {
        if (keys.length !== value.length + 1) fail('sparse or extended array');
        emit('["array",[');
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor) fail('sparse array');
          if (i) emit(',');
          visit(descriptor.value, depth + 1);
        }
      } else {
        emit('["object",[');
        (keys as string[]).sort().forEach((key, i) => {
          if (i) emit(',');
          emit('['); string(key); emit(',');
          visit(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1);
          emit(']');
        });
      }
      emit(']]');
      ancestors.delete(value);
    };
    emit('["osstack-checkpoint",1,'); visit(value, 0); emit(']');
    return new TextEncoder().encode(chunks.join(''));
  }

  decode(data: Uint8Array | string): unknown {
    if (typeof data !== 'string' && (!types.isUint8Array(data) || types.isProxy(data))) fail('wire input type');
    const info = typeof data === 'string' ? undefined : byteInfo(data);
    if (info && types.isSharedArrayBuffer(info.buffer)) fail('shared wire');
    if ((typeof data === 'string' ? data.length : info!.length) > this.limits.maxWireBytes) fail('wire bytes limit');
    const wire = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    if (Buffer.byteLength(wire, 'utf8') > this.limits.maxWireBytes) fail('wire bytes limit');
    // Lexical preflight: JSON.parse must never see unbounded nesting or tokens.
    // Tagged object edges cost at most 3 levels and 8 tokens per value.
    let depth = 0; let tokens = 0; let quoted = false; let escaped = false;
    for (const char of wire) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else {
        if (char === '"') quoted = true;
        if (char === '[' || char === '{') depth++;
        if (char === ']' || char === '}') depth--;
        if (char === ',' || char === '[' || char === '{' || char === ':') tokens++;
        if (depth > this.limits.maxDepth * 3 + 4) fail('wire depth limit');
        if (tokens > this.limits.maxNodes * 8 + 8) fail('wire token limit');
      }
    }
    const envelope: unknown = JSON.parse(wire);
    if (!Array.isArray(envelope) || envelope.length !== 3 || envelope[0] !== 'osstack-checkpoint' || envelope[1] !== 1) fail('wire version');
    let nodes = 0;
    const checkString = (value: string) => {
      if (value.length > this.limits.maxStringLength) fail('string limit');
      return value;
    };
    const visit = (node: unknown, depth: number): unknown => {
      if (++nodes > this.limits.maxNodes) fail('node limit');
      if (depth > this.limits.maxDepth) fail('depth limit');
      if (node === null || typeof node === 'boolean') return node;
      if (typeof node === 'string') return checkString(node);
      if (typeof node === 'number') {
        if (!Number.isFinite(node)) fail('nonfinite number');
        return node === 0 ? 0 : node;
      }
      if (!Array.isArray(node) || node.length !== 2) fail('node shape');
      const [tag, content] = node;
      if (tag === 'bytes') {
        if (!this.allowBytes || typeof content !== 'string') fail('bytes disabled or malformed');
        if (content.length > this.limits.maxBytes * 2) fail('bytes limit');
        if (content.length % 2 || !/^[0-9a-f]*$/.test(content)) fail('noncanonical bytes');
        return new Uint8Array(Buffer.from(content, 'hex'));
      }
      if (!Array.isArray(content) || content.length > this.limits.maxNodes - nodes) fail('container or node limit');
      if (tag === 'array') return content.map((item) => visit(item, depth + 1));
      if (tag !== 'object') fail('unknown tag');
      const result: Record<string, unknown> = {};
      let previous: string | undefined;
      for (const pair of content) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') fail('object entry');
        const key = checkString(pair[0]);
        if (unsafeKey(key) || (previous !== undefined && key <= previous)) fail('unsafe, duplicate or unsorted key');
        result[key] = visit(pair[1], depth + 1);
        previous = key;
      }
      return result;
    };
    return visit(envelope[2], 0);
  }

  async dumpsTyped(value: unknown): Promise<[string, Uint8Array]> {
    return [WIRE_TYPE, this.encode(value)];
  }
  async loadsTyped(type: string, data: Uint8Array | string): Promise<unknown> {
    if (type !== WIRE_TYPE) fail('serializer type');
    return this.decode(data);
  }
}

/** Validate a codec-decoded checkpoint. Migration is explicit, never lossy. */
export function assertCheckpointV4(value: unknown): asserts value is Checkpoint {
  if (!record(value) || value['v'] !== 4) fail('unsupported checkpoint version');
  if (typeof value['id'] !== 'string' || !value['id'] || typeof value['ts'] !== 'string' || !Number.isFinite(Date.parse(value['ts']))) fail('checkpoint identity');
  const versions = (value: unknown): boolean => record(value) && Object.values(value).every((v) =>
    (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string');
  if (!record(value['channel_values']) || !versions(value['channel_versions'])
    || !record(value['versions_seen']) || !Object.values(value['versions_seen']).every(versions)) fail('checkpoint fields');
}
