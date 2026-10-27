import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { generateJointSchemas } from '../dist/joint-generate.js';
const root = new URL('../schemas/joint/', import.meta.url);
const check = process.argv.includes('--check');
if (!check) mkdirSync(root, { recursive: true });
for (const [name, body] of Object.entries(generateJointSchemas())) {
  const file = new URL(name, root);
  if (check) {
    if (readFileSync(file, 'utf8') !== body) throw new Error(`STALE_JOINT_SCHEMA: ${name}`);
  } else writeFileSync(file, body);
}
