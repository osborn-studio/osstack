import { prepareGraphContainedImage, registerContainedTests, validateContainedTestEvidence, type GraphContainedTestOptions } from './graph-contained-tests.js';
import type { ContainedImageReceipt } from '@osstack/agents';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentAdapter, AgentTask } from '@osstack/agents';
import type { GraphArtifactStore, GraphArtifactManifest } from '@osstack/core/graph-artifacts';
import { GraphResult } from '@osstack/protocol';
import { ExecutionPlan, type RegisteredCandidateWorkspace } from '@osstack/loop';
import { parseVerificationBinding, verificationCanonical, type VerificationBinding } from '@osstack/graph/nodes/branch';
import { createReviewRequest, parseReviewReport } from '@osstack/graph/nodes/review';
import { createTestsRequest } from '@osstack/graph/nodes/tests';
import type { AdmissionInput, ExecutionLease } from './governed-execution.js';
import type { GraphActionEvidence, GraphRegisteredAction, PersistedGraphActionEvidence } from './graph-action-broker.js';
import { compactVerificationOutput, parseAcceptanceCommand, publishGraphVerificationEvidence, validateVerificationEffect, type CandidateIdentity, type CandidateObservation, type ReviewerInvocation, type AcceptanceCommandSpec, type GraphVerificationEnvelope, type VerificationEffect } from './graph-verification-store.js';
export { loadGraphVerificationEvidence } from './graph-verification-store.js';
export type { AcceptanceCommandSpec, GraphVerificationEnvelope, VerificationEffect } from './graph-verification-store.js';
type Kind = 'review' | 'tests';
export interface ReviewerIdentity { writerIdentity: string; reviewerIdentity: string; adapterId: string; capabilityId: string }
export interface GraphVerificationOptions {
  root: string; artifacts: GraphArtifactStore; candidate: Extract<GraphResult, { kind: 'candidate_ready' }>; binding: VerificationBinding;
  sourceWorkspace: RegisteredCandidateWorkspace; authorize: () => void; acquire: (input: AdmissionInput) => Promise<ExecutionLease>;
  /** Current host cancel grant permits only stopped cancellation evidence settlement. */
  authorizeCancel?: () => void;
  authorizePolicy?: (workspacePath: string) => Promise<void>;
  /** Opt-in immutable-image tests; default registered shell behavior is unchanged. */
  containedTests?: GraphContainedTestOptions;
  acceptanceRegistry: readonly AcceptanceCommandSpec[]; writerIdentity: string;
  reviewer: { identity: string; adapter: AgentAdapter; capabilityId: string };
  /** Independent host identity/credential check; never derived from review/model output. */
  verifyReviewer: (identities: Readonly<ReviewerIdentity>) => Promise<void>;
  /** Reads current running ledger record, including its actual logical attempt. */
  effectIdentity: (kind: Kind) => VerificationEffect;
  /** Host ledger preparation owns this exact source lease. No nested acquisition. */
  preparationLease?: ExecutionLease;
  slots?: Partial<Record<Kind, { nodeId: string; effectSlot: string; workspaceLeaseRef: string; tokenReservation: number }>>;
}
export interface PreparedGraphVerification {
  binding: VerificationBinding; reviewWorkspace: RegisteredCandidateWorkspace; testsWorkspace: RegisteredCandidateWorkspace;
  actions: readonly GraphRegisteredAction[];
}
function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(copy); return copy;
}
function checkedAuthority(authorize: () => void): () => void {
  return () => { const result: unknown = authorize(); if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error('authority must be synchronous'); } };
}
function gitRaw(path: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: path, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
}
function git(path: string, ...args: string[]) { return gitRaw(path, ...args).trim(); }
/** Raw bytes/modes/links, including ignored and untracked files. Git status alone
 * misses ignored files, assume-unchanged and timestamp-preserving modifications. */
