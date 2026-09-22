import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { assertChangesetDisclosurePaths } from '@osstack/agents/experimental/changeset';
import { GraphJsonValue, freezeWorkerData, workerCanonical } from '@osstack/protocol';
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const inputSchema = z.object({ repository: z.string().min(1), runBaseRevision: revision, invocationBaseRevision: revision, candidateRevision: revision,
  acceptanceRef: z.string().min(1).max(256), inputPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/), pathPolicy: z.unknown() }).strict();
export interface GraphReviewInput extends z.input<typeof inputSchema> {}
interface TreeEntry { mode: string; oid: string; type: string }
interface ReviewContent { blobRevision: string; sha256: string; mode: string; content: string; bytes: number }
export interface GraphReviewChange { path: string; kind: 'added' | 'modified' | 'deleted'; before: ReviewContent | null; after: ReviewContent | null }
export interface GraphReviewInputManifest {
  schemaVersion: 1; kind: 'cumulative-changes-v1'; runBaseRevision: string; invocationBaseRevision: string; candidateRevision: string;
  runBaseTree: string; invocationBaseTree: string; candidateTree: string; acceptanceRef: string; inputPolicyDigest: string;
  changes: GraphReviewChange[]; incrementalChanges: GraphReviewChange[]; complete: true;
}
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const incomplete = () => Error('GRAPH_REVIEW_CONTEXT_INCOMPLETE');
/** Experimental host disclosure builder. Authorize must synchronously prove
 * scope, disclosure policy, independent reviewer, and the host-owned frozen Git
 * object store. Returned JSON is untrusted evidence content, not instructions.
 * All cumulative changed before/after text is included or the entire operation
 * fails; never falls back to the last repair diff or the mutable working files.
 * No provider call, quality verdict, production registration or ready transition. */
export function buildGraphReviewInput(raw: unknown, authorize: () => unknown): { manifest: GraphReviewInputManifest; manifestDigest: string; context: string } {
  const input = inputSchema.parse(GraphJsonValue.parse(raw));
  const check = () => {
    const value = authorize(); if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('GRAPH_REVIEW_AUTHORITY'); }
  };
  check();
  const disclosure = (paths: string[]) => {
    try { assertChangesetDisclosurePaths(paths, input.pathPolicy, input.inputPolicyDigest); } catch { throw Error('GRAPH_REVIEW_POLICY'); }
  };
  disclosure([]);
  if (!isAbsolute(input.repository) || resolve(input.repository) !== input.repository || realpathSync(input.repository) !== input.repository) throw Error('GRAPH_REVIEW_ROOT');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (args: string[], maxBuffer = 4 * 1024 * 1024) => {
    check(); let bytes: Buffer;
    try {
      bytes = execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: input.repository, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer,
        env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } });
    } catch { throw incomplete(); }
    check(); return bytes;
  };
  const text = (bytes: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw incomplete(); } };
  try { if (text(git(['rev-parse', '--show-toplevel'])).trim() !== input.repository) throw Error(); } catch { throw Error('GRAPH_REVIEW_ROOT'); }
  const rev = (value: string) => {
    const result = text(git(['rev-parse', '--verify', value])).trim(); if (!revision.safeParse(result).success) throw incomplete(); return result;
  };
  for (const id of [input.runBaseRevision, input.invocationBaseRevision, input.candidateRevision]) {
    if (rev(`${id}^{commit}`) !== id) throw Error('GRAPH_REVIEW_REVISION');
  }
  try {
    git(['merge-base', '--is-ancestor', input.runBaseRevision, input.invocationBaseRevision]);
    git(['merge-base', '--is-ancestor', input.invocationBaseRevision, input.candidateRevision]);
  } catch (error) {
    if (error instanceof Error && error.message === 'GRAPH_REVIEW_AUTHORITY') throw error;
    throw Error('GRAPH_REVIEW_LINEAGE');
  }
  const entries = (id: string) => {
    const result = new Map<string, TreeEntry>(); const records = text(git(['ls-tree', '-rz', '--full-tree', id])).split('\0');
    if (records.pop() !== '') throw incomplete();
    if (records.length > 10000) throw incomplete();
    for (const item of records) {
      const tab = item.indexOf('\t'); const path = item.slice(tab + 1); const fields = item.slice(0, tab).split(' ');
      if (tab < 0 || fields.length !== 3 || !revision.safeParse(fields[2]).success || !path || result.has(path)) throw incomplete();
      result.set(path, { mode: fields[0]!, type: fields[1]!, oid: fields[2]! });
    }
    return result;
  };
  const base = entries(input.runBaseRevision); const prior = entries(input.invocationBaseRevision); const candidate = entries(input.candidateRevision);
  const changed = (a: Map<string, TreeEntry>, b: Map<string, TreeEntry>) => [...new Set([...a.keys(), ...b.keys()])].sort().filter(path => {
    const before = a.get(path); const after = b.get(path);
    return before?.oid !== after?.oid || before?.mode !== after?.mode || before?.type !== after?.type;
  });
  const paths = changed(base, candidate); const incrementalPaths = changed(prior, candidate);
  if (paths.length > 32 || incrementalPaths.length > 32) throw incomplete();
  disclosure([...new Set([...paths, ...incrementalPaths])]);
  let disclosed = 0;
  const content = (entry: TreeEntry | undefined): ReviewContent | null => {
    if (!entry) return null;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw incomplete();
    const bytes = git(['cat-file', 'blob', entry.oid], 16385);
    disclosed += bytes.length;
    if (bytes.length > 16384 || disclosed > 131072 || bytes.includes(0)) throw incomplete();
    const algorithm = entry.oid.length === 40 ? 'sha1' : 'sha256';
    const oid = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (oid !== entry.oid) throw incomplete();
    const value = text(bytes); if (!Buffer.from(value).equals(bytes)) throw incomplete();
    return { blobRevision: entry.oid, sha256: sha(bytes), mode: entry.mode, content: value, bytes: bytes.length };
  };
  const changesFrom = (names: string[], before: Map<string, TreeEntry>) => names.map(path => ({ path, kind: !before.has(path) ? 'added' as const : !candidate.has(path) ? 'deleted' as const : 'modified' as const,
    before: content(before.get(path)), after: content(candidate.get(path)) }));
  const changes = changesFrom(paths, base); const incrementalChanges = changesFrom(incrementalPaths, prior);
  const manifest: GraphReviewInputManifest = freezeWorkerData({ schemaVersion: 1, kind: 'cumulative-changes-v1', runBaseRevision: input.runBaseRevision,
    invocationBaseRevision: input.invocationBaseRevision, candidateRevision: input.candidateRevision, runBaseTree: rev(`${input.runBaseRevision}^{tree}`),
    invocationBaseTree: rev(`${input.invocationBaseRevision}^{tree}`), candidateTree: rev(`${input.candidateRevision}^{tree}`), acceptanceRef: input.acceptanceRef,
    inputPolicyDigest: input.inputPolicyDigest, changes, incrementalChanges, complete: true });
  const manifestDigest = sha(`osstack.graph-review-input.v1\n${workerCanonical(manifest)}`);
  const context = workerCanonical({ manifestDigest, manifest });
  // JSON escapes and envelope bytes count too; token-bound proof is separately
  // required by the eventual provider client, never approximated as bytes/4.
  if (Buffer.byteLength(context) > 200000) throw incomplete();
  check(); return freezeWorkerData({ manifest, manifestDigest, context });
}
