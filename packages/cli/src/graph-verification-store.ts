import { graphChecksPassed, validateGraphCommandSuite } from './graph-check-suite.js';
import { validateContainedTestEvidence } from './graph-contained-tests.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { GraphEffectIdentity, GraphJsonValue, GraphResult, computeGraphEffectKey } from '@osstack/protocol';
import { parseVerificationBinding, verificationCanonical, verificationObject, type VerificationBinding } from '@osstack/graph/nodes/branch';
import { parseReviewReport, type ReviewReport } from '@osstack/graph/nodes/review';
import type { GraphActionEvidence, PersistedGraphActionEvidence } from './graph-action-broker.js';
export interface AcceptanceCommandSpec { ref: string; command: string; passExitCodes: readonly number[]; failExitCodes: readonly number[] }
export interface VerificationEffect { effect: GraphEffectIdentity; effectKey: string }
export interface CandidateIdentity {
  head: string; tree: string; indexTree: string; indexDigest: string; trackedDigest: string; repositoryDigest: string; inventoryDigest?: string; containedContentDigest?: string;
}
export type CandidateObservation = CandidateIdentity | { error: string };
export interface ReviewerInvocation {
  runId: string; taskId: string; sessionId: string; adapterId: string; capabilityId: string;
  promptDigest: string; contextDigest: string; historyPassed: false; effectKey: string;
}
export interface VerificationOutputCapture {
  field: 'command.stdout' | 'command.stderr' | 'candidate.summary' | 'contained.output' | `commandSuite.${number}.stdout` | `commandSuite.${number}.stderr` | `containedSuite.${number}.output`;
  capturedBytes: number; capturedSha256: string; representation: 'prefix' | 'canonical_review';
}
export interface GraphVerificationEnvelope extends VerificationEffect {
  outputCaptures?: VerificationOutputCapture[];
  schemaVersion: 1; binding: VerificationBinding; kind: 'review' | 'tests'; nodeId: string; effectSlot: string;
  workspace: { workspace_id: string; workspace_path: string }; acceptance: AcceptanceCommandSpec; acceptanceSuite?: AcceptanceCommandSpec[];
  workspaceLeaseRef: string; candidateIdentity: { before: CandidateIdentity; after: CandidateObservation };
  reviewerInvocation?: ReviewerInvocation;
  writerIdentity: string; reviewerIdentity: string; evidence: GraphActionEvidence;
  report?: ReviewReport; verificationFailure?: NonNullable<PersistedGraphActionEvidence['verificationFailure']>;
}
export function parseAcceptanceCommand(value: unknown): AcceptanceCommandSpec {
  const v = verificationObject(value, ['ref', 'command', 'passExitCodes', 'failExitCodes']);
  if (typeof v.ref !== 'string' || !v.ref.trim() || v.ref.length > 256 || typeof v.command !== 'string' || !v.command.trim() || v.command.includes('\0') || v.command.length > 8192) throw new Error('invalid acceptance command');
  for (const codes of [v.passExitCodes, v.failExitCodes]) if (!Array.isArray(codes) || codes.length > 256 || codes.some(c => !Number.isInteger(c) || c < 0 || c > 255) || new Set(codes).size !== codes.length) throw new Error('invalid acceptance exit codes');
  const pass = v.passExitCodes as number[]; const fail = v.failExitCodes as number[];
  if (!pass.length || pass.some(code => fail.includes(code))) throw new Error('ambiguous acceptance exit codes');
  return structuredClone(value) as AcceptanceCommandSpec;
}
export function validateVerificationEffect(value: unknown, binding: VerificationBinding, nodeId: string, effectSlot: string): VerificationEffect {
  const object = verificationObject(value, ['effect', 'effectKey']); const effect = GraphEffectIdentity.parse(object.effect);
  if (effect.graphRunId !== binding.graphRunId || effect.specHash !== binding.specHash || effect.epoch !== binding.epoch || verificationCanonical(effect.scope) !== verificationCanonical(binding.scope)
    || effect.nodeId !== nodeId || effect.effectSlot !== effectSlot || object.effectKey !== computeGraphEffectKey(effect)) throw new Error('evidence effect binding mismatch');
  return { effect, effectKey: object.effectKey as string };
}
/** Suite collections are local files, not IPC. Validate every leaf with the
 * unchanged wire validator without imposing its aggregate limit on the file. */
function localVerificationObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('invalid local evidence object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw Error('unexpected local evidence field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw Error('invalid local evidence property');
    const item: unknown = descriptor.value;
    if (['acceptanceSuite', 'commandSuite', 'containedSuite'].includes(key)) {
      if (!Array.isArray(item) || Object.getPrototypeOf(item) !== Array.prototype || item.length > 16
        || Reflect.ownKeys(item).length !== item.length + 1) throw Error('invalid local evidence collection');
      for (let index = 0; index < item.length; index++) {
        const entry = Object.getOwnPropertyDescriptor(item, String(index));
        if (!entry?.enumerable || !('value' in entry)) throw Error('invalid local evidence entry');
        GraphJsonValue.parse(entry.value);
      }
    } else if (key === 'evidence') {
      localVerificationObject(item, ['status', 'stopped', 'candidate', 'command', 'contained', 'commandSuite', 'containedSuite']);
    } else GraphJsonValue.parse(item);
  }
  return value as Record<string, unknown>;
}
function validateEnvelope(value: unknown, expectedBinding: VerificationBinding, expectedEffect?: VerificationEffect): GraphVerificationEnvelope {
  const object = localVerificationObject(value, ['schemaVersion', 'binding', 'kind', 'nodeId', 'effectSlot', 'effect', 'effectKey', 'workspace', 'acceptance', 'writerIdentity', 'reviewerIdentity', 'evidence', 'report', 'verificationFailure', 'workspaceLeaseRef', 'candidateIdentity', 'reviewerInvocation', 'outputCaptures', 'acceptanceSuite']);
  const binding = parseVerificationBinding(object.binding);
  if (verificationCanonical(binding) !== verificationCanonical(parseVerificationBinding(expectedBinding))) throw new Error('evidence binding mismatch');
  if (object.schemaVersion !== 1 || !['review', 'tests'].includes(String(object.kind))) throw new Error('invalid evidence kind');
  const effect = validateVerificationEffect({ effect: object.effect, effectKey: object.effectKey }, binding, String(object.nodeId), String(object.effectSlot));
  if (expectedEffect && verificationCanonical(effect) !== verificationCanonical(expectedEffect)) throw new Error('evidence attempt replay');
  const acceptance = parseAcceptanceCommand(object.acceptance);
  if (acceptance.ref !== binding.acceptanceRef) throw new Error('acceptance binding mismatch');
  const workspace = verificationObject(object.workspace, ['workspace_id', 'workspace_path']);
  if (workspace.workspace_id !== binding.scope.workspaceId || typeof workspace.workspace_path !== 'string' || !isAbsolute(workspace.workspace_path)) throw new Error('evidence workspace mismatch');
  if (typeof object.writerIdentity !== 'string' || !object.writerIdentity.trim() || typeof object.reviewerIdentity !== 'string' || !object.reviewerIdentity.trim() || object.writerIdentity === object.reviewerIdentity) throw new Error('independent identity required');
  const evidence = localVerificationObject(object.evidence, ['status', 'stopped', 'candidate', 'command', 'contained', 'commandSuite', 'containedSuite']);
  if (evidence.stopped !== true || !['completed', 'failed'].includes(String(evidence.status))) throw new Error('executor stop unconfirmed');
  const envelope = object as unknown as GraphVerificationEnvelope;
  if(object.acceptanceSuite!==undefined){
    if(!Array.isArray(object.acceptanceSuite)||object.acceptanceSuite.length<2||object.acceptanceSuite.length>16)throw Error('invalid acceptance suite');
    const specs=object.acceptanceSuite.map(parseAcceptanceCommand);
    if(verificationCanonical(specs[0])!==verificationCanonical(acceptance) || new Set(specs.map(spec=>spec.ref)).size!==specs.length || specs.reduce((bytes,spec)=>bytes+Buffer.byteLength(spec.command),0)>16384)throw Error('suite registration mismatch');
    if(envelope.kind==='tests'){
      if(envelope.evidence.containedSuite){
        const results=envelope.evidence.containedSuite;
        if(envelope.evidence.command||envelope.evidence.commandSuite||results.length>specs.length||results.length===0||(!object.verificationFailure&&results.length!==specs.length)||verificationCanonical(results[0])!==verificationCanonical(envelope.evidence.contained))throw Error('invalid contained suite cardinality');
        for(let index=0;index<results.length;index++){
          const actual=validateContainedTestEvidence(results[index],binding,effect.effectKey,specs[index]!.command,envelope.candidateIdentity.before.containedContentDigest);
          if(actual.identity.invocationId!==(index===0?envelope.evidence.candidate?.execution?.run_id:`${envelope.evidence.candidate?.execution?.run_id}:${index}`)||(!object.verificationFailure&&(actual.result.cancelled||![...specs[index]!.passExitCodes,...specs[index]!.failExitCodes].includes(actual.result.exitCode))))throw Error('invalid contained suite outcome');
        }
      }else{
        if(!Array.isArray(envelope.evidence.commandSuite)||verificationCanonical(envelope.evidence.commandSuite[0])!==verificationCanonical(envelope.evidence.command)||envelope.evidence.contained)throw Error('missing suite evidence');
        validateGraphCommandSuite(specs,envelope.evidence.commandSuite,object.verificationFailure!==undefined);
      }
    }else if(envelope.evidence.commandSuite||envelope.evidence.containedSuite)throw Error('review cannot carry check suite');
  }else if(envelope.evidence.commandSuite||envelope.evidence.containedSuite)throw Error('unregistered suite evidence');
  if (envelope.evidence.candidate?.status === 'execution_unconfirmed' || envelope.evidence.candidate?.execution?.failure_code === 'cancellation_unconfirmed'
    || envelope.evidence.command?.failure_code === 'process_exit_unconfirmed' || envelope.evidence.command?.failure_code === 'surviving_descendants') throw new Error('executor stop evidence contradicts uncertainty');
  if (object.verificationFailure !== undefined) {
    const failure = verificationObject(object.verificationFailure, ['code', 'message', 'retrySafe']);
    if (!['OUTPUT_CONTRACT_INVALID', 'INTERNAL_ERROR'].includes(String(failure.code)) || typeof failure.message !== 'string' || !failure.message.trim() || failure.message.length > 4096 || typeof failure.retrySafe !== 'boolean' || object.report !== undefined) throw new Error('invalid verification failure');
  }
  if (typeof object.workspaceLeaseRef !== 'string' || !object.workspaceLeaseRef.trim() || object.workspaceLeaseRef.length > 256) throw new Error('invalid workspace lease receipt');
  const identities = verificationObject(object.candidateIdentity, ['before', 'after']);
  const validateIdentity = (value: unknown) => {
    const identity = verificationObject(value, ['head', 'tree', 'indexTree', 'indexDigest', 'trackedDigest', 'repositoryDigest', 'inventoryDigest', 'containedContentDigest']);
    for (const key of ['head', 'tree', 'indexTree']) if (typeof identity[key] !== 'string' || !/^[a-f0-9]{40}$/.test(identity[key] as string)) throw new Error('invalid candidate identity');
    for (const key of ['indexDigest', 'trackedDigest', 'repositoryDigest', ...(envelope.kind === 'review' ? ['inventoryDigest'] : [])]) if (typeof identity[key] !== 'string' || !/^[a-f0-9]{64}$/.test(identity[key] as string)) throw new Error('invalid candidate identity digest');
    if (envelope.kind === 'tests' && identity.inventoryDigest !== undefined) throw new Error('unexpected tests inventory receipt');
    if (identity.containedContentDigest !== undefined && (envelope.kind !== 'tests' || typeof identity.containedContentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(identity.containedContentDigest))) throw Error('invalid contained content digest');
    return identity;
  };
  const before = validateIdentity(identities.before);
  if (before.head !== binding.candidateRevision || before.tree !== before.indexTree) throw new Error('invalid frozen candidate identity');
  const after = verificationObject(identities.after, ['head', 'tree', 'indexTree', 'indexDigest', 'trackedDigest', 'repositoryDigest', 'inventoryDigest', 'containedContentDigest', 'error']);
  if (after.error !== undefined) {
    if (Object.keys(after).length !== 1 || typeof after.error !== 'string' || !after.error.trim() || after.error.length > 4096) throw new Error('invalid candidate observation error');
  } else validateIdentity(after);
  if (verificationCanonical(before) !== verificationCanonical(after) && (envelope.verificationFailure?.code !== 'INTERNAL_ERROR' || envelope.verificationFailure.retrySafe !== false)) throw new Error('candidate mutation requires non-retryable failure');
  if (envelope.kind === 'tests') {
    if (object.reviewerInvocation !== undefined) throw new Error('tests cannot contain reviewer invocation');
    if (envelope.evidence.contained) {
      if (envelope.evidence.command || object.report !== undefined) throw Error('conflicting contained evidence');
      const contained = validateContainedTestEvidence(envelope.evidence.contained, binding, effect.effectKey, acceptance.command, envelope.candidateIdentity.before.containedContentDigest);
      if (envelope.evidence.candidate?.execution?.run_id !== contained.identity.invocationId) throw Error('contained executor invocation mismatch');
      if (!envelope.verificationFailure && (contained.result.cancelled || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(contained.result.exitCode))) throw Error('invalid contained acceptance outcome');
    } else {
    if (envelope.candidateIdentity.before.containedContentDigest !== undefined) throw Error('missing contained evidence');
    const command = envelope.evidence.command;
    if (!command || command.command !== acceptance.command || !Number.isInteger(command.exitCode) || typeof command.stdout !== 'string' || typeof command.stderr !== 'string' || !Number.isFinite(command.durationMs) || command.durationMs < 0
      || command.termination?.stop_confirmed !== true || !command.termination.evidence.trim()) throw new Error('invalid stopped command evidence');
    if (object.report !== undefined) throw new Error('tests cannot contain model report');
    if (!envelope.verificationFailure && (command.failure_code || command.cancellation || command.termination.scope !== 'posix_process_group' || command.termination.trigger !== 'exit'
      || command.termination.leader_exit_code !== command.exitCode || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(command.exitCode))) throw new Error('invalid acceptance outcome');
    }
  } else {
    const candidate = envelope.evidence.candidate;
    if (!candidate?.execution || candidate.execution.agent_id !== envelope.reviewerIdentity || !candidate.execution.run_id || verificationCanonical(candidate.workspace) !== verificationCanonical(workspace) || evidence.command !== undefined || evidence.contained !== undefined) throw new Error('review executor identity mismatch');
    const receipt = verificationObject(object.reviewerInvocation, ['runId', 'taskId', 'sessionId', 'adapterId', 'capabilityId', 'promptDigest', 'contextDigest', 'historyPassed', 'effectKey']);
    if (receipt.runId !== candidate.execution.run_id || receipt.taskId !== candidate.execution.task_id || receipt.adapterId !== envelope.reviewerIdentity
      || typeof receipt.sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.sessionId)
      || typeof receipt.capabilityId !== 'string' || !receipt.capabilityId.trim() || receipt.historyPassed !== false || receipt.effectKey !== effect.effectKey
      || typeof receipt.promptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.promptDigest)
      || receipt.contextDigest !== sha(verificationCanonical({ repo_path: workspace.workspace_path }))) throw new Error('invalid reviewer invocation receipt');
    if (!envelope.verificationFailure) {
      const report = parseReviewReport(envelope.report);
      if (candidate.execution.failure_code || candidate.status !== 'implementation_complete' || candidate.execution.outcome !== 'completed' || verificationCanonical(parseReviewReport(JSON.parse(candidate.execution.summary ?? 'null'))) !== verificationCanonical(report)) throw new Error('review report evidence mismatch');
    }
  }
  if (envelope.outputCaptures !== undefined) {
    if (!Array.isArray(envelope.outputCaptures) || envelope.outputCaptures.length > 48) throw new Error('invalid output captures');
    const seen = new Set<string>();
    for (const value of envelope.outputCaptures) {
      const capture = verificationObject(value, ['field', 'capturedBytes', 'capturedSha256', 'representation']);
      const suiteField = /^(commandSuite|containedSuite)\.(\d+)\.(stdout|stderr|output)$/.exec(String(capture.field));
      if ((!['command.stdout','command.stderr','candidate.summary','contained.output'].includes(String(capture.field)) && !suiteField) || seen.has(String(capture.field))
        || !Number.isSafeInteger(capture.capturedBytes) || (capture.capturedBytes as number) < 0
        || typeof capture.capturedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(capture.capturedSha256)
        || !['prefix','canonical_review'].includes(String(capture.representation))) throw new Error('invalid output capture');
      seen.add(String(capture.field));
      const text = suiteField ? (suiteField[1] === 'containedSuite' && suiteField[3] === 'output' ? envelope.evidence.containedSuite?.[Number(suiteField[2])]?.result.output : suiteField[1] === 'commandSuite' && (suiteField[3] === 'stdout' || suiteField[3] === 'stderr') ? envelope.evidence.commandSuite?.[Number(suiteField[2])]?.[suiteField[3]] : undefined) : capture.field === 'command.stdout' ? envelope.evidence.command?.stdout : capture.field === 'command.stderr' ? envelope.evidence.command?.stderr : capture.field === 'contained.output' ? envelope.evidence.contained?.result.output : envelope.evidence.candidate?.execution?.summary;
      if (typeof text !== 'string') throw new Error('missing captured output preview');
      if (capture.representation === 'prefix' && (Buffer.byteLength(JSON.stringify(text)) > 2048 || Buffer.byteLength(text) > (capture.capturedBytes as number))) throw new Error('invalid output preview');
      if (capture.representation === 'canonical_review' && (capture.field !== 'candidate.summary' || !envelope.report || text !== JSON.stringify(envelope.report))) throw new Error('invalid canonical review capture');
    }
  }
  return structuredClone(envelope);
}
/** Diagnostic previews are explicitly lossy. Hash/length describe the complete
 * stream captured by G04, which itself may have an earlier output limit. They
 * are host observations, not a claim that the discarded suffix is retrievable.
 * Business report, exit, stop, identity and usage evidence are not truncated. */
