import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { GraphScope } from '@osstack/protocol';
import { createContainedCommandExecutor, prepareContainedImage, type ContainedCommandExecutor, type ContainedCommandResult, type ContainedImageOptions, type ContainedImageReceipt, type ContainedCandidateFile } from '@osstack/agents';
import { verificationCanonical, verificationObject, type VerificationBinding } from '@osstack/graph/nodes/branch';
export interface GraphContainedTestOptions extends Omit<ContainedImageOptions, 'authorize'> {
  journalRoot: string;
  /** Current host grants for cleanup/inspection of this exact admitted scope. */
  authorizeStop: () => void; authorizeRead: () => void;
}
export interface ContainedInvocation { scope: GraphScope; graphRunId: string; generation: number; effectKey: string; invocationId: string }
export interface GraphContainedTestEvidence {
  identity: ContainedInvocation & { version: 1; candidateRevision: string; artifactDigest: string; command: string; image: ContainedImageReceipt };
  result: ContainedCommandResult;
}
export interface RegisteredContainedTests {
  command: string;
  execute: (invocation: ContainedInvocation, signal: AbortSignal, authorize: () => void) => Promise<GraphContainedTestEvidence>;
  confirmStopped: (invocationId: string) => ReturnType<ContainedCommandExecutor['confirmStopped']>;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export async function prepareGraphContainedImage(options: GraphContainedTestOptions, workspace: string, revision: string, authorize: () => void) {
  // Export immutable Git objects, not files the candidate can change during upload.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: workspace, timeout: 10000, maxBuffer: 33 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } });
  const files: ContainedCandidateFile[] = []; let size = 0;
  const listing = git('ls-tree', '-rz', '--full-tree', revision);
  if (!Buffer.from(listing.toString()).equals(listing)) throw Error('CONTAINED_CANDIDATE_UTF8_PATH_REQUIRED');
  for (const row of listing.toString().split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!match) throw Error('CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED');
    const bytes = git('cat-file', 'blob', match[2]!); size += bytes.length;
    if (size > 32 * 1024 * 1024 || files.length >= 10000) throw Error('CONTAINED_CANDIDATE_LIMIT');
    if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== match[2]) throw Error('CONTAINED_CANDIDATE_BLOB_MISMATCH');
    files.push({ path: match[3]!, mode: match[1] as '100644' | '100755', bytes });
  }
  return prepareContainedImage({ socketPath: options.socketPath, daemonId: options.daemonId, baseImageId: options.baseImageId, authorize }, files);
}
/** Private per-registration observations; worker/model receipts never enter here. */
export function registerContainedTests(options: GraphContainedTestOptions, image: ContainedImageReceipt, binding: VerificationBinding, command: string) {
  const fixed = structuredClone({ socketPath: options.socketPath, journalRoot: options.journalRoot, image, binding, command });
  const { authorizeStop, authorizeRead } = options;
  const executors = new Map<string, ContainedCommandExecutor>(); const observed = new Map<string, string>();
  const pending = new Map<string, Promise<GraphContainedTestEvidence>>();
  const registration: RegisteredContainedTests = {
    command,
    execute: (invocation, signal, authorize) => {
      if (pending.has(invocation.invocationId)) return Promise.reject(Error('CONTAINED_INVOCATION_REPEATED'));
      const running = (async () => {
      if (executors.has(invocation.invocationId) || invocation.graphRunId !== fixed.binding.graphRunId || verificationCanonical(invocation.scope) !== verificationCanonical(fixed.binding.scope)) throw Error('CONTAINED_INVOCATION_BINDING');
      const identity: GraphContainedTestEvidence['identity'] = { ...structuredClone(invocation), version: 1, candidateRevision: fixed.binding.candidateRevision, artifactDigest: fixed.binding.artifactDigest, command: fixed.command, image: fixed.image };
      const executor = await createContainedCommandExecutor({ socketPath: fixed.socketPath, daemonId: fixed.image.daemonId, journalRoot: fixed.journalRoot, imageId: fixed.image.imageId,
        workingDirectory: fixed.image.workingDirectory, command: fixed.command, bindingRef: sha(verificationCanonical(identity)), bindingData: verificationCanonical(identity),
        authorize: operation => { if (operation === 'start') authorize(); else if (operation === 'stop') return authorizeStop(); else return authorizeRead(); } });
      if (executors.has(invocation.invocationId)) throw Error('CONTAINED_INVOCATION_REPEATED');
      executors.set(invocation.invocationId, executor);
      const result = await executor.execute(invocation.invocationId, signal); const evidence = { identity, result };
      observed.set(invocation.invocationId, verificationCanonical(evidence)); return evidence;
      })();
      pending.set(invocation.invocationId, running); return running;
    },
    confirmStopped: async id => {
      // G04 may ask while the abort is still draining Docker removal. Its own
      // cancellation deadline bounds this wait; a settled promise alone is no proof.
      await pending.get(id)?.catch(() => {});
      return executors.get(id)?.confirmStopped(id) ?? { stopped: false };
    },
  };
  return { registration, verify: (evidence: GraphContainedTestEvidence) => {
    if (observed.get(evidence.identity.invocationId) !== verificationCanonical(evidence)) throw Error('CONTAINED_ACTUAL_INVOCATION_REQUIRED');
  } };
}
/** Shared identity validation for live envelopes and host-only journal reopening. */
export function validateContainedTestIdentity(value: unknown, binding: VerificationBinding, effectKey: string, command: string, contentDigest: string | undefined): GraphContainedTestEvidence['identity'] {
  const identity = verificationObject(value, ['scope', 'graphRunId', 'generation', 'effectKey', 'invocationId', 'version', 'candidateRevision', 'artifactDigest', 'command', 'image']);
  const image = verificationObject(identity.image, ['version', 'daemonId', 'baseImageId', 'imageId', 'contentDigest', 'archiveDigest', 'workingDirectory']);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (identity.version !== 1 || identity.graphRunId !== binding.graphRunId || verificationCanonical(identity.scope) !== verificationCanonical(binding.scope)
    || identity.effectKey !== effectKey || !Number.isSafeInteger(identity.generation) || (identity.generation as number) < 1
    || typeof identity.invocationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(identity.invocationId)
    || identity.candidateRevision !== binding.candidateRevision || identity.artifactDigest !== binding.artifactDigest || identity.command !== command
    || image.version !== 1 || typeof image.daemonId !== 'string' || !image.daemonId || image.contentDigest !== contentDigest
    || ![image.contentDigest, image.archiveDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    || ![image.baseImageId, image.imageId].every(v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v))
    || typeof image.workingDirectory !== 'string' || !image.workingDirectory.startsWith('/osstack-candidate-') || !uuid.test(image.workingDirectory.slice(19))) throw Error('CONTAINED_EVIDENCE_BINDING');
  return value as GraphContainedTestEvidence['identity'];
}
/** Validate the durable host envelope; this does not itself authorize recovery. */
export function validateContainedTestEvidence(value: unknown, binding: VerificationBinding, effectKey: string, command: string, contentDigest: string | undefined): GraphContainedTestEvidence {
  const v = verificationObject(value, ['identity', 'result']);
  const identity = validateContainedTestIdentity(v.identity, binding, effectKey, command, contentDigest);
  const image = identity.image;
  const result = verificationObject(v.result, ['exitCode', 'output', 'cancelled', 'evidence', 'stopReceipt']);
  const receipt = verificationObject(result.stopReceipt, ['version', 'kind', 'launch', 'confirmedAt']);
  const launch = verificationObject(receipt.launch, ['version', 'invocationId', 'specDigest', 'daemonId', 'containerId', 'nonce']);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const specDigest = sha(JSON.stringify({ image: image.imageId, command, binding: sha(verificationCanonical(identity)), policy: 1, workingDirectory: image.workingDirectory }));
  if (receipt.version !== 1 || receipt.kind !== 'docker_removed' || !Number.isSafeInteger(receipt.confirmedAt) || (receipt.confirmedAt as number) <= 0
    || launch.version !== 1 || launch.invocationId !== identity.invocationId || launch.daemonId !== image.daemonId || launch.specDigest !== specDigest
    || typeof launch.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(launch.containerId) || typeof launch.nonce !== 'string' || !uuid.test(launch.nonce)
    || result.evidence !== `docker-removed:${sha(JSON.stringify({ version: 1, kind: 'docker_removed', launch: { version: 1, invocationId: launch.invocationId, specDigest: launch.specDigest, daemonId: launch.daemonId, containerId: launch.containerId, nonce: launch.nonce }, confirmedAt: receipt.confirmedAt }))}`
    || !Number.isInteger(result.exitCode) || (result.exitCode as number) < 0 || (result.exitCode as number) > 255 || typeof result.output !== 'string' || result.output.length > 16000 || typeof result.cancelled !== 'boolean') throw Error('CONTAINED_STOP_RECEIPT_MISMATCH');
  return value as GraphContainedTestEvidence;
}
