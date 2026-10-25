import type { CommandResult } from '@osstack/loop';
import type { AcceptanceCommandSpec, GraphVerificationEnvelope } from './graph-verification-store.js';

/** Host evidence contains one ordered observation per admitted command. A stopped
 * prefix is retained only for infrastructure failures and can never pass. */
export function validateGraphCommandSuite(
  specs: readonly AcceptanceCommandSpec[], results: readonly CommandResult[], failed: boolean,
): void {
  if (specs.length < 2 || specs.length > 16 || results.length > specs.length
    || (!failed && results.length !== specs.length)
    || new Set(specs.map(spec => spec.ref)).size !== specs.length) {
    throw Error('invalid command suite cardinality');
  }
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const spec = specs[index]!;
    if (result.command !== spec.command || !Number.isInteger(result.exitCode)
      || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || !Number.isFinite(result.durationMs) || result.durationMs < 0
      || result.termination?.stop_confirmed !== true || !result.termination.evidence.trim()
      || result.failure_code === 'process_exit_unconfirmed' || result.failure_code === 'surviving_descendants') {
      throw Error('invalid suite command evidence');
    }
    if (!failed && (result.failure_code || result.cancellation
      || result.termination.scope !== 'posix_process_group' || result.termination.trigger !== 'exit'
      || result.termination.leader_exit_code !== result.exitCode
      || ![...spec.passExitCodes, ...spec.failExitCodes].includes(result.exitCode))) {
      throw Error('invalid suite acceptance outcome');
    }
  }
}

export function graphChecksPassed(envelope: GraphVerificationEnvelope): boolean {
  if (envelope.acceptanceSuite) {
    const results = envelope.evidence.commandSuite ?? envelope.evidence.containedSuite?.map(item => item.result);
    return !!results && results.length === envelope.acceptanceSuite.length
      && results.every((result, index) => envelope.acceptanceSuite![index]!.passExitCodes.includes(result.exitCode));
  }
  return envelope.acceptance.passExitCodes.includes(envelope.evidence.contained?.result.exitCode ?? envelope.evidence.command!.exitCode);
}
