import { zodToJsonSchema } from 'zod-to-json-schema';
import { JointContract } from './joint-contracts.js';
import { MaterialSchemas } from './method-materials.js';
/** JSON Schemas expose shape; consumers must also run raw decoding and semantic validation. */
export function generateJointSchemas(): Record<string, string> {
  const entries = { JointContract, ...MaterialSchemas };
  return Object.fromEntries(Object.entries(entries).map(([name, schema]) => [
    `${name.replace(/[A-Z]/g, (c, i: number) => `${i ? '-' : ''}${c.toLowerCase()}`)}.schema.json`,
    JSON.stringify({ ...zodToJsonSchema(schema, { name, $refStrategy: 'root' }), $comment: 'Shape only. Use @osstack/protocol/joint decodeJointContract for lexical and semantic checks. Host must authenticate provenance, resolve principal aliases, load referenced evidence, verify current authority and enforce durable CAS. Parsing grants no authority.' }, null, 2) + '\n',
  ]));
}
