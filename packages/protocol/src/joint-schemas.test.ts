import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { generateJointSchemas } from './joint-generate.js';
it('keeps all 11 joint JSON Schema artifacts byte-identical to Zod', () => {
  const files = generateJointSchemas();
  expect(Object.keys(files)).toHaveLength(11);
  expect(readdirSync(new URL('../schemas/joint/', import.meta.url)).sort()).toEqual(Object.keys(files).sort());
  for (const [name, body] of Object.entries(files)) expect(readFileSync(new URL(`../schemas/joint/${name}`, import.meta.url), 'utf8')).toBe(body);
});
