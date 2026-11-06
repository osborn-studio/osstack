// De-identification and validation for recorded PrSnapshot fixtures (appendix §5.4). Used by
// scripts/record-pr-timeline.mjs (through dist/bridge-fixture.js) and by tests; lazy-imported only.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { PrSnapshot, ProducerIdentity, ProducerRegistry } from '@osstack/core';
import { z } from 'zod';

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
/** Pseudonyms are small integers; a real GitHub id (millions) cannot pass. */
const pseudonym = z.number().int().min(1).max(999);
const identitySchema = z.object({ actor_id: pseudonym, app_id: pseudonym.nullable() }).strict();

/** Strict allowlist: ids, oids, states, timestamps, digests, booleans. Anything else fails validation. */
export const fixtureReviewSchema = z
  .object({
    review_id: z.number().int().positive(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']),
    submitted_at: z.number().int().positive(),
    review_commit: z.union([oid, z.literal('')]),
    reviewer: identitySchema,
    has_feedback: z.boolean(),
    feedback_digest: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  })
  .strict();
export const fixtureSnapshotSchema = z
  .object({
    pr_state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
    head: oid,
    base_sha: oid,
    /** Only `main` is kept verbatim; every other ref is a per-file pseudonym (ref1, ref2, …). */
    base_ref: z.string().regex(/^(?:main|ref[1-9][0-9]{0,2})$/u),
    observed_at: z.number().int().positive(),
    reviews: z.array(fixtureReviewSchema),
    complete: z.boolean(),
    moved: z.boolean(),
  })
  .strict();
export const fixtureRegistrySchema = z
  .object({ publisher: z.array(identitySchema), reviewers: z.array(identitySchema) })
  .strict();
export const fixtureFileSchema = z
  .object({ version: z.literal(1), registry: fixtureRegistrySchema, snapshots: z.array(fixtureSnapshotSchema) })
  .strict();

export type FixtureSnapshot = z.infer<typeof fixtureSnapshotSchema>;
export type FixtureFile = z.infer<typeof fixtureFileSchema>;

const failure = (reason: string): Error => new Error(`FIXTURE_REJECTED:${reason}`);

/** Throws `FIXTURE_REJECTED:<path>` for the first violation; never echoes the offending value. */
export function assertFixtureFile(value: unknown): FixtureFile {
  const result = fixtureFileSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw failure(`${issue?.code ?? 'invalid'}:${issue?.path.join('.') || 'root'}`);
  }
  return result.data;
}

export const SAFE_REFS: ReadonlySet<string> = new Set(['main']);

const key = (id: { actor_id: number; app_id: number | null }): string => `${id.app_id ?? 'u'}:${id.actor_id}`;

/** Real-id -> pseudonym state of one fixture file. It contains real ids and the digest salt, so it must NEVER be written into
 * the repository: it lives in a private sidecar (see fixtureMapPath) and is what keeps `--append` consistent. */
export interface FixtureMap {
  version: 1;
  salt: string;
  actors: Record<string, number>;
  apps: Record<string, number>;
  refs: Record<string, number>;
}
export const newFixtureMap = (salt: string = randomBytes(32).toString('hex')): FixtureMap => ({ version: 1, salt, actors: {}, apps: {}, refs: {} });

export interface Pseudonymized {
  readonly snapshot: FixtureSnapshot;
  readonly registry: { publisher: ProducerIdentity[]; reviewers: ProducerIdentity[] };
  /** The input map extended with whatever this snapshot introduced; persist it to the sidecar. */
  readonly map: FixtureMap;
}

/** Replaces every actor id, App id and non-allowlisted base ref with a small pseudonym, and each feedback digest with
 * HMAC-SHA256(digest, per-file salt) so short bodies cannot be guessed from a fixture while equality inside a file survives.
 * Registered identities are numbered by registry order (publisher first); anyone else takes the next free number, in ascending
 * real-id order within the snapshot. Numbers are stable across recordings because they are kept in `map`. */
export function pseudonymizeSnapshot(snapshot: PrSnapshot, registry: ProducerRegistry, previous: FixtureMap = newFixtureMap()): Pseudonymized {
  if (snapshot.observed_at === undefined) throw failure('missing:observed_at');
  const map: FixtureMap = { ...previous, actors: { ...previous.actors }, apps: { ...previous.apps }, refs: { ...previous.refs } };
  const number = (table: Record<string, number>, k: string): number => {
    const existing = table[k];
    if (existing !== undefined) return existing;
    const next = Object.keys(table).length + 1;
    table[k] = next;
    return next;
  };
  const app = (id: number | null): number | null => (id === null ? null : number(map.apps, String(id)));
  const identity = (id: { actor_id: number; app_id: number | null }): ProducerIdentity => {
    return { actor_id: number(map.actors, key(id)), app_id: app(id.app_id) };
  };
  const ref = (name: string): string => (SAFE_REFS.has(name) ? name : `ref${number(map.refs, name)}`);
  const out = { publisher: registry.publisher.map(identity), reviewers: registry.reviewers.map(identity) };
  const others = snapshot.reviews.map((r) => r.reviewer).sort((a, b) => (a.app_id ?? 0) - (b.app_id ?? 0) || a.actor_id - b.actor_id);
  for (const o of others) identity(o);
  const salted = (digest: string | null): string | null => (digest === null ? null : createHmac('sha256', Buffer.from(map.salt, 'hex')).update(digest).digest('hex'));
  const reviews = snapshot.reviews.map((r) => ({
    review_id: r.review_id, state: r.state, submitted_at: r.submitted_at, review_commit: r.review_commit,
    reviewer: identity(r.reviewer), has_feedback: r.has_feedback, feedback_digest: salted(r.feedback_digest),
  }));
  const pseudo = {
    pr_state: snapshot.pr_state, head: snapshot.head, base_sha: snapshot.base_sha, base_ref: ref(snapshot.base_ref),
    observed_at: snapshot.observed_at, reviews, complete: snapshot.complete, moved: snapshot.moved,
  };
  return { snapshot: assertFixtureFile({ version: 1, registry: out, snapshots: [pseudo] }).snapshots[0]!, registry: out, map };
}

