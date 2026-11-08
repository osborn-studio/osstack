import { createHash } from 'node:crypto';
import { prepareContainedImage, type ContainedCandidateFile, type ContainedImageOptions, type ContainedImageReceipt } from '@osstack/agents';
import { authorizeContained, containedCommandFromArgv } from './contained-verification.js';
import { revalidateInstalledVerificationProfile, type InstalledVerificationProfile, type VerificationProfileLaunch } from './contained-mission-verification-profile.js';

export interface PreparedContainedProfile {
  readonly binding: VerificationProfileLaunch['binding'];
  readonly image: Readonly<Omit<ContainedImageReceipt, 'trustedProfile'>> & { readonly trustedProfile: Readonly<NonNullable<ContainedImageReceipt['trustedProfile']>> };
  readonly command: string;
  readonly argv_digest: string;
  readonly timeoutMs: number;
  readonly outputLimits: { readonly stdoutBytes: number; readonly stderrBytes: number };
  /** Preparation is not authorization to run with the legacy log-tail adapter. */
  readonly runtimeBlockers: readonly ['lifetime_output_caps', 'trusted_namespace_preflight'];
}
const preparedCapabilities = new WeakMap<object, () => void>();
/** This gate intentionally never permits launch. Legacy execution cannot enforce the
 * profile output contract or prove the trusted namespace has no base-image symlink aliases. */
export function assertContainedProfileRuntimeSupported(prepared: PreparedContainedProfile): never {
  const recheck = preparedCapabilities.get(prepared);
  if (!recheck) throw Error('CONTAINED_PROFILE_PREPARATION_REQUIRED');
  recheck();
  throw Error('CONTAINED_PROFILE_RUNTIME_UNSUPPORTED');
}
/** Optional preparation only. The host supplies already exported, frozen candidate bytes.
 * Build instructions use no candidate commands; no profile is registered with an executor.
 * Supported resource values match the existing fixed executor policy exactly. */
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
    runtimeBlockers: Object.freeze(['lifetime_output_caps', 'trusted_namespace_preflight'] as const) });
  preparedCapabilities.set(prepared, recheck);
  return prepared;
}