function workspaceFingerprint(path: string): string {
  const hash = createHash('sha256'); let count = 0;
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (!prefix && name === '.git') continue;
      if (++count > 100000) throw new Error('workspace inventory limit');
      const relative = `${prefix}${name}`; const full = join(directory, name); const stat = lstatSync(full);
      hash.update(JSON.stringify([relative, stat.mode & 0o777, stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file']));
      if (stat.isSymbolicLink()) {
        const target = resolve(dirname(full), readlinkSync(full));
        if (!target.startsWith(`${path}/`) || (existsSync(target) && !realpathSync(target).startsWith(`${path}/`))) throw new Error('shared external symlink in candidate workspace');
        hash.update(readlinkSync(full));
      }
      else if (stat.isDirectory()) visit(full, `${relative}/`);
      else if (stat.isFile() && stat.size <= 256 * 1024 * 1024 && stat.nlink === 1) hash.update(readFileSync(full));
      else throw new Error('unsupported workspace entry/shared writable hardlink');
    }
  };
  visit(path, ''); return hash.digest('hex');
}
export function assertExactCandidateFiles(path: string, revision: string): void {
  const expected = new Set<string>();
  for (const entry of gitRaw(path, 'ls-tree', '-rz', '--full-tree', revision).split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('unsupported candidate tree entry');
    const name = match[3]!;
    if (isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error('unsafe candidate tree path');
    expected.add(name);
    let parent = dirname(name); while (parent !== '.') { expected.add(parent); parent = dirname(parent); }
    const file = join(path, name);
    parent = dirname(file);
    while (parent !== path) {
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('candidate tracked parent changed');
      parent = dirname(parent);
    }
    const stat = lstatSync(file);
    if (stat.nlink !== 1 || stat.size > 256 * 1024 * 1024) throw new Error('unsupported tracked entry');
    const bytes = match[1] === '120000' && stat.isSymbolicLink() ? Buffer.from(readlinkSync(file))
      : match[1] !== '120000' && stat.isFile() ? readFileSync(file) : undefined;
    if (!bytes || (match[1] !== '120000' && ((stat.mode & 0o111) !== 0) !== (match[1] === '100755'))
      || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== match[2]) throw new Error('candidate raw tree mismatch');
  }
  const visit = (directory: string, prefix: string): void => { for (const name of readdirSync(directory)) {
    if (!prefix && name === '.git') continue;
    const relative = `${prefix}${name}`; if (!expected.has(relative)) throw new Error('candidate has unexpected files');
    const full = join(directory, name); if (lstatSync(full).isDirectory()) visit(full, `${relative}/`);
  } };
  visit(path, '');
}
function repositoryStamp(path: string): string {
  const gitDir = join(path, '.git');
  for (const p of [path, gitDir, join(gitDir, 'objects')]) if (!lstatSync(p).isDirectory() || realpathSync(p) !== p) throw new Error('workspace repository is not independent');
  if (git(path, 'rev-parse', '--absolute-git-dir') !== gitDir || git(path, 'rev-parse', '--git-common-dir') !== '.git'
    || existsSync(join(gitDir, 'objects', 'info', 'alternates')) || existsSync(join(gitDir, 'objects', 'info', 'http-alternates'))) throw new Error('shared repository storage forbidden');
  // Every restored repository starts without caches, symlinked metadata or shared objects.
  const inspect = (directory: string): void => { for (const name of readdirSync(directory)) { const p = join(directory, name); const stat = lstatSync(p); if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('shared repository metadata'); if (stat.isDirectory()) inspect(p); } };
  inspect(gitDir);
  return verificationCanonical([path, gitDir, join(gitDir, 'objects')].map(p => { const stat = lstatSync(p); return [p, stat.dev, stat.ino]; }));
}
/** Explicit trusted host preparation. No worker-supplied paths, commands, identity
 * claims, writer history or automatic cleanup. Same UID is not an OS sandbox. */
export async function prepareGraphVerification(options: GraphVerificationOptions): Promise<PreparedGraphVerification> {
  const selected = await prepareSelection(options, ['review', 'tests']);
  return { ...selected, reviewWorkspace: selected.workspaces.review!, testsWorkspace: selected.workspaces.tests! };
}
/** A single ledger preparation returns only the physical workspace it created. */
export async function prepareGraphVerificationBranch(options: GraphVerificationOptions, kind: Kind) {
  return prepareSelection(options, [kind]);
}
async function prepareSelection(options: GraphVerificationOptions, kinds: readonly Kind[]) {
  // Capture ALL callbacks and values before the first await.
  const { authorize, authorizeCancel, authorizePolicy, acquire, effectIdentity, verifyReviewer, preparationLease } = options;
  const containedOptions = options.containedTests ? Object.freeze({ ...options.containedTests }) : undefined;
  const check = checkedAuthority(authorize); check();
  const data = snapshot({ root: options.root, binding: parseVerificationBinding(options.binding), candidate: GraphResult.parse(options.candidate), source: options.sourceWorkspace,
    writerIdentity: options.writerIdentity, reviewerIdentity: options.reviewer.identity, capabilityId: options.reviewer.capabilityId,
    kinds, registry: options.acceptanceRegistry.map(parseAcceptanceCommand), slots: options.slots ?? {} });
  if (!data.kinds.length || new Set(data.kinds).size !== data.kinds.length || data.kinds.some(k => k !== 'review' && k !== 'tests')) throw Error('invalid preparation kinds');
  const adapter = options.reviewer.adapter;
  const capabilities = snapshot(adapter.capabilities());
  const reviewer: AgentAdapter = Object.freeze({ id: adapter.id, display_name: adapter.display_name, cost_tier: adapter.cost_tier,
    capabilities: () => structuredClone(capabilities), isAvailable: adapter.isAvailable.bind(adapter), invoke: adapter.invoke.bind(adapter),
    ...(adapter.confirmStopped ? { confirmStopped: adapter.confirmStopped.bind(adapter) } : {}) });
  const verifyArtifact = options.artifacts.verify.bind(options.artifacts); const restore = options.artifacts.restore.bind(options.artifacts);
  const { binding } = data;
  check();
  if (!isAbsolute(data.root) || data.root.includes('\0') || !isAbsolute(data.source.workspace_path) || data.source.workspace_id !== binding.scope.workspaceId) throw new Error('invalid host workspace/root');
  if (data.candidate.kind !== 'candidate_ready' || data.candidate.candidateRevision !== binding.candidateRevision || data.candidate.artifactDigest !== binding.artifactDigest) throw new Error('candidate binding mismatch');
  if (!data.writerIdentity.trim() || !data.reviewerIdentity.trim() || data.writerIdentity === data.reviewerIdentity || data.reviewerIdentity !== reviewer.id || !reviewer.confirmStopped || typeof verifyReviewer !== 'function') throw new Error('independent reviewer identity/stop verifier required');
  const matches = capabilities.filter(cap => cap.id === data.capabilityId);
  if (matches.length !== 1 || matches[0]!.agent_id !== reviewer.id || !['review.code', 'code.review'].includes(matches[0]!.kind)) throw new Error('review capability mismatch');
  const acceptanceMatches = data.registry.filter(spec => spec.ref === binding.acceptanceRef);
  if (acceptanceMatches.length !== 1) throw new Error('acceptance must resolve unique trusted command');
  const acceptance = acceptanceMatches[0]!;
  const identities = snapshot({ writerIdentity: data.writerIdentity, reviewerIdentity: data.reviewerIdentity, adapterId: reviewer.id, capabilityId: data.capabilityId });
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => { check(); const value = await operation(); check(); return value; };
  const independent = async () => { const result: unknown = await checked(() => verifyReviewer(identities)); if (result !== undefined) throw new Error('independent verifier must return void'); check(); };
  await independent();
  check();
  const lease = preparationLease ?? await acquire({ kind: 'write', runId: `graph-verification-prepare:${randomUUID()}`, workspacePath: data.source.workspace_path, authorize: async () => { check(); } });
  const preparedCheck = async () => { if (!lease.assertActive) throw new Error('canonical G10 preparation lease required'); await checked(() => lease.assertActive!()); };
  let containedImage: ContainedImageReceipt | undefined;
  let manifest!: GraphArtifactManifest; let reviewPath!: string; let testsPath!: string;
  let preparationFailure: { error: unknown } | undefined;
  try {
    check();
    await preparedCheck();
    const validateManifest = (value: GraphArtifactManifest) => {
      if (value.candidateRevision !== binding.candidateRevision || verificationCanonical(value.input.scope) !== verificationCanonical(binding.scope)
        || value.input.runId !== binding.graphRunId || value.input.worktreePath !== data.source.workspace_path) throw new Error('artifact manifest binding mismatch');
    };
    manifest = snapshot(await checked(() => verifyArtifact(binding.artifactDigest))); validateManifest(manifest);
    await checked(() => realpath(dirname(data.root)));
    await checked(() => mkdir(data.root, { mode: 0o700, recursive: true }));
    if (await checked(() => realpath(data.root)) !== data.root || data.root === data.source.workspace_path || data.root.startsWith(`${data.source.workspace_path}/`)) throw new Error('host root must be canonical and outside source workspace');
    const paths: string[] = [];
    for (const kind of data.kinds) {
      await preparedCheck();
      const restored = await checked(() => restore(binding.artifactDigest, { rootPath: data.root, directoryName: `${kind}-${randomUUID()}` }));
      if (restored.candidateRevision !== binding.candidateRevision || restored.tree !== manifest.tree || dirname(restored.worktreePath) !== data.root) throw new Error('restored candidate mismatch');
      if (kind === 'tests' && containedOptions) {
        assertExactCandidateFiles(restored.worktreePath, binding.candidateRevision);
        containedImage = snapshot(await checked(() => prepareGraphContainedImage(containedOptions, restored.worktreePath, binding.candidateRevision, check)));
        assertExactCandidateFiles(restored.worktreePath, binding.candidateRevision);
      }
      paths.push(restored.worktreePath);
      await preparedCheck();
    }
    reviewPath = paths[data.kinds.indexOf('review')]!; testsPath = paths[data.kinds.indexOf('tests')]!;
    const final = await checked(() => verifyArtifact(binding.artifactDigest)); validateManifest(final);
    if (verificationCanonical(final) !== verificationCanonical(manifest)) throw new Error('artifact changed during preparation');
    await preparedCheck();
  } catch (error) { preparationFailure = { error }; }
  // Restore promises have settled: no external agent exists during preparation.
  // Leave allocated directories intact even when publication/authority fails.
  try { if (!preparationLease) await lease.release(); } catch (error) { lease.retain(String(error)); throw error; }
  if (preparationFailure) throw preparationFailure.error;
  check();
  const workspaces: Partial<Record<Kind, RegisteredCandidateWorkspace>> = {};
  if (reviewPath) workspaces.review = snapshot({ workspace_id: binding.scope.workspaceId, workspace_path: reviewPath });
  if (testsPath) workspaces.tests = snapshot({ workspace_id: binding.scope.workspaceId, workspace_path: testsPath });
  const actions = data.kinds.map(kind => {
    const workspace = workspaces[kind]!;
    assertExactCandidateFiles(workspace.workspace_path, binding.candidateRevision);
    // Paths come from the frozen tree, never from a potentially altered index.
    const trackedPaths = gitRaw(workspace.workspace_path, 'ls-tree', '-rz', '--name-only', binding.candidateRevision).split('\0').filter(Boolean);
    const trackedFingerprint = () => {
      const hash = createHash('sha256');
      for (const name of trackedPaths) {
        const file = join(workspace.workspace_path, name);
        let parent = dirname(file);
        while (parent !== workspace.workspace_path) {
          if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('candidate tracked parent changed');
          parent = dirname(parent);
        }
        const stat = lstatSync(file);
        if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024) throw new Error('unsupported tracked entry');
        const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
        hash.update(JSON.stringify([name, stat.mode, bytes.length, createHash('sha256').update(bytes).digest('hex')]));
      }
      return hash.digest('hex');
    };
    const candidateIdentity = (): CandidateIdentity => ({
      repositoryDigest: createHash('sha256').update(repositoryStamp(workspace.workspace_path)).digest('hex'),
      head: git(workspace.workspace_path, 'rev-parse', 'HEAD'), tree: git(workspace.workspace_path, 'rev-parse', 'HEAD^{tree}'),
      indexTree: git(workspace.workspace_path, 'write-tree'), indexDigest: createHash('sha256').update(gitRaw(workspace.workspace_path, 'ls-files', '--stage', '-v', '-z')).digest('hex'), trackedDigest: trackedFingerprint(),
      ...(kind === 'tests' && containedImage ? { containedContentDigest: containedImage.contentDigest } : {}),
      ...(kind === 'review' ? { inventoryDigest: workspaceFingerprint(workspace.workspace_path) } : {}),
    });
    // Both workspaces start with a strict inventory; tests may later emit untracked build outputs.
    workspaceFingerprint(workspace.workspace_path);
    const before = snapshot(candidateIdentity());
    if (before.head !== binding.candidateRevision || before.tree !== manifest.tree || before.indexTree !== manifest.tree) throw new Error('candidate workspace mutation detected');
    const observe = (): CandidateObservation => {
      try { return candidateIdentity(); } catch (error) { return { error: String(error).slice(0, 4096) }; }
    };
    const candidateCheck = () => {
      check();
      if (verificationCanonical(observe()) !== verificationCanonical(before)) throw new Error('candidate workspace mutation detected');
      check();
    };
    candidateCheck();
    const contained = kind === 'tests' && containedOptions && containedImage ? registerContainedTests(containedOptions, containedImage, binding, acceptance.command) : undefined;
    const invocations = new Map<string, ReviewerInvocation>();
    const slot = data.slots[kind] ?? { nodeId: kind, effectSlot: 'invoke', workspaceLeaseRef: `verification:${randomUUID()}`, tokenReservation: 0 };
    if (!Number.isSafeInteger(slot.tokenReservation) || slot.tokenReservation < 0) throw new Error('invalid token reservation');
    const requestInput = { binding, generation: 1, requestId: 'register', ...slot };
    const request = kind === 'review' ? createReviewRequest(requestInput) : createTestsRequest(requestInput);
    const verifyWorkspace = async () => { await independent(); candidateCheck(); };
    const persist = async (raw: GraphActionEvidence, context?: { signal: AbortSignal }): Promise<PersistedGraphActionEvidence> => {
      const evidence = snapshot(raw);
      const settlementCheck = () => {
        if (context?.signal.aborted && evidence.stopped === true && authorizeCancel) checkedAuthority(authorizeCancel)();
        else check();
      };
      settlementCheck();
      if (evidence.stopped !== true || evidence.candidate?.status === 'execution_unconfirmed' || evidence.candidate?.execution?.failure_code === 'cancellation_unconfirmed'
        || evidence.command?.failure_code === 'process_exit_unconfirmed' || evidence.command?.failure_code === 'surviving_descendants') throw new Error('executor stop unconfirmed');
      const effect = snapshot(validateVerificationEffect(effectIdentity(kind), binding, slot.nodeId, slot.effectSlot));
      settlementCheck();
      const identityCheck: unknown = await verifyReviewer(identities);
      if (identityCheck !== undefined) throw new Error('independent verifier must return void');
      settlementCheck();
      if (verificationCanonical(validateVerificationEffect(effectIdentity(kind), binding, slot.nodeId, slot.effectSlot)) !== verificationCanonical(effect)) throw new Error('ledger effect changed during verification');
      const envelope: GraphVerificationEnvelope = { schemaVersion: 1, binding, kind, nodeId: slot.nodeId, effectSlot: slot.effectSlot, ...effect,
        workspace, workspaceLeaseRef: slot.workspaceLeaseRef, candidateIdentity: { before, after: observe() }, acceptance, writerIdentity: data.writerIdentity, reviewerIdentity: data.reviewerIdentity, evidence };
      if (context?.signal.aborted) envelope.verificationFailure = { code: 'INTERNAL_ERROR', message: 'Verification cancelled after confirmed executor stop', retrySafe: false };
      if (verificationCanonical(envelope.candidateIdentity.after) !== verificationCanonical(before)) envelope.verificationFailure = { code: 'INTERNAL_ERROR', message: 'Candidate workspace mutation detected after execution', retrySafe: false };
      if (kind === 'review') {
        const receipt = invocations.get(evidence.candidate?.execution?.run_id ?? '');
        if (!receipt || receipt.effectKey !== effect.effectKey) throw new Error('missing actual reviewer invocation receipt');
        envelope.reviewerInvocation = receipt;
        if (!envelope.verificationFailure) {
          if (evidence.status !== 'completed' || evidence.candidate?.execution?.failure_code || evidence.candidate?.status !== 'implementation_complete') envelope.verificationFailure = { code: 'INTERNAL_ERROR', message: 'Review executor failed after stopping', retrySafe: true };
          else {
            try { envelope.report = parseReviewReport(JSON.parse(evidence.candidate.execution?.summary ?? 'null')); }
            catch { envelope.verificationFailure = { code: 'OUTPUT_CONTRACT_INVALID', message: 'Review summary is not a valid structured report', retrySafe: true }; }
          }
        }
      } else if (contained) {
        if (!evidence.contained || evidence.command) throw Error('missing actual contained command evidence');
        contained.verify(evidence.contained);
        const receipt = validateContainedTestEvidence(evidence.contained, binding, effect.effectKey, acceptance.command, before.containedContentDigest);
        if (!envelope.verificationFailure && (receipt.result.cancelled || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(receipt.result.exitCode))) envelope.verificationFailure = { code: 'INTERNAL_ERROR', message: 'Contained command cancelled or returned unregistered exit code', retrySafe: false };
      } else {
        if (evidence.contained) throw Error('unexpected contained evidence');
        const command = evidence.command;
        if (!command || command.command !== acceptance.command || command.termination?.stop_confirmed !== true) throw new Error('missing actual registered command stop evidence');
        if (!envelope.verificationFailure && (command.failure_code || command.cancellation || command.termination.scope !== 'posix_process_group' || command.termination.trigger !== 'exit' || command.termination.leader_exit_code !== command.exitCode
          || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(command.exitCode))) envelope.verificationFailure = { code: 'INTERNAL_ERROR', message: 'Acceptance command infrastructure failure or unregistered exit code', retrySafe: true };
      }
      compactVerificationOutput(envelope);
      return publishGraphVerificationEvidence(data.root, envelope, () => {
        if (verificationCanonical(observe()) !== verificationCanonical(envelope.candidateIdentity.after)) throw new Error('candidate changed during persistence');
        settlementCheck(); if (verificationCanonical(validateVerificationEffect(effectIdentity(kind), binding, slot.nodeId, slot.effectSlot)) !== verificationCanonical(effect)) throw new Error('ledger effect changed during persistence');
      });
    };
    // G04 reuses plan-derived session IDs on retry. Allocate the real session at invocation,
    // rebuilding task/context from trusted fields so caller history/resume hints cannot pass through.
    const plan = snapshot(ExecutionPlan.parse({ plan_id: `verification:${randomUUID()}`, agent_id: kind === 'review' ? reviewer.id : 'registered-command', max_iterations: 1,
      task: { task_id: `verification:${kind}:${randomUUID()}`, capability: kind === 'review' ? matches[0]!.kind : 'code.test', source: 'manual',
        prompt: kind === 'review' ? `Independently review frozen candidate ${binding.candidateRevision} against acceptance ${binding.acceptanceRef}. Return only JSON {"schemaVersion":1,"verdict":"accept"|"changes_requested","summary":string,"findings":string[]}. Do not modify files.` : `Run registered acceptance ${binding.acceptanceRef}.` },
      stop_condition: { type: kind === 'review' ? 'review_approved' : 'tests_pass' } }));
    const invocationReviewer: AgentAdapter = Object.freeze({ ...reviewer,
      invoke: (task: AgentTask, signal: AbortSignal) => (async function* () {
        const runId = task.run_id; const taskId = task.task_id;
        await independent(); candidateCheck();
        await authorizePolicy?.(workspace.workspace_path); check();
        if (signal.aborted) throw new Error('review invocation cancelled');
        if (taskId !== plan.task.task_id || invocations.has(runId)) throw new Error('invalid or repeated reviewer invocation');
        const actual: AgentTask = snapshot({ run_id: runId, task_id: taskId, session_id: randomUUID(), capability_id: data.capabilityId,
          prompt: plan.task.prompt, context: { repo_path: workspace.workspace_path } });
        const effect = validateVerificationEffect(effectIdentity(kind), binding, slot.nodeId, slot.effectSlot);
        invocations.set(runId, snapshot({ runId, taskId, sessionId: actual.session_id, adapterId: reviewer.id, capabilityId: actual.capability_id,
          promptDigest: createHash('sha256').update(actual.prompt).digest('hex'), contextDigest: createHash('sha256').update(verificationCanonical(actual.context)).digest('hex'),
          historyPassed: false, effectKey: effect.effectKey }));
        check();
        yield* reviewer.invoke(actual, signal);
      })(),
    });
    const action: GraphRegisteredAction = { nodeId: slot.nodeId, effectSlot: slot.effectSlot, action: snapshot(request.action), tokenReservation: slot.tokenReservation,
      workspace, verifyWorkspace, persist, execution: kind === 'review' ? { kind: 'adapter', plan, adapter: invocationReviewer, capabilityId: data.capabilityId } : contained ? { kind: 'contained', plan, ...contained.registration } : { kind: 'command', plan, command: acceptance.command } };
    Object.freeze(action.execution); return Object.freeze(action);
  });
  return Object.freeze({ binding, workspaces: Object.freeze(workspaces), actions: Object.freeze(actions) });
}
