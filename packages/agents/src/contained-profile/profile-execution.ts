import { createHash } from 'node:crypto';
import { prepareContainedImage, createContainedCommandExecutor } from '../contained.js';
import type { ContainedCandidateFile, ContainedImageOptions, ContainedImageReceipt } from '../contained-image.js';
import type { ContainedProfileRunResult } from '../contained-command.js';
import type { ContainedProfileRunOptions } from '../contained-profile-run.js';
import { canonicalJson } from '@osstack/protocol/source';
import { profileIdSchema, repositorySchema } from './core-schemas.js';
import { z } from 'zod/v3';
import { authorizeContained, containedCommandFromArgv } from './source.js';
import { revalidateInstalledVerificationProfile, type InstalledVerificationProfile, type VerificationProfileLaunch } from './verification-profile.js';

export type ContainedProfileRuntimeBlocker = 'output_caps_exceed_runtime_maximum';
export interface PreparedContainedProfile {
  readonly binding: VerificationProfileLaunch['binding'];
  readonly image: Readonly<Omit<ContainedImageReceipt, 'trustedProfile'>> & { readonly trustedProfile: Readonly<NonNullable<ContainedImageReceipt['trustedProfile']>> };
  readonly command: string;
  readonly argv_digest: string;
  readonly timeoutMs: number;
  readonly outputLimits: { readonly stdoutBytes: number; readonly stderrBytes: number };
  /** Preparation is not authorization to run with the legacy log-tail adapter. */
  readonly runtimeBlockers: readonly ContainedProfileRuntimeBlocker[];
}
const preparedCapabilities = new WeakMap<object, {
  recheck: () => void; runtimeBlockers: readonly ContainedProfileRuntimeBlocker[];
  runtime: ContainedProfileRunOptions; consumed: boolean;
}>();
/** Only loader-issued plans within the streaming runtime limits can launch. */
export function assertContainedProfileRuntimeSupported(prepared: PreparedContainedProfile): void {
  const capability = preparedCapabilities.get(prepared);
  if (!capability) throw Error('CONTAINED_PROFILE_PREPARATION_REQUIRED');
  capability.recheck();
  if (capability.runtimeBlockers.length) throw Error('CONTAINED_PROFILE_RUNTIME_UNSUPPORTED');
}
/** Prepare immutable candidate and trusted profile bytes. Resource values must match
 * the fixed executor policy. Launch separately rechecks authority and installed bytes. */
export async function prepareContainedProfileImage(
  options: Omit<ContainedImageOptions, 'authorize' | 'trustedProfile'>,
  candidate: readonly ContainedCandidateFile[],
  installed: InstalledVerificationProfile,
  authorize: () => void,
): Promise<PreparedContainedProfile> {
  const fixedOptions = structuredClone(options);
  const launch = revalidateInstalledVerificationProfile(installed);
  const { profile, binding } = launch; const limits = profile.limits;
  if (limits.memory_mb !== 128 || limits.cpus !== 1 || limits.pids !== 64 || limits.timeout_seconds > 120) throw Error('CONTAINED_PROFILE_LIMITS_UNSUPPORTED');
  const recheck = () => { authorizeContained(authorize); revalidateInstalledVerificationProfile(installed); };
  const trustedProfile = { baseImageReference: profile.image, profileDigest: binding.profile_digest, artifactDigest: binding.trusted_source.artifact_digest,
    files: [profile.harness, ...profile.fixtures].map(file => ({ path: file.path.slice('/osstack-trusted/'.length), mode: '100644' as const, bytes: Buffer.from(file.content, 'utf8') })) };
  const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  // Matches the image preparer's public contentDigest contract: path-sorted tuples.
  const trustedContentDigest = sha(JSON.stringify([...trustedProfile.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => [file.path, file.mode, sha(file.bytes)])));
  recheck();
  const image = await prepareContainedImage({ ...fixedOptions, trustedProfile, authorize: recheck }, candidate);
  recheck();
  const provenance = image.trustedProfile;
  if (!provenance || image.baseImageId !== fixedOptions.baseImageId || image.daemonId !== fixedOptions.daemonId
    || !/^sha256:[a-f0-9]{64}$/.test(image.imageId) || provenance.contentDigest !== trustedContentDigest
    || provenance.baseImageReference !== profile.image || provenance.profileDigest !== binding.profile_digest
    || provenance.artifactDigest !== binding.trusted_source.artifact_digest
    || !/^\/osstack-candidate-[a-f0-9-]{36}$/.test(image.workingDirectory)) throw Error('CONTAINED_PROFILE_IMAGE_MISMATCH');
  const prepared: PreparedContainedProfile = Object.freeze({ binding, image: Object.freeze({ ...image, trustedProfile: Object.freeze({ ...provenance }) }),
    ...containedCommandFromArgv(profile.argv), timeoutMs: limits.timeout_seconds * 1000,
    outputLimits: Object.freeze({ stdoutBytes: limits.stdout_bytes, stderrBytes: limits.stderr_bytes }),
    runtimeBlockers: Object.freeze(limits.stdout_bytes > 1048576 || limits.stderr_bytes > 1048576 ? ['output_caps_exceed_runtime_maximum' as const] : []) });
  preparedCapabilities.set(prepared, { recheck, runtimeBlockers: prepared.runtimeBlockers, consumed: false,
    runtime: { stdoutBytes: limits.stdout_bytes, stderrBytes: limits.stderr_bytes, trustedProfile: { ...provenance },
      trustedFiles: trustedProfile.files.map(file => ({ path: file.path, sha256: sha(file.bytes), size: file.bytes.length })) } });
  return prepared;
}

