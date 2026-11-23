// Exact commit coverage for invariant 6. Reads never mint App credentials or mutate a remote.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ContainedMissionStore, RevisionChain, RevisionChainStore } from '@osstack/core';
import { defaultGhExec, type GhExec } from './contained-mission-bridge-reader.js';
import type { RevisionPublicationDeps } from './contained-mission-revision-publication.js';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const hash = (commits: readonly string[]) => createHash('sha256').update(JSON.stringify(commits)).digest('hex');
const pageSchema = z.object({ total_commits: z.number().int().nonnegative(), commits: z.array(z.object({ sha: z.string().regex(SHA) })) });

/** Unlike one revision's 64-commit limit, the chain range spans all rounds. Bound reads to 100 pages. */
export async function compareBridgeLedgerRange(repository: string, start: string, head: string, exec: GhExec = defaultGhExec, signal?: AbortSignal): Promise<readonly string[]> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !SHA.test(start) || !SHA.test(head)) throw Error('bridge_ledger_target_invalid');
  const commits: string[] = []; let total: number | undefined;
  for (let page = 1; page <= 100; page++) {
    signal?.throwIfAborted();
    const response = await exec(['api', `repos/${repository}/compare/${start}...${head}?per_page=100&page=${page}`], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (response.exitCode !== 0) throw Error('bridge_ledger_read_failed');
    const facts = pageSchema.parse(JSON.parse(response.stdout) as unknown);
    total ??= facts.total_commits;
    if (total !== facts.total_commits || facts.commits.length > 100) throw Error('bridge_ledger_range_moved');
    commits.push(...facts.commits.map(c => c.sha));
    if (commits.length === total) {
      if (new Set(commits).size !== commits.length) throw Error('bridge_ledger_duplicate_commit');
      return commits;
    }
    if (commits.length > total || facts.commits.length !== 100) throw Error('bridge_ledger_range_incomplete');
  }
  throw Error('bridge_ledger_range_limit');
}

export type LedgerVerdict = 'matched' | 'external_write' | 'reconciliation_incomplete' | 'stale';
export type LedgerCompare = (repository: string, start: string, head: string, signal?: AbortSignal) => Promise<readonly string[]>;
type LedgerDeps = { chains: RevisionChainStore; missions: Pick<ContainedMissionStore, 'get'>; compare: LedgerCompare } & Pick<RevisionPublicationDeps, 'remoteHead'>;

/** Startup visits stopped chains too. A possible released write defers the audit and preserves its prior stop reason. */
export async function recoverBridgeLedgers(deps: LedgerDeps & { now: () => number; cancelChild?: (chain: RevisionChain) => Promise<void> }, signal: AbortSignal): Promise<void> {
  let cursor: { created_at: number; chain_id: string } | undefined;
  while (!signal.aborted) {
    const rows = deps.chains.db.prepare(`SELECT * FROM engineering_revision_chains WHERE mode='live' AND state<>'closed'
      AND (created_at>? OR (created_at=? AND chain_id>?)) ORDER BY created_at,chain_id LIMIT 10`)
      .all(cursor?.created_at ?? -1, cursor?.created_at ?? -1, cursor?.chain_id ?? '') as RevisionChain[];
    for (const chain of rows) {
      const verdict = await verifyBridgeLedger(deps, chain, signal);
      if (verdict === 'external_write') {
        const stopped = deps.chains.stopLive(chain.chain_id, chain.revision, 'external_write', deps.now());
        await deps.cancelChild?.(stopped);
      }
      cursor = { created_at: chain.created_at, chain_id: chain.chain_id };
    }
    if (rows.length < 10) return;
  }
  signal.throwIfAborted();
}

const repairStep = z.object({
  dispatch_id: z.string(), child_mission_id: z.string(), old_head: z.string().regex(SHA), new_head: z.string().regex(SHA),
}).strict();
const repairIntentId = /^vrp_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// Keep every payload key for the full-content comparison of repeated confirmations.
const childPayload = z.custom<Record<string, unknown>>(v => v !== null && typeof v === 'object' && !Array.isArray(v));
type RepairEvent = { seq: number; payload_json: string };

