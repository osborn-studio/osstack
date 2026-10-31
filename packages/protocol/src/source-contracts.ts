// Neutral source provenance contracts. Digest domains keep their original
// `osstack.joint.*` names: they are wire identities, and renaming them would
// change every stored digest.
import { z } from 'zod';
import { domainDigest } from './canonical-json.js';
import { Digest, GitId, Ref, issue, unique, portableGitPath } from './contract-primitives.js';

export const SOURCE_DIGEST_DOMAINS = Object.freeze(['source-snapshot.v1', 'source-content.v1', 'source-inspection.v1']
  .map(name => `osstack.joint.${name}`));
const domains = new Set(SOURCE_DIGEST_DOMAINS);

export function sourceDigest(domain: string, value: unknown): string {
  if (!domains.has(domain)) throw new Error('UNKNOWN_SOURCE_DIGEST_DOMAIN');
  return domainDigest(domain, value);
}

export const SourcePinShape = z.object({
  kind: z.literal("source_pin"),
  schema_version: z.literal(1),
  repository: z.string().min(1).max(512),
  commit: GitId,
  subdir: z.string().min(1).max(512),
  content_sha256: Digest,
  license_refs: z.array(z.string().min(1).max(512)).min(1).max(256),
}).strict();

export const SourcePin = SourcePinShape.superRefine((v, ctx) => {
  if (!portableGitPath(v.subdir, true)) issue(ctx, 'NONCANONICAL_SOURCE_PATH');
});
export type SourcePin = z.infer<typeof SourcePin>;

export const SourceSnapshot = z.object({ kind: z.literal('source_snapshot'), schema_version: z.literal(1), pin: SourcePin,
  files: z.array(z.object({ path: Ref, mode: z.enum(['100644', '100755']), blob: GitId }).strict()).max(4096),
  dependencies: z.array(SourcePin).max(256),
}).strict().superRefine((v, ctx) => {
  const paths = v.files.map(f => f.path.normalize('NFC').toLowerCase());
  if (!unique(paths)) issue(ctx, 'COLLIDING_SOURCE_PATH');
  const pathSet = new Set(paths);
  for (const path of paths) { const parts = path.split('/'); for (let i=1; i<parts.length; i++) if (pathSet.has(parts.slice(0,i).join('/'))) issue(ctx, 'SOURCE_PREFIX_CONFLICT'); }
  for (const f of v.files) if (!portableGitPath(f.path)) issue(ctx, 'NONCANONICAL_SOURCE_PATH');
});
export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

/** Sort only the catalog's declared sets; all other arrays retain declaration order. */
export function sourceSnapshotDigest(input: unknown): string {
  const v = SourceSnapshot.parse(input);
  v.files.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return sourceDigest('osstack.joint.source-snapshot.v1', v);
}
