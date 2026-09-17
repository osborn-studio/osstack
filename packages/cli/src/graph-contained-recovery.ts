import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { GraphRunFence } from '@osstack/core';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';
import { createContainedCommandExecutor } from '@osstack/agents';
import { parseVerificationBinding, verificationCanonical, verificationObject, type VerificationBinding } from '@osstack/graph/nodes/branch';
import { validateContainedTestIdentity, type GraphContainedTestOptions } from './graph-contained-tests.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export interface ReopenContainedTests {
  fence: GraphRunFence;
  effectKey: string;
  /** Trusted manifest/registry inputs, never inferred from the journal itself. */
  binding: VerificationBinding;
  command: string;
  contentDigest: string;
}
function authorize(grant: () => void): void {
  const result: unknown = grant();
  if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw Error('CONTAINED_AUTHORITY_MUST_BE_SYNC'); }
}
function readBinding(root: string, invocationId: string) {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw Error('CONTAINED_ROOT_CHANGED');
  const directory = join(root, sha(invocationId));
  if (realpathSync(directory) !== directory) throw Error('CONTAINED_JOURNAL_INVALID');
  const fd = openSync(join(directory, 'binding.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw Error('CONTAINED_JOURNAL_INVALID');
    const value = verificationObject(JSON.parse(readFileSync(fd, 'utf8')), ['version', 'bindingRef', 'data']);
    if (value.version !== 1 || typeof value.data !== 'string' || Buffer.byteLength(value.data) > 32768
      || value.bindingRef !== sha(value.data)) throw Error('CONTAINED_BINDING_MISMATCH');
    const identity: unknown = JSON.parse(value.data);
    if (verificationCanonical(identity) !== value.data) throw Error('CONTAINED_BINDING_NOT_CANONICAL');
    return { identity, data: value.data, bindingRef: value.bindingRef as string };
  } finally { closeSync(fd); }
}

/** Host-only per-action cleanup port, reconstructible after supervisor restart.
 * Does not execute, settle outcomes, release admission, or prove all workers stopped.
 * Private journal + trusted daemon/admin remain authority; labels are never searched. */
export async function reopenGraphContainedTests(db: Database.Database, options: GraphContainedTestOptions, request: ReopenContainedTests) {
  const fixed = structuredClone({ request, socketPath: options.socketPath, daemonId: options.daemonId,
    baseImageId: options.baseImageId, journalRoot: options.journalRoot });
  const { authorizeRead, authorizeStop } = options;
  const input = fixed.request; const binding = parseVerificationBinding(input.binding);
  // This instance cannot commit a recovery decision, even accidentally.
  const store = new GraphRecoveryStore(db, () => { throw Error('CONTAINED_REOPEN_IS_NOT_RECOVERY_AUTHORITY'); });
  authorize(authorizeRead);
  const initial = store.inspectAdmission(input.fence, input.effectKey);
  const action = initial.snapshot.action!;
  const prefix = `graph-execution:${input.effectKey}:`;
  const invocationId = action.executionRef?.startsWith(prefix) ? action.executionRef.slice(prefix.length) : '';
  if (initial.admission.releasedAt !== null || action.action.kind !== 'tests'
    || action.action.candidateRevision !== binding.candidateRevision || action.action.commandSpecRef !== binding.acceptanceRef
    || action.effect.epoch !== binding.epoch || action.effect.specHash !== binding.specHash
    || binding.graphRunId !== input.fence.graphRunId || verificationCanonical(binding.scope) !== verificationCanonical(input.fence.scope)
    || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(invocationId)) throw Error('CONTAINED_LEDGER_BINDING');
  const journal = readBinding(fixed.journalRoot, invocationId);
  const identity = validateContainedTestIdentity(journal.identity, binding, input.effectKey, input.command, input.contentDigest);
  if (identity.invocationId !== invocationId || identity.generation !== action.generation
    || identity.image.daemonId !== fixed.daemonId || identity.image.baseImageId !== fixed.baseImageId) throw Error('CONTAINED_LEDGER_BINDING');
  const initialDigest = sha(verificationCanonical(initial));
  const recheck = (operation: 'read' | 'stop') => {
    authorize(authorizeRead);
    if (operation === 'stop') authorize(authorizeStop);
    if (sha(verificationCanonical(store.inspectAdmission(input.fence, input.effectKey))) !== initialDigest
      || readBinding(fixed.journalRoot, invocationId).data !== journal.data) throw Error('CONTAINED_RECOVERY_CHANGED');
  };
  const executor = await createContainedCommandExecutor({ socketPath: fixed.socketPath, daemonId: fixed.daemonId,
    journalRoot: fixed.journalRoot, imageId: identity.image.imageId, workingDirectory: identity.image.workingDirectory,
    command: input.command, bindingRef: journal.bindingRef, bindingData: journal.data,
    authorize: operation => {
      if (operation === 'start') throw Error('CONTAINED_RECOVERY_CANNOT_EXECUTE');
      recheck(operation);
    } });
  recheck('read');
  return {
    identity: structuredClone(identity),
    confirmStopped: async () => { recheck('read'); const result = await executor.confirmStopped(invocationId); recheck('read'); return result; },
    stop: async () => { recheck('stop'); const result = await executor.stop(invocationId); recheck('stop'); return result; },
  };
}
