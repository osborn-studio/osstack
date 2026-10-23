import { describe, expect, it, vi } from 'vitest';
import { CheckpointCodec, assertCheckpointV4 } from './checkpoint-codec.js';

const codec = new CheckpointCodec();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('restricted checkpoint codec', () => {
  it('rejects BOM consistently for raw bytes and string wire', () => {
    const wire = codec.encode(1);
    expect(() => codec.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire]))).toThrow();
    expect(() => codec.decode('\uFEFF' + text(wire))).toThrow();
  });
  it('round trips JSON, reserved channel tuples, and deterministic sorted keys', () => {
    const value = { z: [null, true, false, 2.5, '雪', -0], a: {
      __error__: { name: 'Error', message: 'failed' },
      __interrupt__: [{ id: 'pause', value: { question: 'continue?' } }],
      __resume__: [false], __pregel_tasks: [['task', 'channel', { result: 1 }]],
    } };
    expect(codec.decode(codec.encode(value))).toEqual({ ...value, z: [null, true, false, 2.5, '雪', 0] });
    expect(text(codec.encode(value))).toBe(text(codec.encode({ a: value.a, z: value.z })));
  });

  it('implements the public typed serializer and rejects unknown wire/type versions', async () => {
    const [type, data] = await codec.dumpsTyped({ result: 1 });
    expect(await codec.loadsTyped(type, data)).toEqual({ result: 1 });
    expect(await codec.loadsTyped(type, text(data))).toEqual({ result: 1 });
    await expect(codec.loadsTyped('json', data)).rejects.toThrow();
    expect(() => codec.decode('["osstack-checkpoint",2,null]')).toThrow();
  });

  it('permits only opt-in exact Uint8Array, with collision-free tags and byte limits', () => {
    const bytesCodec = new CheckpointCodec({ allowBytes: true, maxBytes: 3 });
    const value = { bytes: new Uint8Array([0, 127, 255]), literal: ['bytes', '007fff'] };
    expect(bytesCodec.decode(bytesCodec.encode(value))).toEqual(value);
    expect(() => codec.encode(new Uint8Array())).toThrow();
    expect(() => bytesCodec.encode(new Uint8Array(4))).toThrow();
    expect(() => bytesCodec.decode('["osstack-checkpoint",1,["bytes","00000000"]]')).toThrow();
    for (const hex of ['0', 'GG', 'FF']) {
      expect(() => bytesCodec.decode(JSON.stringify(['osstack-checkpoint', 1, ['bytes', hex]]))).toThrow();
    }
    expect(() => bytesCodec.encode(Buffer.from([1]))).toThrow();
    expect(() => bytesCodec.encode(new Uint16Array([1]))).toThrow();
  });

  it.each([undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'), new Date(), new Map(), new Set(), new Error('x'), /x/])('rejects unsupported value %s', (value) => {
    expect(() => codec.encode(value)).toThrow();
    expect(() => codec.encode({ nested: value })).toThrow();
  });

  it('rejects prototypes, pollution keys, getters, hooks, symbols, cycles and sparse arrays without executing code', () => {
    const getter = vi.fn(() => 'bad');
    const accessor = Object.defineProperty({}, 'x', { get: getter, enumerable: true });
    const hidden = Object.defineProperty({}, 'x', { value: 1 });
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    const extraArray = Object.assign([1], { extra: true });
    for (const value of [accessor, hidden, cyclic, extraArray, Array(2), [undefined], { toJSON: getter }, { [Symbol()]: 1 }, Object.create({ x: 1 }), new Proxy({}, { ownKeys: getter })]) {
      expect(() => codec.encode(value)).toThrow();
    }
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => codec.encode(JSON.parse(`{"${key}":1}`))).toThrow();
      expect(() => codec.decode(JSON.stringify(['osstack-checkpoint', 1, ['object', [[key, 1]]]]))).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(codec.decode(codec.encode(Object.assign(Object.create(null), { safe: 1 })))).toEqual({ safe: 1 });
  });

  it('rejects byte accessors before reading buffer/length and shared byte storage', () => {
    const byteCodec = new CheckpointCodec({ allowBytes: true });
    const getter = vi.fn(() => new ArrayBuffer(1));
    const bytes = Object.defineProperty(new Uint8Array(1), 'buffer', { get: getter });
    expect(() => byteCodec.encode(bytes)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    for (const key of ['buffer', 'byteLength', 'byteOffset', 'length']) {
      const hook = vi.fn(() => { throw new Error('must not execute'); });
      const input = Object.defineProperty(new Uint8Array(codec.encode({ safe: true })), key, { get: hook });
      expect(() => byteCodec.encode(input)).toThrow();
      expect(codec.decode(input)).toEqual({ safe: true });
      expect(hook).not.toHaveBeenCalled();
    }
    expect(() => byteCodec.encode(Object.create(Uint8Array.prototype))).toThrow(/forged bytes/);
    expect(codec.decode(Buffer.from(codec.encode({ safe: true })))).toEqual({ safe: true });
    expect(() => byteCodec.encode(new Uint8Array(new SharedArrayBuffer(1)))).toThrow();
    expect(() => byteCodec.decode(new Uint8Array(new SharedArrayBuffer(1)))).toThrow();
  });

  it('bounds encode/decode depth, nodes, strings and wire size; validates option ceilings', () => {
    const limited = new CheckpointCodec({ maxDepth: 2, maxNodes: 4, maxStringLength: 8, maxWireBytes: 256 });
    for (const value of [{ a: { b: { c: 1 } } }, [1, 2, 3, 4], '123456789']) {
      expect(() => limited.encode(value)).toThrow();
      expect(() => limited.decode(codec.encode(value))).toThrow();
    }
    expect(() => limited.encode('雪'.repeat(100))).toThrow();
    expect(() => limited.decode(' '.repeat(257))).toThrow();
    expect(() => limited.decode(new Uint8Array(257))).toThrow();
    expect(() => limited.decode('['.repeat(1000) + ']'.repeat(1000))).toThrow();
    for (const options of [{ maxDepth: Infinity }, { maxNodes: 0 }, { maxWireBytes: 1e12 }, { maxBytes: -1 }, { maxDepth: 1.5 }]) {
      expect(() => new CheckpointCodec(options)).toThrow();
    }
  });

  it('rejects oversized/deep inputs before JSON.parse and malformed wire without revival', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const small = new CheckpointCodec({ maxWireBytes: 128, maxDepth: 2, maxNodes: 2 });
      for (const wire of [' '.repeat(129), '['.repeat(12) + ']'.repeat(12), '[' + '0,'.repeat(40) + '0]']) {
        expect(() => small.decode(wire)).toThrow();
      }
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
    for (const wire of ['null', '{}', '["osstack-checkpoint",1,1e999]', '["osstack-checkpoint",1,["class","Error"]]', '["osstack-checkpoint",1,["object",[["x",1],["x",2]]]]', '["osstack-checkpoint",1,["object",[["z",1],["a",2]]]]']) {
      expect(() => codec.decode(wire)).toThrow();
    }
    expect(() => codec.decode(new Uint8Array([0xc0, 0xaf]))).toThrow();
  });

  it('validates checkpoint v4 required fields without losing engine metadata/extensions', () => {
    const checkpoint = { v: 4, id: 'checkpoint', ts: '2026-09-13T00:00:00.000Z', channel_values: { result: 1 }, channel_versions: { result: '0002' }, versions_seen: { node: { result: 1 } }, extra: { future: true } };
    const decoded = codec.decode(codec.encode(checkpoint));
    expect(() => assertCheckpointV4(decoded)).not.toThrow();
    expect(decoded).toEqual(checkpoint);
    for (const invalid of [{ ...checkpoint, v: 3 }, { ...checkpoint, v: 5 }, { ...checkpoint, id: '' }, { ...checkpoint, channel_versions: { result: null } }, { ...checkpoint, versions_seen: [] }]) {
      expect(() => assertCheckpointV4(invalid)).toThrow();
    }
    for (const key of ['v', 'id', 'ts', 'channel_values', 'channel_versions', 'versions_seen']) {
      const missing: Record<string, unknown> = { ...checkpoint }; delete missing[key];
      expect(() => assertCheckpointV4(missing)).toThrow();
    }
  });
});
