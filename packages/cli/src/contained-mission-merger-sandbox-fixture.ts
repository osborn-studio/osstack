// De-identification and validation for the recorded shadow-merger sandbox corpus (merger design 5.4, M-D). Used by
// scripts/sandbox-merger-scenario.mjs (through dist/merger-sandbox-fixture.js) and by tests; lazy-imported only.
//
// A recorded run is the ledger evidence and the registry the scenario used, plus one MergeSnapshot per scenario step. Everything that
// identifies a real actor, App, ruleset, review, check run, commit or Mission is replaced by a small pseudonym or a keyed hash, with
// every equality the gates test kept intact (one injective map per kind of id), so the gates give the same verdict on the fixture as
// they gave on the live PR. The real-id -> pseudonym map and the salt go to the private sidecar owned by contained-mission-bridge-fixture.ts.
import { createHmac, randomBytes } from 'node:crypto';
import type { MergeSnapshot, MergerRegistry, MissionMergeEvidence } from '@osstack/core';
import { z } from 'zod';
import { newFixtureMap, type FixtureMap } from './contained-mission-bridge-fixture.js';

export const PSEUDO_REPOSITORY = 'o/r';
/** Rebased clock origin: recorded times are offsets from this, never wall-clock times of the recording. */
export const FIXTURE_EPOCH_MS = 1_800_000_000_000;

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
/** Pseudonyms are small integers; a real GitHub id (millions) cannot pass. */
const pseudonym = z.number().int().min(1).max(999);
const missionId = z.string().regex(/^cm_[0-9a-f-]{36}$/u);
const branch = z.string().regex(/^osstack\/mission\/cm_[0-9a-f-]{36}$/u);
// Protocol vocabulary is a closed set: a value outside it is rejected (fail closed), never copied, so free text cannot ride in a status field.
const mergeable = z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const mergeState = z.enum(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
const reviewDecision = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
const runStatus = z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);
const runConclusion = z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']);
const enforcement = z.enum(['active', 'evaluate', 'disabled']);
const ruleType = z.enum(['creation', 'update', 'deletion', 'required_linear_history', 'merge_queue', 'required_deployments', 'required_signatures', 'pull_request', 'required_status_checks',
  'non_fast_forward', 'commit_message_pattern', 'commit_author_email_pattern', 'committer_email_pattern', 'branch_name_pattern', 'tag_name_pattern', 'file_path_restriction',
  'max_file_path_length', 'file_extension_restriction', 'max_file_size', 'workflows', 'code_scanning', 'copilot_code_review']);
const repo = z.literal(PSEUDO_REPOSITORY);
const offsetMs = z.number().int().min(FIXTURE_EPOCH_MS).max(FIXTURE_EPOCH_MS + 86_400_000);

const identity = z.object({ actor_id: pseudonym, app_id: pseudonym }).strict();
const checkRun = z.object({
  id: pseudonym, app_id: pseudonym.nullable(), name: z.string().regex(/^[A-Za-z0-9 ._()/-]{1,80}$/u),
  external_id: z.string().regex(/^(?:cm_[0-9a-f-]{36}:[0-9a-f]{40}|ext-[0-9a-f]{12})$/u).nullable(), head_sha: oid, status: runStatus, conclusion: runConclusion.nullable(),
}).strict();
const bypass = z.object({ actor_type: z.enum(['Integration', 'RepositoryRole', 'OrganizationAdmin', 'Team', 'DeployKey']), actor_id: pseudonym.nullable(), bypass_mode: z.enum(['always', 'pull_request', 'exempt']) }).strict();
const ruleset = z.object({
  enforcement, covers_mission_refs: z.boolean(), covers_base_ref: z.boolean(), rule_types: z.array(ruleType).max(32),
  bypass_actors: z.array(bypass).max(16).nullable(),
}).strict();