const mapSchema = z
  .object({
    version: z.literal(1),
    salt: z.string().regex(/^[0-9a-f]{64}$/u),
    actors: z.record(z.number().int().positive()),
    apps: z.record(z.number().int().positive()),
    refs: z.record(z.number().int().positive()),
  })
  .strict();

const mapError = (code: string): Error => new Error(`FIXTURE_MAP_${code}`);

/** True when `dir` (which may not exist yet) resolves, through symlinks, to a place inside a git work tree or repository. */
function insideRepository(dir: string): boolean {
  let probe = resolve(dir);
  const tail: string[] = [];
  while (!existsSync(probe)) {
    if (probe === parse(probe).root) break;
    tail.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  let real = join(realpathSync(probe), ...tail);
  for (;;) {
    if (existsSync(join(real, '.git'))) return true;
    const up = dirname(real);
    if (up === real) return false;
    real = up;
  }
}

/** Sidecar location: `$OSSTACK_FIXTURE_MAP_DIR`, else `~/.config/osstack-bridge/fixture-maps`. Not the scratch root, because
 * scratch is routinely cleaned and the map must outlive the recording session to keep `--append` consistent. The directory must
 * be absolute and must not resolve (realpath) into any git work tree: the map holds real ids and the salt. */
export function fixtureMapPath(repo: string, pr: number, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const dir = env['OSSTACK_FIXTURE_MAP_DIR']?.trim() || join(homedir(), '.config', 'osstack-bridge', 'fixture-maps');
  if (!isAbsolute(dir)) throw mapError('DIR_NOT_ABSOLUTE');
  if (insideRepository(dir)) throw mapError('DIR_IN_REPOSITORY');
  return join(resolve(dir), `${repo.replace(/[^A-Za-z0-9._-]+/gu, '-')}-${pr}.json`);
}

/** Missing sidecar returns undefined; the caller must fail closed when it needs one (append). A symlink or non-file is refused. */
export async function readFixtureMap(path: string): Promise<FixtureMap | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw mapError('TARGET');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof Error && error.message === 'FIXTURE_MAP_TARGET') throw error;
    throw mapError('UNREADABLE');
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw mapError('UNREADABLE');
  }
  try {
    return mapSchema.parse(JSON.parse(text));
  } catch {
    throw mapError('INVALID');
  }
}

/** Atomic private write: the directory is created 0700 (or must already be a real directory owned by this user with no group or
 * other access), the target must be absent or a regular file, and the content goes to an exclusive 0600 temp file that is
 * fsynced and renamed over the target. */
export async function writeFixtureMap(path: string, map: FixtureMap): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw mapError('DIR_INVALID');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw mapError('DIR_OWNER');
  if ((info.mode & 0o077) !== 0) throw mapError('DIR_PERMISSIONS');
  try {
    const target = await lstat(path);
    if (!target.isFile()) throw mapError('TARGET');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof Error && error.message === 'FIXTURE_MAP_TARGET' ? error : mapError('UNREADABLE');
  }
  const temp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(map)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export interface LeakProbes {
  /** Source logins (any case); matched as substrings. */
  readonly logins: readonly string[];
  /** Real numeric actor and App ids; matched as whole tokens. */
  readonly ids: readonly number[];
}

/** Final scan of the bytes about to be written. Throws `FIXTURE_LEAK:<kind>`; never echoes what matched. */
export function scanForLeaks(text: string, probes: LeakProbes): void {
  const lower = text.toLowerCase();
  for (const login of probes.logins) if (login !== '' && lower.includes(login.toLowerCase())) throw new Error('FIXTURE_LEAK:login');
  for (const id of probes.ids) if (new RegExp(`(?<![0-9A-Za-z])${id}(?![0-9A-Za-z])`, 'u').test(text)) throw new Error('FIXTURE_LEAK:actor_id');
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/u.test(text)) throw new Error('FIXTURE_LEAK:email');
  if (lower.includes('http')) throw new Error('FIXTURE_LEAK:url');
  if (text.includes('@')) throw new Error('FIXTURE_LEAK:at_sign');
}

/** Merges one pseudonymised snapshot into a fixture file value (append) or starts a new one. */
export function fixtureWith(existing: unknown | undefined, added: Pseudonymized): FixtureFile {
  if (existing === undefined) return assertFixtureFile({ version: 1, registry: added.registry, snapshots: [added.snapshot] });
  const file = assertFixtureFile(existing);
  if (JSON.stringify(file.registry) !== JSON.stringify(added.registry)) throw failure('registry_mismatch');
  return assertFixtureFile({ ...file, snapshots: [...file.snapshots, added.snapshot] });
}
