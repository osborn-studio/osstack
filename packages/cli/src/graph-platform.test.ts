import { expect, it } from 'vitest';
import { assertGraphPlatform } from './graph-platform.js';
it('rejects embedded Bun graph execution and preserves the Node package deployment floor', () => {
  expect(() => assertGraphPlatform({ node: '22.0.0', bun: '1.3.0' })).toThrow('GRAPH_DISTRIBUTION_UNSUPPORTED');
  for (const node of ['18.20.0', '20.0.0', '20.5.1']) expect(() => assertGraphPlatform({ node })).toThrow('GRAPH_NODE_VERSION_UNSUPPORTED');
  for (const node of ['20.6.0', '20.19.0', '22.0.0', '26.5.0']) expect(() => assertGraphPlatform({ node })).not.toThrow();
});
