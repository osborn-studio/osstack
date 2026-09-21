import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GraphJsonValue, freezeWorkerData, workerCanonical } from '@osstack/protocol';

/** Experimental data validation only. No adapter capability, grant or filesystem authority. */
export const CHANGESET_LIMITS = Object.freeze({ maxChanges: 8, maxFileContentBytes: 16_384, maxProposalContentBytes: 16_384, maxManifestBytes: 32_768,
  maxManifestEntries: 16, maxPathBytes: 512, maxSegments: 16 });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const path = z.string().min(1).max(CHANGESET_LIMITS.maxPathBytes).refine(portablePath, 'CHANGESET_PATH');
const content = z.string().max(CHANGESET_LIMITS.maxFileContentBytes).refine(textContent, 'CHANGESET_TEXT');
const bindingSchema = z.object({ runId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/), effectKey: digest,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), baseRevision: revision, treeRevision: revision,
  profileDigest: digest, grantDigest: digest, programDigest: digest, policyDigest: digest }).strict();
const paths = z.array(path).max(64);
const policySchema = z.object({ exactPaths: paths, directoryPrefixes: paths, denyPaths: paths, denyPrefixes: paths }).strict();
const entry = z.discriminatedUnion('state', [
  z.object({ path, state: z.literal('absent') }).strict(),
  z.object({ path, state: z.literal('present'), content, sha256: digest, mode: z.enum(['100644', '100755']) }).strict(),
]);
const manifestSchema = z.object({ schemaVersion: z.literal(1), binding: bindingSchema,
  entries: z.array(entry).min(1).max(CHANGESET_LIMITS.maxManifestEntries) }).strict();
const change = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), path, content }).strict(),
  z.object({ kind: z.literal('replace'), path, expectedSha256: digest, content }).strict(),
  z.object({ kind: z.literal('delete'), path, expectedSha256: digest }).strict(),
]);
const proposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('propose'), changes: z.array(change).min(1).max(CHANGESET_LIMITS.maxChanges) }).strict(),
  z.object({ kind: z.literal('cannot_complete'), reason: z.enum(['insufficient_context', 'outside_scope', 'budget_insufficient', 'unsupported_change']) }).strict(),
]);
export type ChangesetBinding = z.infer<typeof bindingSchema>;
export type ChangesetPathPolicy = z.infer<typeof policySchema>;
export type ChangesetInputManifest = z.infer<typeof manifestSchema>;
export type ChangesetProposal = z.infer<typeof proposalSchema>;