export interface ContainedProfileRunHost {
  socketPath: string; journalRoot: string;
  /** Current host grants for cleanup/inspection of this exact invocation. */
  authorizeStop: () => void; authorizeRead: () => void;
}
export interface ContainedProfileRunIdentity {
  version: 1; kind: 'contained_profile_run'; invocationId: string;
  binding: PreparedContainedProfile['binding']; command: string; argv_digest: string;
  image: PreparedContainedProfile['image']; timeoutMs: number;
  outputLimits: { stdoutBytes: number; stderrBytes: number };
}
export async function runPreparedContainedProfile(
  prepared: PreparedContainedProfile, host: ContainedProfileRunHost, invocation: { invocationId: string; signal: AbortSignal },
): Promise<{ identity: ContainedProfileRunIdentity; result: ContainedProfileRunResult }> {
  assertContainedProfileRuntimeSupported(prepared);
  const capability = preparedCapabilities.get(prepared)!;
  if (capability.consumed) throw Error('CONTAINED_PROFILE_PLAN_CONSUMED');
  capability.consumed = true;
  const identity: ContainedProfileRunIdentity = { version: 1, kind: 'contained_profile_run', invocationId: invocation.invocationId,
    binding: prepared.binding, command: prepared.command, argv_digest: prepared.argv_digest, image: prepared.image,
    timeoutMs: prepared.timeoutMs, outputLimits: { stdoutBytes: capability.runtime.stdoutBytes, stderrBytes: capability.runtime.stderrBytes } };
  const bindingData = canonicalJson(identity); const bindingRef = createHash('sha256').update(bindingData).digest('hex');
  const { authorizeStop, authorizeRead } = host;
  const executor = await createContainedCommandExecutor({ socketPath: host.socketPath, journalRoot: host.journalRoot,
    daemonId: prepared.image.daemonId, imageId: prepared.image.imageId, workingDirectory: prepared.image.workingDirectory,
    command: prepared.command, timeoutMs: prepared.timeoutMs, bindingData, bindingRef,
    authorize: op => op === 'start' ? capability.recheck() : op === 'stop' ? authorizeContained(authorizeStop) : authorizeContained(authorizeRead) });
  const result = await executor.executeProfile(identity.invocationId, invocation.signal, capability.runtime);
  return { identity, result };
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identitySchema = z.object({
  version: z.literal(1), kind: z.literal('contained_profile_run'), invocationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/),
  binding: z.object({ profile_id: profileIdSchema, profile_digest: digest,
    trusted_source: z.object({ repository: repositorySchema, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), artifact_digest: digest }).strict() }).strict(),
  command: z.string().min(1).max(64000), argv_digest: digest,
  image: z.object({ version: z.literal(1), daemonId: z.string().min(1), baseImageId: imageId, imageId,
    workingDirectory: z.string().regex(/^\/osstack-candidate-[a-f0-9-]{36}$/), contentDigest: digest, archiveDigest: digest,
    trustedProfile: z.object({ profileDigest: digest, artifactDigest: digest, contentDigest: digest,
      baseImageReference: z.string().max(512).regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/) }).strict() }).strict(),
  timeoutMs: z.number().int().min(1).max(120000),
  outputLimits: z.object({ stdoutBytes: z.number().int().min(1).max(1048576), stderrBytes: z.number().int().min(1).max(1048576) }).strict(),
}).strict();
/** Validate persisted identity shape; this does not issue an execution capability. */
export function parseContainedProfileRunIdentity(value: unknown): ContainedProfileRunIdentity {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw Error('CONTAINED_PROFILE_IDENTITY_INVALID');
  return parsed.data;
}
