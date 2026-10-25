import { assertGraphPlatform } from './graph-platform.js';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import {
  GRAPH_JSON_LIMITS, GraphContractError, GraphDelegationStatus, GraphDeliveryUnknown, GraphError,
  GraphRequest, GraphScope, GraphStatusRequest, computeGraphInputDigest,
} from '@osstack/protocol';

export interface GraphCommandDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  rpc?: (method: string, params: unknown) => Promise<unknown>;
}
export const GRAPH_EXECUTION_HELP = `Usage: osstack graph <command> [--json]
  validate --spec FILE               Offline fixed-template and budget validation
  run --request FILE                Submit a StartGraphRequest to the local daemon
  status --run ID --scope FILE       Read authoritative run state
  result --run ID --scope FILE       Read artifact-only delivery and evidence references
  contract --run ID --scope FILE     Read a verified host contract completion receipt
  cancel --request FILE             Persist cancellation intent; confirmation is separate
  reconcile --request FILE          Recheck cancellation using trusted host no-child evidence
  resume --request FILE             Resume an exact interrupt with current host authorization
Request/scope files are strict v1 JSON (max 64 KiB). No implicit scope or grant.
run/cancel/reconcile/resume retain the request's idempotencyKey across transport retries.
Exit: 0 acknowledged; 1 input/RPC rejection; 2 unknown outcome (follow returned nextAction).
Transport loss permits retrying the same key; ACTION_OUTCOME_UNKNOWN/CANCEL_UNCONFIRMED require reconciliation.
The server must have explicit trusted graph-host configuration. graph explain remains available.`;

function readJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > GRAPH_JSON_LIMITS.maxBytes) throw new GraphContractError('INPUT_CONTRACT_INVALID');
    const bytes = Buffer.alloc(GRAPH_JSON_LIMITS.maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > GRAPH_JSON_LIMITS.maxBytes) throw new GraphContractError('INPUT_CONTRACT_INVALID');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
  } finally { closeSync(fd); }
}
function options(args: string[], allowed: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (found.has(key) || ![...allowed, '--json'].includes(key)) throw new GraphContractError('INPUT_CONTRACT_INVALID');
    const value = key === '--json' ? 'true' : args[++index];
    if (!value || value.startsWith('--')) throw new GraphContractError('INPUT_CONTRACT_INVALID');
    found.set(key, value);
  }
  for (const key of allowed) if (!found.has(key)) throw new GraphContractError('INPUT_CONTRACT_INVALID');
  return found;
}
function failure(code: unknown, message: string): GraphError {
  const nextAction = code === 'REVISION_CONFLICT' ? 'refresh' : code === 'UNAUTHENTICATED' || code === 'POLICY_DENIED' || code === 'GRANT_EXPIRED' ? 'reauthorize'
    : code === 'ACTION_OUTCOME_UNKNOWN' || code === 'CANCEL_UNCONFIRMED' ? 'reconcile'
    : code === 'EXECUTOR_UNSUPPORTED' || code === 'GRAPH_ADMISSION_DISABLED' ? 'stop' : 'fix_input';
  const parsed = GraphError.safeParse({ schemaVersion: 1, code, message: message.slice(0, 4096) || 'Graph request rejected', retryable: false, nextAction });
  return parsed.success ? parsed.data : { schemaVersion: 1, code: 'INTERNAL_ERROR', message: 'Graph request failed', retryable: false, nextAction: 'stop' };
}
export async function handleGraphExecutionCommand(args: string[], deps: GraphCommandDependencies = {}): Promise<number> {
  const stdout = deps.stdout ?? console.log; const stderr = deps.stderr ?? console.error;
  const json = args.includes('--json');
  const emit = (value: unknown): void => { stdout(JSON.stringify(value, null, json ? 2 : undefined)); };
  if (args.length === 2 && args[1] === '--help') { stdout(GRAPH_EXECUTION_HELP); return 0; }
  let sentMutation: GraphRequest | undefined;
  const unknownDelivery = (mutation: GraphRequest): number => {
    emit(GraphDeliveryUnknown.parse({ schemaVersion: 1, kind: 'delivery_unknown', scope: mutation.scope,
      idempotencyKey: mutation.idempotencyKey, inputDigest: computeGraphInputDigest(mutation),
      ...(mutation.kind === 'start' ? {} : { graphRunId: mutation.graphRunId }), nextAction: 'retry_same_request' }));
    return 2;
  };
  try {
    const command = args[0];
    if (command !== "validate") assertGraphPlatform();
    if (command === 'validate') {
      const opts = options(args.slice(1), ['--spec']);
      const { compileGraphSpec } = await import('@osstack/graph/spec-compiler');
      let compiled: ReturnType<typeof compileGraphSpec>;
      try { compiled = compileGraphSpec(readJson(opts.get('--spec')!)); }
      catch { throw new GraphContractError('SPEC_INVALID'); }
      emit({ schemaVersion: 1, valid: true, specHash: compiled.specHash, template: compiled.spec.template,
        compilerVersion: compiled.compilerVersion, compiledProgramDigest: compiled.compiledProgramDigest,
        nodes: compiled.plan.nodes.map(({ id, operation, inputs }) => ({ id, operation, inputs })), budget: compiled.budget });
      return 0;
    }
    let params: unknown; let method: string; let mutation: GraphRequest | undefined;
    if (command === 'status' || command === 'result' || command === 'contract') {
      const opts = options(args.slice(1), ['--run', '--scope']);
      params = GraphStatusRequest.parse({ schemaVersion: 1, scope: GraphScope.parse(readJson(opts.get('--scope')!)), graphRunId: opts.get('--run') });
      method = `graph.${command}`;
    } else if (command === 'run' || command === 'cancel' || command === 'reconcile' || command === 'resume') {
      const opts = options(args.slice(1), ['--request']);
      mutation = GraphRequest.parse(readJson(opts.get('--request')!));
      if (mutation.kind !== (command === 'run' ? 'start' : command === 'reconcile' ? 'cancel' : command)) throw new GraphContractError('INPUT_CONTRACT_INVALID');
      params = mutation; method = command === 'reconcile' ? 'graph.reconcile' : `graph.${mutation.kind}`;
    } else throw new GraphContractError('INPUT_CONTRACT_INVALID');
    if (!deps.rpc) throw new GraphContractError('UNAUTHENTICATED');
    let response: unknown;
    sentMutation = mutation;
    try { response = await deps.rpc(method, params); }
    catch {
      if (!mutation) throw new GraphContractError('INTERNAL_ERROR');
      return unknownDelivery(mutation);
    }
    if (!response || typeof response !== 'object') throw new GraphContractError('OUTPUT_CONTRACT_INVALID');
    const envelope = response as { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (envelope.ok === false) {
      const error = failure(envelope.error?.code, typeof envelope.error?.message === 'string' ? envelope.error.message : 'Graph request rejected');
      if (json) emit({ schemaVersion: 1, kind: 'graph_error', error }); else stderr(`osstack graph: ${error.code}: ${error.message}`);
      return ['ACTION_OUTCOME_UNKNOWN', 'CANCEL_UNCONFIRMED'].includes(error.code) ? 2 : 1;
    }
    if (envelope.ok !== true) throw new GraphContractError('OUTPUT_CONTRACT_INVALID');
    if (command === 'contract') {
      const { GraphContractCompletionReceipt } = await import('./graph-contract-receipt.js');
      const receipt = GraphContractCompletionReceipt.safeParse(envelope.result);
      if (!receipt.success) throw new GraphContractError('OUTPUT_CONTRACT_INVALID');
      const requested = GraphStatusRequest.parse(params);
      if (JSON.stringify(receipt.data.scope) !== JSON.stringify(requested.scope) || receipt.data.graphRunId !== requested.graphRunId) throw new GraphContractError('RESPONSE_MISMATCH');
      emit(receipt.data); return 0;
    }
    const parsedStatus = GraphDelegationStatus.safeParse(envelope.result);
    if (!parsedStatus.success) throw new GraphContractError('OUTPUT_CONTRACT_INVALID');
    const status = parsedStatus.data;
    const requested = GraphStatusRequest.safeParse(params);
    if (JSON.stringify(status.scope) !== JSON.stringify((mutation ?? requested.data)!.scope)
      || (mutation?.kind !== 'start' && status.graphRunId !== (mutation ?? requested.data)!.graphRunId)
      || (mutation?.kind === 'start' && (status.admissionBinding?.requestInputDigest ?? status.inputDigest) !== computeGraphInputDigest(mutation))) throw new GraphContractError('RESPONSE_MISMATCH');
    emit(status); return 0;
  } catch (error) {
    // A malformed or mismatched acknowledgement cannot prove non-execution.
    if (sentMutation) return unknownDelivery(sentMutation);
    const code = error instanceof GraphContractError ? error.code : 'INPUT_CONTRACT_INVALID';
    const report = failure(code, error instanceof GraphContractError ? error.message : 'Invalid graph input or response');
    if (json) emit({ schemaVersion: 1, kind: 'graph_error', error: report }); else stderr(`osstack graph: ${report.code}: ${report.message}`);
    return 1;
  }
}
