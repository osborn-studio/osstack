// De-identification and validation for recorded PrSnapshot fixtures (appendix §5.4). Used by
// scripts/record-pr-timeline.mjs (through dist/bridge-fixture.js) and by tests; lazy-imported only.
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
    base_ref: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/u),
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

const key = (id: { actor_id: number; app_id: number | null }): string => `${id.app_id ?? 'u'}:${id.actor_id}`;

export interface Pseudonymized {
  readonly snapshot: FixtureSnapshot;
  readonly registry: { publisher: ProducerIdentity[]; reviewers: ProducerIdentity[] };
}

/** Replaces every actor id and App id with a small integer. Registered identities are numbered by registry order
 * (publisher first), so they are identical in every file recorded with the same registry; identities outside the registry
 * follow in ascending real-id order and are consistent within the snapshot. */
export function pseudonymizeSnapshot(snapshot: PrSnapshot, registry: ProducerRegistry): Pseudonymized {
  if (snapshot.observed_at === undefined) throw failure('missing:observed_at');
  const actors = new Map<string, number>();
  const apps = new Map<number, number>();
  const app = (id: number | null): number | null => {
    if (id === null) return null;
    let mapped = apps.get(id);
    if (mapped === undefined) { mapped = apps.size + 1; apps.set(id, mapped); }
    return mapped;
  };
  const identity = (id: { actor_id: number; app_id: number | null }): ProducerIdentity => {
    const k = key(id);
    let mapped = actors.get(k);
    if (mapped === undefined) { mapped = actors.size + 1; actors.set(k, mapped); }
    return { actor_id: mapped, app_id: app(id.app_id) };
  };
  const out = { publisher: registry.publisher.map(identity), reviewers: registry.reviewers.map(identity) };
  const others = snapshot.reviews.map((r) => r.reviewer).sort((a, b) => (a.app_id ?? 0) - (b.app_id ?? 0) || a.actor_id - b.actor_id);
  for (const o of others) identity(o);
  const reviews = snapshot.reviews.map((r) => ({
    review_id: r.review_id, state: r.state, submitted_at: r.submitted_at, review_commit: r.review_commit,
    reviewer: identity(r.reviewer), has_feedback: r.has_feedback, feedback_digest: r.feedback_digest,
  }));
  const pseudo = {
    pr_state: snapshot.pr_state, head: snapshot.head, base_sha: snapshot.base_sha, base_ref: snapshot.base_ref,
    observed_at: snapshot.observed_at, reviews, complete: snapshot.complete, moved: snapshot.moved,
  };
  return { snapshot: assertFixtureFile({ version: 1, registry: out, snapshots: [pseudo] }).snapshots[0]!, registry: out };
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