export function compactVerificationOutput(envelope: GraphVerificationEnvelope): void {
  const evidence = structuredClone(envelope.evidence); const captures: VerificationOutputCapture[] = [];
  const compact = (field: VerificationOutputCapture['field'], original: string, canonicalReview?: string, limit = 2048): string => {
    let retained = canonicalReview ?? original;
    if (canonicalReview === undefined && Buffer.byteLength(JSON.stringify(original)) > limit) {
      let low = 0; let high = original.length;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(original.slice(0, mid))) <= limit) low = mid; else high = mid - 1; }
      retained = original.slice(0, low);
    }
    if (retained !== original) captures.push({ field, capturedBytes: Buffer.byteLength(original), capturedSha256: sha(original), representation: canonicalReview === undefined ? 'prefix' : 'canonical_review' });
    return retained;
  };
  if (evidence.contained) evidence.contained.result.output = compact('contained.output', evidence.contained.result.output);
  if (evidence.command) { evidence.command.stdout = compact('command.stdout', evidence.command.stdout); evidence.command.stderr = compact('command.stderr', evidence.command.stderr); }
  if (evidence.candidate?.execution?.summary !== undefined) evidence.candidate.execution.summary = compact('candidate.summary', evidence.candidate.execution.summary, envelope.report ? JSON.stringify(envelope.report) : undefined);
  if(evidence.commandSuite&&evidence.command){ evidence.commandSuite[0]=structuredClone(evidence.command); for(let index=1;index<evidence.commandSuite.length;index++){const item=evidence.commandSuite[index]!;item.stdout=compact(`commandSuite.${index}.stdout`,item.stdout,undefined,512);item.stderr=compact(`commandSuite.${index}.stderr`,item.stderr,undefined,512);}}
  if(evidence.containedSuite&&evidence.contained){
    evidence.containedSuite[0]=structuredClone(evidence.contained);
    for(let index=1; index<evidence.containedSuite.length; index++) { const item=evidence.containedSuite[index]!; item.result.output=compact(`containedSuite.${index}.output`,item.result.output,undefined,512); }
  }
  envelope.evidence = evidence; if (captures.length) envelope.outputCaptures = captures;
}
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function directory(root: string): Promise<string> {
  if (!isAbsolute(root) || await realpath(root) !== root) throw new Error('host evidence root must be canonical');
  const path = join(root, 'evidence'); await mkdir(path, { mode: 0o700, recursive: true });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('invalid host evidence directory');
  return path;
}
// A suite is local host storage, never a worker wire payload. Preserve the
// 64KiB wire/single-check budget; independently bound each entry and cap the
// complete local suite at 256KiB so mandatory stop receipts are never truncated.
function assertEvidenceBudget(envelope: GraphVerificationEnvelope, bytes: string | Buffer): void {
  const limit = envelope.acceptanceSuite ? 262144 : 65536;
  if (Buffer.byteLength(bytes) > limit) throw Error('evidence exceeds local file size limit');
  if (!envelope.acceptanceSuite) { GraphJsonValue.parse(envelope); return; }
  const { acceptanceSuite, evidence, ...rest } = envelope;
  const { commandSuite, containedSuite, ...primary } = evidence;
  GraphJsonValue.parse({ ...rest, evidence: primary });
  for (const item of [...acceptanceSuite, ...(commandSuite ?? []), ...(containedSuite ?? [])]) GraphJsonValue.parse(item);
}
async function syncDirectory(path: string) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
export async function publishGraphVerificationEvidence(root: string, value: GraphVerificationEnvelope, authorize: () => void, observePublication: () => void = authorize): Promise<PersistedGraphActionEvidence> {
  const envelope = validateEnvelope(value, value.binding); const bytes = verificationCanonical(envelope);
  assertEvidenceBudget(envelope, bytes); const digest = sha(bytes);
  const checked = async <T>(op: () => Promise<T>): Promise<T> => { authorize(); const result = await op(); authorize(); return result; };
  const dir = await checked(() => directory(root)); const temporary = join(dir, `.${randomUUID()}.json`); const final = join(dir, `${digest}.json`);
  authorize(); const file = await open(temporary, 'wx', 0o600);
  try { authorize(); await checked(() => file.writeFile(bytes)); await checked(() => file.sync()); } finally { await file.close(); }
  await checked(() => chmod(temporary, 0o400));
  // Keep the expensive raw-byte fence at publication boundaries; cheap live
  // authority checks still surround every asynchronous storage operation.
  observePublication();
  await checked(async () => { try { await link(temporary, final); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const existing = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW); try { if (sha(await existing.readFile()) !== digest) throw new Error('evidence digest collision'); } finally { await existing.close(); } } });
  observePublication();
  await checked(() => syncDirectory(dir)); await checked(() => syncDirectory(root)); await checked(() => syncDirectory(dirname(root)));
  await checked(() => unlink(temporary));
  observePublication();
  const evidenceRef = `graph-verification:${digest}`;
  if (envelope.verificationFailure) return { evidenceRef, verificationFailure: envelope.verificationFailure };
  const common = { schemaVersion: 1, candidateRevision: envelope.binding.candidateRevision, evidenceRefs: [evidenceRef], evidenceDigest: digest };
  const result = GraphResult.parse(envelope.kind === 'review' ? { ...common, kind: 'review', verdict: envelope.report!.verdict }
    : { ...common, kind: 'tests', passed: graphChecksPassed(envelope) });
  return { evidenceRef, result };
}
/** Host-owned storage authenticates provenance; digest alone is not an authorization grant. */
export async function loadGraphVerificationEvidence(root: string, evidenceRef: string, expectedBinding: VerificationBinding, expectedEffect?: VerificationEffect): Promise<GraphVerificationEnvelope> {
  const binding = parseVerificationBinding(expectedBinding); const effect = expectedEffect ? structuredClone(expectedEffect) : undefined;
  if (!/^graph-verification:[a-f0-9]{64}$/.test(evidenceRef)) throw new Error('invalid evidence reference');
  const digest = evidenceRef.slice('graph-verification:'.length);
  if (!isAbsolute(root) || await realpath(root) !== root) throw new Error('invalid host evidence root');
  const dir = join(root, 'evidence'); if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) throw new Error('invalid host evidence directory');
  const file = await open(join(dir, `${digest}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer; try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 262144) throw new Error('invalid evidence file'); bytes = await file.readFile(); } finally { await file.close(); }
  if (bytes.length > 262144) throw new Error('evidence exceeds local file size limit');
  if (sha(bytes) !== digest) throw new Error('evidence digest mismatch');
  const envelope = validateEnvelope(JSON.parse(bytes.toString('utf8')), binding, effect);
  assertEvidenceBudget(envelope, bytes); return envelope;
}
