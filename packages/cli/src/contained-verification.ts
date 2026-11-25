import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createContainedCommandExecutor, prepareContainedImage, type ContainedCommandExecutor, type ContainedCommandResult, type ContainedImageOptions, type ContainedImageReceipt } from '@osstack/agents';
import { authorizeContained, containedCommandFromArgv, exportContainedCandidate } from '@osstack/agents/contained-profile';
import type { ContainedMission } from '@osstack/core';
import { canonicalJson } from '@osstack/protocol/source';

export {
  authorizeContained,
  containedCommandFromArgv,
  exportContainedCandidate,
  exportContainedCommit,
} from '@osstack/agents/contained-profile';

// Owner-neutral contained verification: candidate export, binding, execution and journal reopening.
// Owners (Graph, contained Mission) supply identity checks and fences; nothing here grants authority.
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export interface ContainedVerificationOptions extends Omit<ContainedImageOptions, 'authorize'> {
  journalRoot: string;
  /** Current host grants for cleanup/inspection of this exact admitted owner. */
  authorizeStop: () => void; authorizeRead: () => void;
}
export interface ContainedVerificationBinding {
  owner_kind: string; owner_id: string; spec_digest: string; epoch: number;
  candidate: { revision: string; tree?: string }; artifact_digest: string; acceptance_ref: string;
}
/** Journal identity encoding. Each owner keeps the codec its persisted journals were written with. */
export interface ContainedJournalCodec {
  canonical: (value: unknown) => string;
  object: (value: unknown, keys: readonly string[]) => Record<string, unknown>;
}
const strict = (code: string) => (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error(code);
  return value as Record<string, unknown>;
};
export const containedJournalCodec: ContainedJournalCodec = { canonical: canonicalJson, object: strict('CONTAINED_JOURNAL_INVALID') };
// biome-ignore lint/suspicious/noControlCharactersInRegex: binding fields are host identities, never free text.
const field = (value: unknown, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
export function parseContainedVerificationBinding(value: unknown): ContainedVerificationBinding {
  const v = strict('CONTAINED_BINDING_INVALID')(value, ['owner_kind', 'owner_id', 'spec_digest', 'epoch', 'candidate', 'artifact_digest', 'acceptance_ref']);
  const c = v.candidate && typeof v.candidate === 'object' && !Array.isArray(v.candidate) ? v.candidate as Record<string, unknown> : undefined;
  if (typeof v.owner_kind !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(v.owner_kind) || !field(v.owner_id, 256) || !field(v.spec_digest)
    || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 0 || !field(v.artifact_digest) || !field(v.acceptance_ref)
    || !c || Object.keys(c).some(key => key !== 'revision' && key !== 'tree') || !field(c.revision) || (c.tree !== undefined && !field(c.tree))) throw Error('CONTAINED_BINDING_INVALID');
  return { owner_kind: v.owner_kind, owner_id: v.owner_id as string, spec_digest: v.spec_digest as string, epoch: v.epoch as number,
    candidate: { revision: c.revision as string, ...(c.tree === undefined ? {} : { tree: c.tree as string }) }, artifact_digest: v.artifact_digest as string, acceptance_ref: v.acceptance_ref as string };
}
export const containedBindingCanonical = (binding: ContainedVerificationBinding) => canonicalJson(parseContainedVerificationBinding(binding));
export const containedBindingDigest = (binding: ContainedVerificationBinding) => sha(containedBindingCanonical(binding));

export async function prepareContainedCandidateImage(options: Omit<ContainedImageOptions, 'authorize'>, workspace: string, revision: string, authorize: () => void) {
  const files = exportContainedCandidate(workspace, revision);
  return prepareContainedImage({ socketPath: options.socketPath, daemonId: options.daemonId, baseImageId: options.baseImageId, authorize }, files);
}

export interface ContainedExecutionEvidence<D> { identity: D; result: ContainedCommandResult }
export interface ContainedExecutionPort<I extends { invocationId: string }, D> {
  /** Caller identity check: the invocation must belong to this exact binding/owner. */
  matches: (invocation: I, binding: ContainedVerificationBinding) => boolean;
  /** Persisted journal identity; recovery re-reads exactly these canonical bytes. */
  identity: (invocation: I, fixed: { binding: ContainedVerificationBinding; command: string; image: ContainedImageReceipt }) => D;
  codec?: ContainedJournalCodec;
}
export interface RegisteredContainedExecution<I, D> {
  command: string;
  execute: (invocation: I, signal: AbortSignal, authorize: () => void) => Promise<ContainedExecutionEvidence<D>>;
  confirmStopped: (invocationId: string) => ReturnType<ContainedCommandExecutor['confirmStopped']>;
}
/** Private per-registration observations; worker/model receipts never enter here. */
export function registerContainedExecution<I extends { invocationId: string }, D>(options: ContainedVerificationOptions, image: ContainedImageReceipt, binding: ContainedVerificationBinding, command: string, port: ContainedExecutionPort<I, D>) {
  const fixed = structuredClone({ socketPath: options.socketPath, journalRoot: options.journalRoot, image, binding, command });
  const { authorizeStop, authorizeRead } = options; const { matches, identity: identify } = port; const { canonical } = port.codec ?? containedJournalCodec;
  const executors = new Map<string, ContainedCommandExecutor>(); const observed = new Map<string, string>();
  const pending = new Map<string, Promise<ContainedExecutionEvidence<D>>>();
  const registration: RegisteredContainedExecution<I, D> = {
    command,
    execute: (invocation, signal, authorize) => {
      if (pending.has(invocation.invocationId)) return Promise.reject(Error('CONTAINED_INVOCATION_REPEATED'));
      const running = (async () => {
      if (executors.has(invocation.invocationId) || !matches(invocation, fixed.binding)) throw Error('CONTAINED_INVOCATION_BINDING');
      const identity = identify(invocation, fixed);
      const executor = await createContainedCommandExecutor({ socketPath: fixed.socketPath, daemonId: fixed.image.daemonId, journalRoot: fixed.journalRoot, imageId: fixed.image.imageId,
        workingDirectory: fixed.image.workingDirectory, command: fixed.command, bindingRef: sha(canonical(identity)), bindingData: canonical(identity),
        authorize: operation => { if (operation === 'start') authorize(); else if (operation === 'stop') return authorizeStop(); else return authorizeRead(); } });
      if (executors.has(invocation.invocationId)) throw Error('CONTAINED_INVOCATION_REPEATED');
      executors.set(invocation.invocationId, executor);
      const result = await executor.execute(invocation.invocationId, signal); const evidence = { identity, result };
      observed.set(invocation.invocationId, canonical(evidence)); return evidence;
      })();
      pending.set(invocation.invocationId, running); return running;
    },
    confirmStopped: async id => {
      // A caller may ask while the abort is still draining Docker removal. Its own
      // cancellation deadline bounds this wait; a settled promise alone is no proof.
      await pending.get(id)?.catch(() => {});
      return executors.get(id)?.confirmStopped(id) ?? { stopped: false };
    },
  };
  return { registration, verify: (evidence: ContainedExecutionEvidence<D> & { identity: { invocationId: string } }) => {
    if (observed.get(evidence.identity.invocationId) !== canonical(evidence)) throw Error('CONTAINED_ACTUAL_INVOCATION_REQUIRED');
  } };
}
/** Default owner port: the invocation names its owner, and the journal identity carries the whole binding. */
export interface ContainedOwnerInvocation { owner_kind: string; owner_id: string; invocationId: string }
export interface ContainedOwnerIdentity { version: 1; binding: ContainedVerificationBinding; invocationId: string; command: string; image: ContainedImageReceipt }
export const containedOwnerPort: ContainedExecutionPort<ContainedOwnerInvocation, ContainedOwnerIdentity> = {
  matches: (invocation, binding) => invocation.owner_kind === binding.owner_kind && invocation.owner_id === binding.owner_id,
  identity: (invocation, fixed) => ({ version: 1, binding: fixed.binding, invocationId: invocation.invocationId, command: fixed.command, image: fixed.image }),
};

export function readContainedJournal(root: string, invocationId: string, codec: ContainedJournalCodec = containedJournalCodec) {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw Error('CONTAINED_ROOT_CHANGED');
  const directory = join(root, sha(invocationId));
  if (realpathSync(directory) !== directory) throw Error('CONTAINED_JOURNAL_INVALID');
  const fd = openSync(join(directory, 'binding.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw Error('CONTAINED_JOURNAL_INVALID');
    // Bound the actual read as well as the pre-read stat: a private journal can
    // grow between those operations. NONBLOCK also lets fstat reject a FIFO.
    const bytes = Buffer.alloc(65537); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break; offset += count;
    }
    if (offset > 65536) throw Error('CONTAINED_JOURNAL_INVALID');
    const value = codec.object(JSON.parse(bytes.subarray(0, offset).toString('utf8')), ['version', 'bindingRef', 'data']);
    if (value.version !== 1 || typeof value.data !== 'string' || Buffer.byteLength(value.data) > 32768
      || value.bindingRef !== sha(value.data)) throw Error('CONTAINED_BINDING_MISMATCH');
    const identity: unknown = JSON.parse(value.data);
    let canonical: string | undefined;
    try { canonical = codec.canonical(identity); } catch {}
    if (canonical !== value.data) throw Error('CONTAINED_BINDING_NOT_CANONICAL');
    return { identity, data: value.data, bindingRef: value.bindingRef as string };
  } finally { closeSync(fd); }
}
export interface ReopenContainedExecution<D> {
  invocationId: string; command: string; mode: 'held' | 'read_only';
  codec?: ContainedJournalCodec;
  /** Caller check of the journal identity against trusted inputs; throws on mismatch. */
  validate: (identity: unknown) => { identity: D; image: { imageId: string; workingDirectory: string } };
  /** Caller fence/ledger recheck, run before every read or stop; throws when the owner changed. */
  fence: () => void;
  inTransaction: () => boolean;
}
/** Host-only per-invocation cleanup port reconstructed from the private journal.
 * Never executes; the caller's fence and grants are rechecked around each daemon call. */
export async function reopenContainedExecution<D>(options: Omit<ContainedVerificationOptions, 'baseImageId'>, request: ReopenContainedExecution<D>) {
  const { authorizeRead, authorizeStop } = options; const { invocationId, command, mode, validate, fence, inTransaction } = request;
  const codec = request.codec ?? containedJournalCodec; const root = options.journalRoot;
  const journal = readContainedJournal(root, invocationId, codec);
  const { identity, image } = validate(journal.identity);
  const recheck = (operation: 'read' | 'stop') => {
    authorizeContained(authorizeRead);
    if (operation === 'stop') {
      if (mode === 'read_only') throw Error('CONTAINED_INSPECTION_CANNOT_STOP');
      authorizeContained(authorizeStop);
    }
    fence();
    if (readContainedJournal(root, invocationId, codec).data !== journal.data) throw Error('CONTAINED_RECOVERY_CHANGED');
  };
  const executor = await createContainedCommandExecutor({ socketPath: options.socketPath, daemonId: options.daemonId,
    journalRoot: root, imageId: image.imageId, workingDirectory: image.workingDirectory,
    command, bindingRef: journal.bindingRef, bindingData: journal.data,
    authorize: operation => {
      if (operation === 'start') throw Error('CONTAINED_RECOVERY_CANNOT_EXECUTE');
      recheck(operation);
    } });
  recheck('read');
  return {
    identity: structuredClone(identity),
    confirmStopped: async () => { recheck('read'); const result = await executor.confirmStopped(invocationId); recheck('read'); return result; },
    stop: async () => { recheck('stop'); const result = await executor.stop(invocationId); recheck('stop'); return result; },
    /** Per-invocation proof only; the host must separately cover every other producer. */
    captureQuiescence: async () => {
      recheck('read'); const proof = await executor.captureQuiescence(invocationId); recheck('read');
      return { executorEvidenceRef: proof.executorEvidenceRef, isolationEvidenceRef: proof.isolationEvidenceRef, scope: proof.scope,
        recheck: () => { if (!inTransaction()) throw Error('RECOVERY_TRANSACTION_REQUIRED'); recheck('read'); proof.recheck(); } };
    },
  };
}

/** Bind a contained Mission's current candidate and verification attempt. Lifecycle wiring is the caller's. */
export function missionVerificationBinding(mission: ContainedMission, acceptance: { argv: readonly string[] }): ContainedVerificationBinding {
  if (mission.state !== 'verifying') throw Error('CONTAINED_MISSION_NOT_VERIFYING');
  if (!mission.candidate_head || !mission.candidate_tree || !mission.candidate_diff_digest) throw Error('CONTAINED_MISSION_CANDIDATE_REQUIRED');
  return parseContainedVerificationBinding({ owner_kind: 'contained_mission', owner_id: mission.mission_id, spec_digest: mission.spec_digest, epoch: mission.verify_attempts,
    candidate: { revision: mission.candidate_head, tree: mission.candidate_tree }, artifact_digest: mission.candidate_diff_digest, acceptance_ref: containedCommandFromArgv(acceptance.argv).argv_digest });
}
