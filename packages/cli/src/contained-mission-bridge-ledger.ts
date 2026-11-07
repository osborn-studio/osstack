// Exact commit coverage for invariant 6. Reads never mint App credentials or mutate a remote.
import { createHash } from 'node:crypto';
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
    const response = await exec(['api', `repos/${repository}/compare/${start}...${head}?per_page=100&page=${page}`], { timeoutMs: 30_000 });
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

/** Verify a captured ledger version; transport failures throw and must never be converted into external-write evidence. */
export async function verifyBridgeLedger(deps: LedgerDeps, chain: RevisionChain, signal: AbortSignal): Promise<LedgerVerdict> {
  signal.throwIfAborted();
  const intents = deps.chains.intents(chain.chain_id).filter(i => i.kind !== 'check');
  const fingerprint = JSON.stringify(intents);
  const unsettled = intents.filter(i => i.kind === 'push' && (i.state === 'pending' || i.state === 'uncertain'));
  const released = () => unsettled.some(i => deps.chains.db.prepare('SELECT 1 FROM engineering_host_processes WHERE intent_id=? AND released_at IS NOT NULL').get(i.intent_id));
  if (released()) return 'reconciliation_incomplete';
  const root = deps.missions.get(chain.root_mission_id);
  const spec = JSON.parse(root.spec_json) as { start_commit?: unknown; worktree_path?: unknown; publication?: { remote?: unknown } };
  if (typeof spec.start_commit !== 'string' || !SHA.test(spec.start_commit) || typeof spec.worktree_path !== 'string' || typeof spec.publication?.remote !== 'string') return 'external_write';
  const remote = await deps.remoteHead(spec.worktree_path, spec.publication.remote, chain.branch, chain.repository);
  signal.throwIfAborted();
  if (unsettled.some(i => i.new_head === remote)) return 'reconciliation_incomplete';
  const baseline = intents.filter(i => i.kind === 'open_pr');
  const pending = intents.filter(i => i.kind === 'push' && i.state === 'confirmed');
  let expected = spec.start_commit; const covered: string[] = []; let invalid = baseline.length !== 1 || baseline[0]?.state !== 'confirmed';
  const ordered = baseline.length === 1 ? [baseline[0]!] : [];
  while (ordered.length && pending.length) {
    const nextHead = ordered.at(-1)!.new_head;
    const next = pending.filter(i => i.expected_old_head === nextHead);
    if (next.length !== 1) { invalid = true; break; }
    ordered.push(next[0]!); pending.splice(pending.indexOf(next[0]!), 1);
  }
  if (pending.length) invalid = true;
  for (const intent of ordered) {
    const event = deps.chains.pushRangeEvent(chain.chain_id, intent.intent_id);
    const payload = event ? z.object({ commits: z.array(z.string().regex(SHA)).nonempty() }).safeParse(JSON.parse(event.payload_json) as unknown) : undefined;
    const binding = z.object({ commit_count: z.number().int().positive(), range_sha256: z.string() }).safeParse(JSON.parse(intent.binding_json) as unknown);
    if (!payload?.success || !binding.success || intent.expected_old_head !== expected || intent.branch !== chain.branch
      || intent.repository !== chain.repository || intent.pr_number !== chain.pr_number || intent.expected_base_sha !== chain.published_base
      || payload.data.commits.at(-1) !== intent.new_head || binding.data.commit_count !== payload.data.commits.length
      || binding.data.range_sha256 !== hash(payload.data.commits)) { invalid = true; break; }
    covered.push(...payload.data.commits); expected = intent.new_head!;
  }
  if (expected !== chain.published_head || new Set(covered).size !== covered.length) invalid = true;
  const actual = invalid ? [] : await deps.compare(chain.repository, spec.start_commit, chain.published_head, signal);
  signal.throwIfAborted();
  if (deps.chains.get(chain.chain_id).revision !== chain.revision || fingerprint !== JSON.stringify(deps.chains.intents(chain.chain_id).filter(i => i.kind !== 'check'))) return 'stale';
  if (released()) return 'reconciliation_incomplete';
  return invalid || remote !== chain.published_head || JSON.stringify(covered) !== JSON.stringify(actual) ? 'external_write' : 'matched';
}