export const mergeSnapshotSchema = z.object({
  pr: z.object({
    number: z.number().int().positive(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']), is_draft: z.boolean(), mergeable, merge_state_status: mergeState, review_decision: reviewDecision.nullable(),
    base_repository: repo, head_repository: repo, is_cross_repository: z.boolean(), head_ref_name: branch, base_ref_name: z.literal('main'), head_oid: oid,
    author: z.object({ type: z.enum(['Bot', 'User', 'Other']), database_id: pseudonym.nullable() }).strict().nullable(),
    base_tip_oid: oid.nullable(), base_tip_crosscheck_oid: oid.nullable(),
  }).strict(),
  marker: z.object({
    marker: z.object({ id: missionId, spec_digest: digest, start: oid, head: oid }).strict().nullable(),
    candidates: z.number().int().min(0).max(99), malformed: z.number().int().min(0).max(99), first_line_id: missionId.nullable(),
  }).strict(),
  files: z.object({ complete: z.boolean(), workflow_paths_changed: z.boolean() }).strict(),
  reviews: z.object({ complete: z.boolean(), items: z.array(z.object({
    review_id: pseudonym, state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING']), submitted_at_ms: offsetMs, commit_oid: oid.nullable(),
    author_type: z.enum(['Bot', 'User', 'Other']), author_id: pseudonym.nullable(), author_can_push: z.boolean(),
  }).strict()).max(200) }).strict(),
  threads: z.object({ complete: z.boolean(), unresolved: z.number().int().min(0).max(999) }).strict(),
  timeline: z.object({ complete: z.boolean(), force_push_events: z.number().int().min(0).max(999) }).strict(),
  verify: z.object({ complete: z.boolean(), runs: z.array(checkRun).max(200) }).strict(),
  required_runs: z.object({ complete: z.boolean(), runs: z.array(checkRun).max(200) }).strict(),
  base_rules: z.object({
    complete: z.boolean(),
    status_checks: z.array(z.object({ context: z.string().regex(/^[A-Za-z0-9 ._()/-]{1,80}$/u), integration_id: pseudonym.nullable(), ruleset_id: pseudonym.nullable() }).strict()).max(64),
    pull_request: z.object({
      ruleset_id: pseudonym.nullable(), required_approving_review_count: z.number().int().min(0).max(99), require_last_push_approval: z.boolean(),
      required_review_thread_resolution: z.boolean(), dismiss_stale_reviews_on_push: z.boolean(),
    }).strict().nullable(),
    legacy: z.object({
      read: z.enum(['ok', 'not_protected', 'failed']),
      checks: z.array(z.object({ context: z.string().regex(/^[A-Za-z0-9 ._()/-]{1,80}$/u), app_id: pseudonym.nullable() }).strict()).max(64),
      contexts: z.array(z.string().regex(/^[A-Za-z0-9 ._()/-]{1,80}$/u)).max(64),
    }).strict(),
  }).strict(),
  mission_rules: z.object({ complete: z.boolean(), ruleset_ids: z.array(pseudonym).max(16), rule_types: z.array(ruleType).max(32) }).strict(),
  rulesets: z.record(z.string().regex(/^[0-9]{3}$/u), ruleset.optional()),
}).strict();

const evidenceSchema = z.object({
  mission_id: missionId, spec_digest: digest, start_commit: oid, candidate_head: oid, repository: repo, branch, base: z.literal('main'), base_head: oid.nullable(), head: oid,
  pr_number: z.number().int().positive(), publication_kind: z.enum(['opened', 'evidence_missing', 'opened_before_cancel']).nullable(), pushed_commit: oid.nullable(),
  record_digest: digest, recomputed_digest: digest, event_digest: digest, join_count: z.number().int().min(0).max(99),
}).strict();

const registrySchema = z.object({
  repository: repo, base_ref: z.literal('main'), publisher: identity, merger: identity, evidence_app_id: pseudonym,
  counted_approvers: z.array(z.object({ actor_id: pseudonym, app_id: z.null() }).strict()).min(1).max(8),
  required_checks: z.array(z.object({ context: z.string().regex(/^[A-Za-z0-9 ._()/-]{1,80}$/u), app_id: pseudonym }).strict()).min(1).max(16),
  main_quality_ruleset_id: pseudonym, main_update_ruleset_id: pseudonym, mission_ruleset_ids: z.array(pseudonym).length(2),
}).strict();

export const TIMELINE_EVENT_TYPES = ['HeadRefForcePushedEvent', 'BaseRefChangedEvent', 'MergedEvent', 'ClosedEvent', 'ReopenedEvent'] as const;
const stepSchema = z.object({
  label: z.string().regex(/^[a-z0-9_]{1,48}$/u),
  /** Fixture time of the read (offset from FIXTURE_EPOCH_MS). */
  observed_at: offsetMs,
  snapshot: mergeSnapshotSchema,
  timeline_events: z.array(z.enum(TIMELINE_EVENT_TYPES)).max(200),
}).strict();

export const mergerFixtureFileSchema = z.object({
  version: z.literal(1),
  /** The sandbox cannot produce `would_merge` without the owner's own approval (design 8, decision 5): such steps are listed here, never faked. */
  not_recorded: z.array(z.object({ label: z.string().regex(/^[a-z0-9_]{1,48}$/u), reason: z.string().regex(/^[A-Za-z0-9 ,.;:()_-]{1,200}$/u) }).strict()).max(16),
  registry: registrySchema,
  evidence: evidenceSchema,
  steps: z.array(stepSchema).min(1).max(32),
}).strict();

export type MergerFixtureFile = z.infer<typeof mergerFixtureFileSchema>;
export type MergerFixtureStep = z.infer<typeof stepSchema>;

const failure = (reason: string): Error => new Error(`FIXTURE_REJECTED:${reason}`);

/** Throws `FIXTURE_REJECTED:<path>` for the first violation; never echoes the offending value. */
export function assertMergerFixtureFile(value: unknown): MergerFixtureFile {
  const result = mergerFixtureFileSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw failure(`${issue?.code ?? 'invalid'}:${issue?.path.join('.') || 'root'}`);
  }
  return result.data;
}

