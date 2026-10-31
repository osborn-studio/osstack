import { jointDigest } from './joint-json.js';
import { z } from 'zod';
import { Digest, Ref, Role, issue, unique } from './contract-primitives.js';
const Refs = z.array(Ref).max(256);
import { sourceSnapshotDigest as neutralSourceSnapshotDigest } from './source-contracts.js';
import { joint } from './joint-errors.js';
export { SourceSnapshot } from './source-contracts.js';
/** Same digest as the neutral helper, under the joint error code. */
export const sourceSnapshotDigest = (input: unknown): string => joint(() => neutralSourceSnapshotDigest(input));
export const MethodInput = z.object({ kind: z.literal('method_input'), schema_version: z.literal(1), role: Role, intent_digest: Digest, source_snapshot_digest: Digest, requested_materials: Refs }).strict();
export const EnvironmentBinding = z.object({ kind: z.literal('environment'), schema_version: z.literal(1), scope_id: Ref, repository: Ref, home_id: Ref, os: Ref, arch: Ref, filesystem: Ref, host_build_digest: Digest, provider: Ref, model: Ref, runtime: Ref, isolation: Ref, setup_fixture_digests: z.array(Digest).max(256) }).strict();
export const ScenarioBinding = z.object({ kind: z.literal('scenario'), schema_version: z.literal(1), driver_ref: Ref, definition_digest: Digest, action_schema_digest: Digest, input_fixture_digest: Digest }).strict();
export const CheckRegistry = z.object({ kind: z.literal('check_registry'), schema_version: z.literal(1), entries: z.array(z.object({ ref: z.string().regex(/^sha256:[a-f0-9]{64}$/), command_bytes_sha256: Digest, pass_codes: z.array(z.number().int().min(0).max(255)).min(1).max(256), fail_codes: z.array(z.number().int().min(0).max(255)).min(1).max(256) }).strict()).min(1).max(256) }).strict().superRefine((v, ctx) => {
  if (!unique(v.entries.map(e => e.ref)) || !unique(v.entries.map(e => e.command_bytes_sha256))) issue(ctx, 'DUPLICATE_CHECK_REF');
  if (v.entries.some(e => e.ref !== `sha256:${e.command_bytes_sha256}` || e.pass_codes.length !== 1 || e.pass_codes[0] !== 0)) issue(ctx, 'INVALID_CHECK_IDENTITY_OR_PASS_CODES');
  for (const e of v.entries) if (new Set([...e.pass_codes, ...e.fail_codes]).size !== e.pass_codes.length + e.fail_codes.length) issue(ctx, 'OVERLAPPING_EXIT_CODES');
});

export function checkRegistryDigest(input: unknown): string {
  const v = CheckRegistry.parse(input);
  v.entries.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  return jointDigest('osstack.joint.check-registry.v1', v);
}
export const methodInputDigest = (input: unknown): string => jointDigest('osstack.joint.method-input.v1', MethodInput.parse(input));
export const environmentDigest = (input: unknown): string => jointDigest('osstack.joint.environment.v1', EnvironmentBinding.parse(input));
export const scenarioDigest = (input: unknown): string => jointDigest('osstack.joint.scenario.v1', ScenarioBinding.parse(input));
