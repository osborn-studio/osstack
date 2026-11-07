// Registry for the bridge shadow merger (merger design §5.2): `$OSSTACK_HOME/bridge/merger.json`. Host-private, numeric ids only.
// Deliberately independent of loadBridgeConfig and of every App-credential module: it never reads apps.json, rulesets.json or a key,
// and the schema has no field that could hold one. Missing file -> undefined (merger off); present but invalid -> throws.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MergerRegistry } from '@osstack/core';
import { z } from 'zod';

const positive = z.number().int().positive();
const identity = z.object({ actor_id: positive, app_id: positive }).strict();
const checkSchema = z.object({ context: z.string().min(1).max(200), app_id: positive }).strict();
const configSchema = z
  .object({
    version: z.literal(1),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    /** App A: `actor_id` is its bot user id (PR `author.databaseId`), `app_id` the App id. */
    publisher: identity,
    /** App B, the `osstack/verify` producer. */
    evidence_app_id: positive,
    /** App E: `actor_id` is its bot user id (`mergedBy`), `app_id` the App id. */
    merger: identity,
    /** The only target branch (G2a). */
    base_ref: z.literal('main'),
    inspection_evidence: z.boolean(),
    /** P-5: only Users count; an App approval never does, so `app_id` must be null. */
    counted_approvers: z.array(z.object({ actor_id: positive, app_id: z.null() }).strict()).nonempty(),
    required_checks: z.array(checkSchema).nonempty(),
    main_quality_ruleset_id: positive,
    main_update_ruleset_id: positive,
    mission_ruleset_ids: z.array(positive).length(2),
  })
  .strict();

export interface MergerConfig extends MergerRegistry {
  readonly inspection_evidence: boolean;
  /** The owner reviewer: the first (today the only) counted approver's user id. */
  readonly owner_reviewer_id: number;
  /** Registered check producers (App ids of `required_checks`, sorted, de-duplicated); App B is separate (`evidence_app_id`). */
  readonly producers: readonly number[];
}

const invalid = (reason: string): Error => new Error(`MERGER_CONFIG_INVALID:merger.json:${reason}`);
/** A key that names a credential anywhere in the document is refused with a dedicated reason, whatever else is wrong. */
const CREDENTIAL_KEY = /(?:private|pem|secret|token|credential|installation|password|passphrase|(?:^|_)key(?:$|_))/iu;

function findCredentialKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => findCredentialKey(item, depth + 1));
  return Object.entries(value).some(([key, inner]) => CREDENTIAL_KEY.test(key) || findCredentialKey(inner, depth + 1));
}

/** Missing file -> undefined (shadow merger off). Present but invalid -> `MERGER_CONFIG_INVALID:merger.json:<reason>`. */
export async function loadMergerConfig(home: string): Promise<MergerConfig | undefined> {
  let text: string;
  try {
    text = await readFile(join(home, 'bridge', 'merger.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid(`unreadable:${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalid('json');
  }
  if (findCredentialKey(json)) throw invalid('credential_field');
  const result = configSchema.safeParse(json);
  if (!result.success) throw invalid(result.error.issues[0]?.path.join('.') || 'root');
  const c = result.data;
  const approvers = c.counted_approvers.map((a) => a.actor_id);
  if (new Set(approvers).size !== approvers.length) throw invalid('duplicate_approver');
  // The three Apps (and their bot users) must be three different identities; an approver must be none of them.
  const apps = [c.publisher.app_id, c.evidence_app_id, c.merger.app_id];
  const bots = [c.publisher.actor_id, c.merger.actor_id];
  if (new Set(apps).size !== apps.length) throw invalid('app_ids_overlap');
  if (new Set(bots).size !== bots.length) throw invalid('bot_ids_overlap');
  if (approvers.some((id) => bots.includes(id))) throw invalid('approver_is_app');
  const keys = c.required_checks.map((r) => `${r.context}\u0000${r.app_id}`);
  if (new Set(keys).size !== keys.length) throw invalid('duplicate_required_check');
  const rulesets = [c.main_quality_ruleset_id, c.main_update_ruleset_id, ...c.mission_ruleset_ids];
  if (new Set(rulesets).size !== rulesets.length) throw invalid('ruleset_ids_overlap');
  return {
    repository: c.repository,
    base_ref: c.base_ref,
    publisher: c.publisher,
    merger: c.merger,
    evidence_app_id: c.evidence_app_id,
    counted_approvers: c.counted_approvers,
    required_checks: c.required_checks,
    main_quality_ruleset_id: c.main_quality_ruleset_id,
    main_update_ruleset_id: c.main_update_ruleset_id,
    mission_ruleset_ids: [...c.mission_ruleset_ids].sort((a, b) => a - b),
    inspection_evidence: c.inspection_evidence,
    owner_reviewer_id: approvers[0] as number,
    producers: [...new Set(c.required_checks.map((r) => r.app_id))].sort((a, b) => a - b),
  };
}
