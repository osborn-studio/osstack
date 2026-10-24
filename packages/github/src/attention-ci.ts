import { z } from "zod";
import { defaultCommandRunner, type CommandRunner } from "./branch-scanner.js";
const Input = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pr: z.number().int().positive(),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    required: z.array(z.string().min(1).max(256)).max(100),
  })
  .strict();
const Snapshot = z.object({
  headRefOid: z.string(),
  statusCheckRollup: z.array(
    z.object({
      name: z.string().optional(),
      context: z.string().optional(),
      status: z.string().optional(),
      conclusion: z.string().nullable().optional(),
      state: z.string().optional(),
    })
  ),
});
export interface AttentionCiResult {
  state: "unknown" | "pending" | "failed" | "passed";
  head: string;
  sampled_at: number;
  reason: string;
  required: string[];
}
/** Separate bounded read queue. Results are informational, never merge authority. */
export class AttentionCiReader {
  private active = 0;
  private cache = new Map<
    string,
    { until: number; result: AttentionCiResult }
  >();
  constructor(readonly runner: CommandRunner = defaultCommandRunner) {}
  async read(raw: unknown, now = Date.now()): Promise<AttentionCiResult> {
    const input = Input.parse(raw);
    const key = JSON.stringify(input);
    const cached = this.cache.get(key);
    if (cached && now >= cached.result.sampled_at && now < cached.until)
      return cached.result;
    const unknown = (reason: string): AttentionCiResult => ({
      state: "unknown",
      head: input.head,
      sampled_at: now,
      reason,
      required: input.required,
    });
    if (this.active >= 2) return unknown("queue_capacity");
    this.active++;
    let result: AttentionCiResult;
    try {
      const data = Snapshot.parse(
        JSON.parse(
          await this.runner.run("gh", [
            "pr",
            "view",
            String(input.pr),
            "--repo",
            input.repo,
            "--json",
            "headRefOid,statusCheckRollup",
          ])
        )
      );
      if (data.headRefOid !== input.head) result = unknown("head_changed");
      else if (input.required.length === 0)
        result = unknown("required_checks_unspecified");
      else {
        const values = input.required.map((name) =>
          data.statusCheckRollup.filter((c) => (c.name ?? c.context) === name)
        );
        const missing = values.some((v) => v.length !== 1);
        const checks = values.flat();
        const failed = checks.some((c) =>
          [
            "FAILURE",
            "ERROR",
            "CANCELLED",
            "TIMED_OUT",
            "ACTION_REQUIRED",
          ].includes((c.conclusion ?? c.state ?? "").toUpperCase())
        );
        const passed = checks.every(
          (c) => (c.conclusion ?? c.state ?? "").toUpperCase() === "SUCCESS"
        );
        result = {
          state: missing
            ? "unknown"
            : failed
            ? "failed"
            : passed
            ? "passed"
            : "pending",
          head: input.head,
          sampled_at: now,
          reason: missing
            ? "missing_or_ambiguous_required_check"
            : "exact_head_snapshot_only",
          required: input.required,
        };
      }
    } catch {
      result = unknown("credentials_network_rate_limit_or_invalid_source");
    } finally {
      this.active--;
    }
    if (this.cache.size >= 100)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      until: now + (result.state === "unknown" ? 60000 : 15000),
      result,
    });
    return result;
  }
}
