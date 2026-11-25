export const FOLLOWUP_WINDOW_MS = 7 * 24 * 3600 * 1000;

export interface MergedChain {
  mission_id: string;
  repository: string;
  pr: number;
  merge_commit_sha: string;
  merged_at_ms: number;
}

export interface LaterCommit {
  sha: string;
  committed_at_ms: number;
  message: string;
  files: readonly string[];
}

export interface FollowupReadPort {
  /** Files changed by the merge commit. null = read failed. */
  mergedFiles(chain: MergedChain, signal: AbortSignal): Promise<readonly string[] | null>;
  /** Default-branch commits after the merge through untilMs. null = read failed or incomplete. */
  laterCommits(chain: MergedChain, untilMs: number, signal: AbortSignal): Promise<readonly LaterCommit[] | null>;
}

type Classification = 'clean' | 'reverted' | 'hot_fixed';
export type FollowupVerdict = Classification | 'pending' | 'unknown';
type Finding = { verdict: Classification; by?: string };

function findFollowup(chain: MergedChain, files: readonly string[], later: readonly LaterCommit[]): Finding {
  const until = chain.merged_at_ms + FOLLOWUP_WINDOW_MS;
  const commits = later.filter(commit => chain.merged_at_ms < commit.committed_at_ms && commit.committed_at_ms <= until)
    .sort((a, b) => a.committed_at_ms - b.committed_at_ms || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  const mergedFiles = new Set(files);
  const prRevert = `Reverts ${chain.repository}#${chain.pr}`;
  const shaRevert = `This reverts commit ${chain.merge_commit_sha}`;
  let firstFix: Finding | undefined;
  for (const commit of commits) {
    if (commit.message.includes(shaRevert)) return { verdict: 'reverted', by: commit.sha };
    for (let i = commit.message.indexOf(prRevert); i >= 0; i = commit.message.indexOf(prRevert, i + prRevert.length)) {
      if (!/[0-9]/.test(commit.message.charAt(i + prRevert.length))) return { verdict: 'reverted', by: commit.sha };
    }
    const firstLine = commit.message.split(/\r\n|[\r\n]/, 1)[0]!;
    if (!firstFix && /^(fix|hotfix)(\([^)]*\))?!?:/i.test(firstLine) && commit.files.some(file => mergedFiles.has(file))) {
      firstFix = { verdict: 'hot_fixed', by: commit.sha };
    }
  }
  return firstFix ?? { verdict: 'clean' };
}

export function classifyFollowup(chain: MergedChain, files: readonly string[], later: readonly LaterCommit[]): Classification {
  return findFollowup(chain, files, later).verdict;
}

export async function computeFollowupStats(chains: readonly MergedChain[], port: FollowupReadPort, nowMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const totals = { pending: 0, unknown: 0, clean: 0, reverted: 0, hot_fixed: 0 };
  const rows: Array<{ mission_id: string; verdict: FollowupVerdict; by?: string }> = [];
  for (const chain of chains) {
    const until = chain.merged_at_ms + FOLLOWUP_WINDOW_MS;
    let result: { verdict: FollowupVerdict; by?: string } = { verdict: 'pending' };
    if (nowMs >= until) {
      result = { verdict: 'unknown' };
      try {
        const files = await port.mergedFiles(chain, signal);
        signal.throwIfAborted();
        if (files !== null) {
          const later = await port.laterCommits(chain, until, signal);
          signal.throwIfAborted();
          if (later !== null) result = findFollowup(chain, files, later);
        }
      } catch {
        signal.throwIfAborted();
      }
    }
    totals[result.verdict]++;
    rows.push({ mission_id: chain.mission_id, ...result });
  }
  const eligible = totals.clean + totals.reverted + totals.hot_fixed;
  return { counts: 'reverted or hot-fixed chains / merged chains with a complete 7-day window and successful reads',
    window_ms: FOLLOWUP_WINDOW_MS, merged: chains.length, ...totals, eligible,
    rate: eligible ? (totals.reverted + totals.hot_fixed) / eligible : null, rows };
}