function portablePath(value: string): boolean {
  const parts = value.split('/');
  // M1 deliberately restricts paths to ASCII. Content remains UTF-8.
  return parts.length <= CHANGESET_LIMITS.maxSegments && parts.every(part =>
    part.length <= 255 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !part.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function textContent(value: string): boolean {
  return !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= CHANGESET_LIMITS.maxFileContentBytes &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const boundDigest = (domain: string, value: unknown) => sha(`osstack.changeset.${domain}.v1\n${workerCanonical(GraphJsonValue.parse(value))}`);
const inside = (value: string, prefix: string) => value.startsWith(`${prefix}/`);
function allowed(value: string, policy: ChangesetPathPolicy): boolean {
  const lower = value.toLowerCase();
  if (policy.denyPaths.some(p => p.toLowerCase() === lower) ||
      policy.denyPrefixes.some(p => lower === p.toLowerCase() || inside(lower, p.toLowerCase()))) return false;
  return policy.exactPaths.includes(value) || policy.directoryPrefixes.some(p => inside(value, p));
}
/** Detect aliases in every directory component, not merely complete filenames. */
function checkPaths(values: string[]): void {
  const spelling = new Map<string, string>(); const files = new Set<string>();
  for (const value of values) {
    const parts = value.split('/'); let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const folded = prefix.toLowerCase(); const existing = spelling.get(folded);
      if (existing !== undefined && existing !== prefix) throw Error('CHANGESET_PATH_ALIAS');
      spelling.set(folded, prefix);
    }
    if (files.has(value)) throw Error('CHANGESET_DUPLICATE_PATH');
    files.add(value);
  }
  for (const value of files) {
    const parts = value.split('/'); parts.pop();
    while (parts.length) {
      if (files.has(parts.join('/'))) throw Error('CHANGESET_PATH_CONFLICT');
      parts.pop();
    }
  }
}

/** Host records this digest in its authorized profile/grant binding before invocation. */
export function changesetPolicyDigest(value: unknown): string {
  return boundDigest('policy', normalizedPolicy(value));
}
function normalizedPolicy(value: unknown): ChangesetPathPolicy {
  const policy = policySchema.parse(GraphJsonValue.parse(value));
  for (const values of Object.values(policy)) values.sort();
  return policy;
}

/** Host supplies independently verified current binding. A matching digest is not authorization.
 * Host must obtain policyDigest from the authorized grant/profile, never from the proposal.
 * proposalDigest is generation-scoped; durable cross-generation idempotency uses effectKey.
 * Host must check aliases against the entire live tree, including absent targets.
 * Host must recheck live preimages, path inode/link types, policy/grant and lease before applying.
 * create means mode 100644; replace preserves manifest mode; delete requires the exact preimage.
 * Each separately transported JSON input must be capped at 64 KiB before JSON.parse;
 * if bundled, cap the entire envelope at 64 KiB, not 64 KiB per member.
 * Manifest entries are writable targets only; read-only context is not supported in M1.
 */
export function validateChangesetProposal(proposalValue: unknown, manifestValue: unknown,
  policyValue: unknown, currentBindingValue: unknown) {
  const proposal = proposalSchema.parse(GraphJsonValue.parse(proposalValue));
  const manifest = manifestSchema.parse(GraphJsonValue.parse(manifestValue));
  const policy = normalizedPolicy(policyValue);
  const current = bindingSchema.parse(GraphJsonValue.parse(currentBindingValue));
  if (workerCanonical(manifest.binding) !== workerCanonical(current)) throw Error('CHANGESET_BINDING_MISMATCH');
  const policyDigest = boundDigest('policy', policy);
  if (policyDigest !== current.policyDigest) throw Error('CHANGESET_POLICY_MISMATCH');
  checkPaths(manifest.entries.map(e => e.path));
  let manifestBytes = 0;
  for (const e of manifest.entries) {
    if (!allowed(e.path, policy)) throw Error('CHANGESET_PATH_DENIED');
    if (e.state === 'present') {
      if (sha(e.content) !== e.sha256) throw Error('CHANGESET_PREIMAGE_MISMATCH');
      manifestBytes += Buffer.byteLength(e.content, 'utf8');
    }
  }
  if (manifestBytes > CHANGESET_LIMITS.maxManifestBytes) throw Error('CHANGESET_MANIFEST_LIMIT');
  if (proposal.kind === 'propose') {
    checkPaths(proposal.changes.map(c => c.path));
    let bytes = 0;
    for (const c of proposal.changes) {
      const e = manifest.entries.find(e => e.path === c.path);
      if (!e || !allowed(c.path, policy)) throw Error('CHANGESET_TARGET_REQUIRED');
      if (c.kind === 'create') {
        if (e.state !== 'absent') throw Error('CHANGESET_PREIMAGE_MISMATCH');
      } else {
        if (e.state !== 'present' || e.sha256 !== c.expectedSha256) throw Error('CHANGESET_PREIMAGE_MISMATCH');
        if (c.kind === 'replace' && e.content === c.content) throw Error('CHANGESET_NOOP');
      }
      if (c.kind !== 'delete') bytes += Buffer.byteLength(c.content, 'utf8');
    }
    if (bytes > CHANGESET_LIMITS.maxProposalContentBytes) throw Error('CHANGESET_CONTENT_LIMIT');
    proposal.changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  manifest.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifestDigest = boundDigest('manifest', manifest);
  const proposalDigest = boundDigest('proposal', { manifestDigest, policyDigest, proposal });
  return freezeWorkerData({ proposal, manifest, policy, manifestDigest, policyDigest, proposalDigest });
}