/** Both verdicts need the same dispatch, approval, intent and released process. */
function validatedRepair(chains: RevisionChainStore, chain: RevisionChain, evidence: RepairEvent | { remote: string }) {
  const dispatch = chains.db.prepare(`SELECT dispatch_id,child_mission_id FROM engineering_local_failure_dispatches
    WHERE chain_id=? AND root_mission_id=?`).get(chain.chain_id, chain.root_mission_id) as { dispatch_id: string; child_mission_id: string } | undefined;
  if (!dispatch) return null;
  try {
    const confirmed = 'payload_json' in evidence;
    if (confirmed && typeof evidence.payload_json !== 'string') return null;
    const parsed = repairStep.safeParse(confirmed ? JSON.parse(evidence.payload_json) : { ...dispatch, old_head: chain.published_head, new_head: evidence.remote });
    if (!parsed.success) return null;
    const step = parsed.data;
    if (step.dispatch_id !== dispatch.dispatch_id || step.child_mission_id !== dispatch.child_mission_id || step.old_head === step.new_head) return null;
    const rows = chains.db.prepare(`SELECT seq,kind,payload_json FROM engineering_contained_events WHERE mission_id=?
      AND kind IN ('verify_repair_approval','verify_repair_push_intent','verify_repair_push_confirmed') ORDER BY seq`).all(step.child_mission_id) as (RepairEvent & { kind: string })[];
    if (rows.some(row => typeof row.payload_json !== 'string')) return null;
    const events = rows.map(row => ({ ...row, data: childPayload.parse(JSON.parse(row.payload_json)) }));
    const approvals = events.filter(e => e.kind === 'verify_repair_approval');
    const intents = events.filter(e => e.kind === 'verify_repair_push_intent');
    const confirmations = events.filter(e => e.kind === 'verify_repair_push_confirmed');
    const [approval] = approvals, [intent] = intents;
    if (approvals.length !== 1 || intents.length !== 1 || !approval || !intent || approval.seq >= intent.seq) return null;
    const target = (data: Record<string, unknown>) => data.candidate === step.new_head && data.branch === chain.branch
      && data.base === chain.published_base && data.pr === chain.pr_number;
    const id = intent.data.intent_id;
    if (!target(approval.data) || approval.data.old !== step.old_head || approval.data.dispatch_id !== step.dispatch_id
      || !target(intent.data) || intent.data.previous !== step.old_head || typeof id !== 'string' || !repairIntentId.test(id)) return null;
    if (confirmed !== (confirmations.length > 0)) return null;
    if (confirmations.some(c => c.seq <= intent.seq || !target(c.data) || c.data.intent_id !== id || c.data.previous !== step.old_head
      || !isDeepStrictEqual(c.data, confirmations[0]!.data))) return null;
    const process = chains.db.prepare(`SELECT state FROM engineering_host_processes WHERE intent_id=? AND kind='git_push'
      AND mission_id=? AND released_at IS NOT NULL`).get(id, step.child_mission_id) as { state: string } | undefined;
    return process && (!confirmed || process.state === 'stopped') ? step : null;
  } catch (error) {
    // A deeply nested corrupt confirmation can exceed the structural comparison's stack.
    if (error instanceof SyntaxError || error instanceof z.ZodError || (error instanceof RangeError && error.message === 'Maximum call stack size exceeded')) return null;
    throw error;
  }
}

function releasedRepairAtRemote(chains: RevisionChainStore, chain: RevisionChain, remote: string | null) {
  return remote !== null && remote !== chain.published_head && validatedRepair(chains, chain, { remote }) !== null;
}

