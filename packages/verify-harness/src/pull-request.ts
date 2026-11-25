import { z } from "zod";
import { numericId, repository, sha, type HarnessEntry } from "./config.js";

export interface PullRequestPort {
  get(path: string, options: { signal: AbortSignal }): Promise<{ ok: true; body: unknown } | { ok: false }>;
}
const schema = z.object({
  state: z.string().min(1), number: numericId,
  base: z.object({ sha, repo: z.object({ id: numericId, full_name: repository }) }),
  head: z.object({ sha, repo: z.object({ id: numericId }).nullable() }),
});
export type PullRequestRefusal = "pr_read_failed" | "pr_not_open" | "scope_mismatch" | "fork";
export async function readPullRequest(entry: HarnessEntry, pr: number, port: PullRequestPort, options: { signal: AbortSignal }):
Promise<{ ok: true; head_sha: string; base_sha: string } | { ok: false; reason: PullRequestRefusal }> {
  try {
    const reply = await port.get(`repos/${entry.repository}/pulls/${pr}`, options);
    const parsed = reply.ok ? schema.safeParse(reply.body) : undefined;
    if (!parsed?.success) return { ok: false, reason: "pr_read_failed" };
    const { state, number, base, head } = parsed.data;
    if (state !== "open") return { ok: false, reason: "pr_not_open" };
    if (number !== pr || base.repo.id !== entry.repository_id || base.repo.full_name !== entry.repository)
      return { ok: false, reason: "scope_mismatch" };
    if (head.repo?.id !== base.repo.id) return { ok: false, reason: "fork" };
    return { ok: true, head_sha: head.sha, base_sha: base.sha };
  } catch {
    return { ok: false, reason: "pr_read_failed" };
  }
}