/** What the scenario hands over: real values, exactly as the reader and the ledger produced them. */
export interface MergerSandboxRun {
  readonly evidence: MissionMergeEvidence;
  readonly registry: MergerRegistry;
  readonly steps: ReadonlyArray<{ label: string; observed_at: number; snapshot: MergeSnapshot; timeline_events: readonly string[] }>;
  readonly not_recorded: ReadonlyArray<{ label: string; reason: string }>;
}

export interface MergerPseudonymized {
  readonly file: MergerFixtureFile;
  /** Real-id -> pseudonym state and the salt; PRIVATE sidecar only (actors `a:<id>`, apps `<id>`, refs `rs:`/`rv:`/`cr:` for rulesets, reviews, check runs). */
  readonly map: FixtureMap;
  /** Every real value that must not appear in the fixture, for the final leak scan. */
  readonly probes: { readonly ids: readonly number[]; readonly strings: readonly string[] };
}

/**
 * Pseudonymises a whole recorded run. Every id kind has its own injective table (actors from 1, Apps from 101, rulesets from 201,
 * reviews and check runs by ascending real id so "lowest/latest id" tie-breaks survive); commits, digests and the Mission id are keyed
 * hashes (HMAC-SHA256 with the per-file salt) of the real value, so equality inside the file survives and nothing outside it can be derived.
 * A value the scenario does not produce (another repository, a branch that is not the Mission's, a non-main base) throws: the recorder fails closed.
 */
