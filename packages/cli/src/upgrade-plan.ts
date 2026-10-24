import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DeploymentIdentitySchema, type HomeObservation } from './home-inventory.js';

export const UpgradeDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const UpgradeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const homeId = z.string().regex(/^home_[a-f0-9]{32}$/);
const time = z.number().int().nonnegative().safe();
export const UpgradeTargetSchema = z.object({
  version: z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/),
  build_digest: UpgradeDigest, protocol_version: z.number().int().positive(), database_schema: z.number().int().nonnegative(),
  readable_schema_min: z.number().int().nonnegative(), readable_schema_max: z.number().int().nonnegative(),
}).strict().refine(v => v.readable_schema_min <= v.readable_schema_max && v.database_schema >= v.readable_schema_min && v.database_schema <= v.readable_schema_max);
export const UpgradeBudgetSchema = z.object({ max_total_ms: z.number().int().min(1).max(3600000),
  max_step_ms: z.number().int().min(1).max(300000), max_steps: z.number().int().min(1).max(512) }).strict()
  .refine(v => v.max_step_ms <= v.max_total_ms);
export const UpgradePlanRequestSchema = z.object({ schema_version: z.literal(1), expires_at_ms: time,
  target: UpgradeTargetSchema, budget: UpgradeBudgetSchema,
  groups: z.array(z.object({ group_id: UpgradeId, installation_id: UpgradeId, deployment_kind: z.enum(['npm', 'checkout']),
    home_ids: z.array(homeId).min(1).max(32) }).strict()).min(1).max(32),
}).strict().superRefine((v, ctx) => {
  for (const values of [v.groups.map(g => g.group_id), v.groups.map(g => g.installation_id), v.groups.flatMap(g => g.home_ids)])
    if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate_group_installation_or_home' });
  if (v.groups.flatMap(g => g.home_ids).length > 32) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'home_limit' });
});
export const UpgradePlanHomeSchema = z.object({ home_id: homeId, socket: z.string().max(4096).refine(isAbsolute),
  observed_at_ms: time, identity: DeploymentIdentitySchema.nullable() }).strict();
export const UpgradePlanGroupSchema = z.object({ group_id: UpgradeId, installation_id: UpgradeId,
  deployment_kind: z.enum(['npm', 'checkout']), homes: z.array(UpgradePlanHomeSchema).min(1).max(32),
  qualification: z.literal('qualification_pending'), reasons: z.array(z.string().max(128)).min(1).max(160),
}).strict();
export const UpgradePlanSchema = z.object({ schema_version: z.literal(1), mode: z.literal('plan_only'), budget_scope: z.literal('per_group'), created_at_ms: time,
  expires_at_ms: time, target: UpgradeTargetSchema, budget: UpgradeBudgetSchema, groups: z.array(UpgradePlanGroupSchema).min(1).max(32),
  authority: z.literal('none'), rollback: z.literal('no_database_restore'),
}).strict().superRefine((v, ctx) => {
  const homes = v.groups.flatMap(g => g.homes);
  for (const values of [v.groups.map(g => g.group_id), v.groups.map(g => g.installation_id), homes.map(h => h.home_id), homes.map(h => h.socket)])
    if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate_plan_identity' });
  if (homes.length > 32 || v.expires_at_ms <= v.created_at_ms || v.expires_at_ms - v.created_at_ms > 86400000)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'plan_bounds' });
});
export type UpgradePlan = z.infer<typeof UpgradePlanSchema>;
export type UpgradePlanGroup = UpgradePlan['groups'][number];
export type UpgradePlanHome = UpgradePlanGroup['homes'][number];
export interface FrozenUpgradePlan { digest: string; plan: UpgradePlan }

export function upgradeCanonical(value: unknown): string {
  const active = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || active.has(item)) throw Error('upgrade_non_json_value');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw Error('upgrade_non_json_value');
    active.add(item);
    try { return Array.isArray(item) ? `[${Array.from(item, encode).join(',')}]`
      : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(',')}}`; }
    finally { active.delete(item); }
  };
  return encode(value);
}
export function upgradeDigest(value: unknown): string { return createHash('sha256').update(upgradeCanonical(value)).digest('hex'); }
export function freezeUpgradePlan(value: unknown): FrozenUpgradePlan {
  const plan = UpgradePlanSchema.parse(value);
  if (Buffer.byteLength(upgradeCanonical(plan)) > 262144) throw Error('upgrade_plan_size');
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(plan); return Object.freeze({ digest: upgradeDigest(plan), plan });
}

/** Inventory supplies observations, never shared-consumer completeness or apply authority. */
export function createUpgradePlan(raw: unknown, observations: readonly HomeObservation[], nowMs = Date.now()): FrozenUpgradePlan {
  const request = UpgradePlanRequestSchema.parse(raw); time.parse(nowMs);
  if (request.expires_at_ms <= nowMs || request.expires_at_ms - nowMs > 86400000) throw Error('upgrade_plan_expiry');
  if (observations.length > 32) throw Error('upgrade_inventory_limit');
  const ids = observations.map(o => o.desired.home_id);
  if (new Set(ids).size !== ids.length) throw Error('upgrade_inventory_duplicate');
  const groups = request.groups.map(group => {
    const reasons = ['shared_consumers_not_attested', 'native_updater_not_qualified'];
    if (request.budget.max_steps < 5 * group.home_ids.length + 2) reasons.push('insufficient_step_budget');
    if (group.deployment_kind !== 'npm') reasons.push('checkout_updater_unsupported');
    const homes = group.home_ids.map(id => {
      const row = observations.find(o => o.desired.home_id === id);
      if (!row) throw Error('upgrade_home_not_in_inventory');
      const identity = row.observed === null ? null : DeploymentIdentitySchema.parse(row.observed);
      if (!row.desired.enabled || !['matched_requested', 'drift'].includes(row.status) || !identity) reasons.push(`home_unavailable:${id}`);
      if (identity && (identity.home_id !== id || identity.deployment_kind !== group.deployment_kind || identity.build_digest === null)) reasons.push(`identity_unqualified:${id}`);
      if (identity && identity.database_schema > request.target.database_schema) reasons.push(`schema_downgrade_unsupported:${id}`);
      if (identity && (identity.database_schema < request.target.readable_schema_min || identity.database_schema > request.target.readable_schema_max)) reasons.push(`schema_incompatible:${id}`);
      if (row.observed_at_ms > nowMs || nowMs - row.observed_at_ms > 30000) reasons.push(`observation_stale:${id}`);
      return UpgradePlanHomeSchema.parse({ home_id: id, socket: row.desired.socket, observed_at_ms: row.observed_at_ms, identity });
    });
    return { group_id: group.group_id, installation_id: group.installation_id, deployment_kind: group.deployment_kind, homes,
      qualification: 'qualification_pending' as const, reasons };
  });
  if (new Set(groups.flatMap(g => g.homes.map(h => h.socket))).size !== groups.flatMap(g => g.homes).length) throw Error('upgrade_duplicate_socket');
  return freezeUpgradePlan({ schema_version: 1, mode: 'plan_only', budget_scope: 'per_group', created_at_ms: nowMs, expires_at_ms: request.expires_at_ms,
    target: request.target, budget: request.budget, groups, authority: 'none', rollback: 'no_database_restore' });
}
