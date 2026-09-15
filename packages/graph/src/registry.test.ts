import { describe, expect, it } from 'vitest';
import { GRAPH_REGISTRY, validateGraphRegistry } from './registry.js';

describe('fixed graph registry', () => {
  it('returns a detached deeply frozen allowlist', () => {
    const input = structuredClone(GRAPH_REGISTRY);
    const registry = validateGraphRegistry(input);
    expect(Object.isFrozen(registry.nodes.review.inputs)).toBe(true);
    Reflect.set(input, 'registryVersion', 'other-version');
    expect(registry.registryVersion).toBe(GRAPH_REGISTRY.registryVersion);
  });
  it.each(['tool', 'cost', 'schema', 'route', 'node', 'extra'])('rejects changed %s definitions', change => {
    const input = structuredClone(GRAPH_REGISTRY);
    if (change === 'tool') Reflect.set(input.nodes.review, 'tool', 'shell');
    if (change === 'cost') Reflect.set(input.nodes.review, 'reservedTokens', 0);
    if (change === 'schema') Reflect.set(input.nodes.freeze.inputs, 'receiptRef', 'commit');
    if (change === 'route') Reflect.set(input.routes, input.routes.length, 'eval');
    if (change === 'node') Reflect.set(input.nodes, 'eval', input.nodes.review);
    if (change === 'extra') Reflect.set(input, 'code', 'process.exit()');
    expect(() => validateGraphRegistry(input)).toThrow(/REGISTRY_INVALID/);
  });
  it('rejects executable/accessor data without invoking it', () => {
    let called = false;
    const input = { ...GRAPH_REGISTRY, get injected() { called = true; return 1; } };
    expect(() => validateGraphRegistry(input)).toThrow();
    expect(called).toBe(false);
  });
});


it.each([null, [], {}, { ...GRAPH_REGISTRY, schemaVersion: 1 }, { ...GRAPH_REGISTRY, registryVersion: '' }])('rejects malformed registry %s', value => {
  expect(() => validateGraphRegistry(value)).toThrow(/REGISTRY_INVALID/);
});