export function pseudonymizeMergerRun(run: MergerSandboxRun, salt: string = randomBytes(32).toString('hex')): MergerPseudonymized {
  const map = newFixtureMap(salt);
  const key = Buffer.from(salt, 'hex');
  const mac = (kind: string, value: string): string => createHmac('sha256', key).update(`${kind}\u0000${value}`).digest('hex');
  const ids = new Set<number>();
  const strings = new Set<string>();
  /** Only ids that could identify something are probed for: a role id like 5 would match any pseudonym. */
  const probe = (n: number): void => { if (n >= 1000) ids.add(n); };
  const counters = { actor: 0, app: 100, ruleset: 200 };
  const assign = (t: Record<string, number>, k: string, kind: keyof typeof counters, realId: number): number => {
    probe(realId);
    const have = t[k];
    if (have !== undefined) return have;
    counters[kind] += 1;
    t[k] = counters[kind];
    return counters[kind];
  };
  const actor = (id: number): number => assign(map.actors, `a:${id}`, 'actor', id);
  const app = (id: number): number => assign(map.apps, String(id), 'app', id);
  const rulesetPseudo = (id: number): number => assign(map.refs, `rs:${id}`, 'ruleset', id);
  const oidOf = (value: string): string => { strings.add(value); return mac('oid', value).slice(0, value.length); };
  const digestOf = (value: string): string => { strings.add(value); return mac('digest', value); };
  // Check names and contexts are free text on GitHub: only the registered required contexts and `osstack/verify` (both public, from committed files)
  // are kept; anything else is replaced by a keyed hash, so a name can never carry a person, a login or a commit.
  const knownNames = new Set(['osstack/verify', ...run.registry.required_checks.map((c) => c.context)]);
  const nameOf = (value: string): string => { if (knownNames.has(value)) return value; strings.add(value); return `other-${mac('name', value).slice(0, 10)}`; };
  const nullable = <T, U>(v: T | null, f: (x: T) => U): U | null => (v === null ? null : f(v));

  const e = run.evidence;
  const r = run.registry;
  if (e.repository.toLowerCase() !== r.repository.toLowerCase()) throw failure('repository_mismatch');
  strings.add(e.repository); strings.add(e.branch);
  const hex = mac('mission', e.mission_id).slice(0, 32);
  const pseudoMission = `cm_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  strings.add(e.mission_id);
  const missionIdOf = (value: string): string => { if (value !== e.mission_id) throw failure('foreign_mission_id'); return pseudoMission; };
  const pseudoBranch = `osstack/mission/${pseudoMission}`;
  const repositoryOf = (value: string): typeof PSEUDO_REPOSITORY => { if (value.toLowerCase() !== e.repository.toLowerCase()) throw failure('foreign_repository'); return PSEUDO_REPOSITORY; };
  const externalOf = (value: string | null): string | null => {
    if (value === null) return null;
    const m = /^(cm_[0-9a-f-]{36}):([0-9a-f]{40})$/u.exec(value);
    if (m && m[1] === e.mission_id) return `${pseudoMission}:${oidOf(m[2] as string)}`;
    strings.add(value);
    return `ext-${mac('ext', value).slice(0, 12)}`;
  };

  // Registered identities first so they take the lowest numbers.
  const registry = {
    repository: PSEUDO_REPOSITORY, base_ref: r.base_ref,
    publisher: { actor_id: actor(r.publisher.actor_id), app_id: app(r.publisher.app_id) },
    merger: { actor_id: actor(r.merger.actor_id), app_id: app(r.merger.app_id) },
    evidence_app_id: app(r.evidence_app_id),
    counted_approvers: r.counted_approvers.map((a) => ({ actor_id: actor(a.actor_id), app_id: null })),
    required_checks: r.required_checks.map((c) => ({ context: nameOf(c.context), app_id: app(c.app_id) })),
    main_quality_ruleset_id: rulesetPseudo(r.main_quality_ruleset_id), main_update_ruleset_id: rulesetPseudo(r.main_update_ruleset_id),
    mission_ruleset_ids: [...r.mission_ruleset_ids].sort((a, b) => a - b).map(rulesetPseudo),
  };

  // Review and check-run ids are numbered by ascending real id across the whole run, so one real review/run keeps one number in every step.
  const allReviewIds = [...new Set(run.steps.flatMap((s) => s.snapshot.reviews.items.map((i) => i.review_id)))].sort((a, b) => a - b);
  const allRunIds = [...new Set(run.steps.flatMap((s) => [...s.snapshot.verify.runs, ...s.snapshot.required_runs.runs].map((x) => x.id)))].sort((a, b) => a - b);
  allReviewIds.forEach((id, i) => { map.refs[`rv:${id}`] = i + 1; probe(id); });
  allRunIds.forEach((id, i) => { map.refs[`cr:${id}`] = i + 1; probe(id); });
  const reviewPseudo = (id: number): number => { const v = map.refs[`rv:${id}`]; if (v === undefined) throw failure('unknown_review'); return v; };
  const runPseudo = (id: number): number => { const v = map.refs[`cr:${id}`]; if (v === undefined) throw failure('unknown_run'); return v; };

  // Time: offsets from the first instant seen, so absolute recording times never reach the file.
  const instants = run.steps.flatMap((s) => [s.observed_at, ...s.snapshot.reviews.items.map((i) => i.submitted_at_ms)]);
  const origin = Math.min(...instants);
  const rebased = (ms: number): number => FIXTURE_EPOCH_MS + (ms - origin);

  const evidence = {
    mission_id: pseudoMission, spec_digest: digestOf(e.spec_digest), start_commit: oidOf(e.start_commit), candidate_head: oidOf(e.candidate_head), repository: repositoryOf(e.repository),
    branch: ((): string => { if (e.branch !== `osstack/mission/${e.mission_id}`) throw failure('branch_is_not_the_missions'); return pseudoBranch; })(),
    base: e.base, base_head: nullable(e.base_head, oidOf), head: oidOf(e.head), pr_number: e.pr_number, publication_kind: e.publication_kind,
    pushed_commit: nullable(e.pushed_commit, oidOf), record_digest: digestOf(e.record_digest), recomputed_digest: digestOf(e.recomputed_digest), event_digest: digestOf(e.event_digest),
    join_count: e.join_count,
  };

  const runOf = (x: MergeSnapshot['verify']['runs'][number]) => ({
    id: runPseudo(x.id), app_id: nullable(x.app_id, app), name: nameOf(x.name), external_id: externalOf(x.external_id), head_sha: oidOf(x.head_sha), status: x.status, conclusion: x.conclusion,
  });
  const steps = run.steps.map((step) => {
    const s = step.snapshot;
    const snapshot = {
      pr: {
        number: s.pr.number, state: s.pr.state, is_draft: s.pr.is_draft, mergeable: s.pr.mergeable, merge_state_status: s.pr.merge_state_status, review_decision: s.pr.review_decision,
        base_repository: repositoryOf(s.pr.base_repository), head_repository: repositoryOf(s.pr.head_repository), is_cross_repository: s.pr.is_cross_repository,
        head_ref_name: ((): string => { if (s.pr.head_ref_name !== e.branch) throw failure('head_ref_is_not_the_missions'); return pseudoBranch; })(),
        base_ref_name: s.pr.base_ref_name, head_oid: oidOf(s.pr.head_oid),
        author: s.pr.author === null ? null : { type: s.pr.author.type, database_id: nullable(s.pr.author.database_id, actor) },
        base_tip_oid: nullable(s.pr.base_tip_oid, oidOf), base_tip_crosscheck_oid: nullable(s.pr.base_tip_crosscheck_oid, oidOf),
      },
      marker: {
        marker: s.marker.marker === null ? null : { id: missionIdOf(s.marker.marker.id), spec_digest: digestOf(s.marker.marker.spec_digest), start: oidOf(s.marker.marker.start), head: oidOf(s.marker.marker.head) },
        candidates: s.marker.candidates, malformed: s.marker.malformed, first_line_id: nullable(s.marker.first_line_id, missionIdOf),
      },
      files: { ...s.files },
      reviews: { complete: s.reviews.complete, items: s.reviews.items.map((i) => ({
        review_id: reviewPseudo(i.review_id), state: i.state, submitted_at_ms: rebased(i.submitted_at_ms), commit_oid: nullable(i.commit_oid, oidOf),
        author_type: i.author_type, author_id: nullable(i.author_id, actor), author_can_push: i.author_can_push,
      })) },
      threads: { ...s.threads },
      timeline: { ...s.timeline },
      verify: { complete: s.verify.complete, runs: s.verify.runs.map(runOf) },
      required_runs: { complete: s.required_runs.complete, runs: s.required_runs.runs.map(runOf) },
      base_rules: {
        complete: s.base_rules.complete,
        status_checks: s.base_rules.status_checks.map((c) => ({ context: nameOf(c.context), integration_id: nullable(c.integration_id, app), ruleset_id: nullable(c.ruleset_id, rulesetPseudo) })),
        pull_request: s.base_rules.pull_request === null ? null : { ...s.base_rules.pull_request, ruleset_id: nullable(s.base_rules.pull_request.ruleset_id, rulesetPseudo) },
        legacy: { read: s.base_rules.legacy.read, checks: s.base_rules.legacy.checks.map((c) => ({ context: nameOf(c.context), app_id: nullable(c.app_id, app) })), contexts: s.base_rules.legacy.contexts.map(nameOf) },
      },
      mission_rules: { complete: s.mission_rules.complete, ruleset_ids: s.mission_rules.ruleset_ids.map(rulesetPseudo), rule_types: [...s.mission_rules.rule_types] },
      rulesets: Object.fromEntries(Object.entries(s.rulesets).map(([id, v]) => [String(rulesetPseudo(Number(id))), v === undefined ? undefined : {
        enforcement: v.enforcement, covers_mission_refs: v.covers_mission_refs, covers_base_ref: v.covers_base_ref, rule_types: [...v.rule_types],
        bypass_actors: v.bypass_actors === null ? null : v.bypass_actors.map((b) => ({ actor_type: b.actor_type, actor_id: nullable(b.actor_id, b.actor_type === 'Integration' ? app : actor), bypass_mode: b.bypass_mode })),
      }])),
    };
    return { label: step.label, observed_at: rebased(step.observed_at), snapshot, timeline_events: [...step.timeline_events] };
  });

  const file = assertMergerFixtureFile({ version: 1, not_recorded: run.not_recorded, registry, evidence, steps });
  return { file, map, probes: { ids: [...ids], strings: [...strings] } };
}

export interface MergerLeakProbes {
  /** Source logins and slugs (any case); matched as substrings. */
  readonly logins: readonly string[];
  /** Real numeric ids; matched as whole tokens. */
  readonly ids: readonly number[];
  /** Real strings (commit ids, digests, the Mission id, the branch, the repository); matched as substrings, case-insensitively. */
  readonly strings: readonly string[];
}

/** Final scan of the bytes about to be written. Throws `FIXTURE_LEAK:<kind>`; never echoes what matched. */
export function scanMergerFixtureForLeaks(text: string, probes: MergerLeakProbes): void {
  const lower = text.toLowerCase();
  for (const login of probes.logins) if (login !== '' && lower.includes(login.toLowerCase())) throw new Error('FIXTURE_LEAK:login');
  for (const s of probes.strings) if (s !== '' && lower.includes(s.toLowerCase())) throw new Error('FIXTURE_LEAK:value');
  // Keyed hashes (commits, digests, the Mission id, generated names) are removed first: a run of digits inside one is chance, not a leak. Elsewhere an id is
  // caught wherever it sits, also glued to letters (`other-123x`), as long as no further digit touches it.
  const plain = text.replace(/[0-9a-f]{40,64}/gu, '#').replace(/cm_[0-9a-f-]{36}/gu, '#').replace(/\b(?:ext|other)-[0-9a-f]{10,12}\b/gu, '#');
  for (const id of probes.ids) if (new RegExp(`(?<![0-9])${id}(?![0-9])`, 'u').test(plain)) throw new Error('FIXTURE_LEAK:id');
  if (lower.includes('http')) throw new Error('FIXTURE_LEAK:url');
  if (text.includes('@')) throw new Error('FIXTURE_LEAK:at_sign');
}