/** Verify a captured ledger version; transport failures throw and must never be converted into external-write evidence. */
export async function verifyBridgeLedger(deps: LedgerDeps, chain: RevisionChain, signal: AbortSignal): Promise<LedgerVerdict> {
  signal.throwIfAborted();
  const intents = deps.chains.intents(chain.chain_id).filter(i => i.kind !== 'check');
  const readRepairs = () => deps.chains.db.prepare(`SELECT seq,payload_json FROM engineering_revision_chain_events
    WHERE chain_id=? AND kind='local_repair_push_confirmed' ORDER BY seq`).all(chain.chain_id) as RepairEvent[];
  const repairs = readRepairs();
  const fingerprint = JSON.stringify([intents, repairs]);
  const unsettled = intents.filter(i => i.kind === 'push' && (i.state === 'pending' || i.state === 'uncertain'));
  const released = () => unsettled.some(i => deps.chains.db.prepare('SELECT 1 FROM engineering_host_processes WHERE intent_id=? AND released_at IS NOT NULL').get(i.intent_id));
  if (released()) return 'reconciliation_incomplete';
  const root = deps.missions.get(chain.root_mission_id);
  const spec = JSON.parse(root.spec_json) as { start_commit?: unknown; worktree_path?: unknown; publication?: { remote?: unknown } };
  if (typeof spec.start_commit !== 'string' || !SHA.test(spec.start_commit) || typeof spec.worktree_path !== 'string' || typeof spec.publication?.remote !== 'string') return 'external_write';
  const remote = await deps.remoteHead(spec.worktree_path, spec.publication.remote, chain.branch, chain.repository);
  signal.throwIfAborted();
  if (unsettled.some(i => i.new_head === remote)) return 'reconciliation_incomplete';
  if (!repairs.length && releasedRepairAtRemote(deps.chains, chain, remote)) {
    return readRepairs().length ? 'stale' : 'reconciliation_incomplete';
  }
  const baseline = intents.filter(i => i.kind === 'open_pr');
  const pending = intents.filter(i => i.kind === 'push' && i.state === 'confirmed');
  let expected = spec.start_commit; const covered: string[] = []; let invalid = baseline.length !== 1 || baseline[0]?.state !== 'confirmed';
  let repair = repairs.length === 1 ? validatedRepair(deps.chains, chain, repairs[0]!) : null;
  if (repairs.length && !repair) invalid = true;
  let intent = baseline[0];
  while (intent && !invalid) {
    const event = deps.chains.pushRangeEvent(chain.chain_id, intent.intent_id);
    const payload = event ? z.object({ commits: z.array(z.string().regex(SHA)).nonempty() }).safeParse(JSON.parse(event.payload_json) as unknown) : undefined;
    const binding = z.object({ commit_count: z.number().int().positive(), range_sha256: z.string() }).safeParse(JSON.parse(intent.binding_json) as unknown);
    if (!payload?.success || !binding.success || intent.expected_old_head !== expected || intent.branch !== chain.branch
      || intent.repository !== chain.repository || intent.pr_number !== chain.pr_number || intent.expected_base_sha !== chain.published_base
      || payload.data.commits.at(-1) !== intent.new_head || binding.data.commit_count !== payload.data.commits.length
      || binding.data.range_sha256 !== hash(payload.data.commits)) { invalid = true; break; }
    covered.push(...payload.data.commits); expected = intent.new_head!;
    let next = pending.filter(i => i.expected_old_head === expected);
    if (repair?.old_head === expected) {
      if (next.length) { invalid = true; break; }
      covered.push(repair.new_head); expected = repair.new_head; repair = null;
      next = pending.filter(i => i.expected_old_head === expected);
    }
    if (next.length > 1) { invalid = true; break; }
    intent = next[0];
    if (intent) pending.splice(pending.indexOf(intent), 1);
  }
  if (repair || pending.length) invalid = true;
  if (expected !== chain.published_head || new Set(covered).size !== covered.length) invalid = true;
  const actual = invalid ? [] : await deps.compare(chain.repository, spec.start_commit, chain.published_head, signal);
  signal.throwIfAborted();
  if (deps.chains.get(chain.chain_id).revision !== chain.revision || fingerprint !== JSON.stringify([deps.chains.intents(chain.chain_id).filter(i => i.kind !== 'check'), readRepairs()])) return 'stale';
  if (released()) return 'reconciliation_incomplete';
  return invalid || remote !== chain.published_head || JSON.stringify(covered) !== JSON.stringify(actual) ? 'external_write' : 'matched';
}
