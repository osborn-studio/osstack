import { afterEach, describe, expect, it, vi } from "vitest";
import { printStats } from "./bin.js";

afterEach(() => vi.restoreAllMocks());
function output(ci_chain: unknown, loops?: unknown) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  printStats({ total_runs: 0, total_events: 0, per_agent: [], ci_chain, loops });
  return log.mock.calls.map(args => args.join(" ")).join("\n");
}
const chain = {
  ci_chain_available: true,
  ci_chain_scan_failing: 2, ci_chain_scan_failing_by_reason: [{ reason: "auth", count: 2 }],
  ci_chain_by_state: [{ state: "closed", count: 3 }],
  ci_chain_closed: 3, ci_chain_repaired_closed: 1, ci_chain_consecutive_normal_closed: 2,
  ci_chain_registration_to_close_ms: [
    { mission_id: "latest", duration_ms: 30 }, { mission_id: "older", duration_ms: 10 }, { mission_id: "oldest", duration_ms: 20 },
  ],
};
describe("stats CI chain text", () => {
  it("prints CI counts and median and latest duration without loop stats", () => {
    const text = output(chain);
    expect(text).toContain("CI chain");
    expect(text).toContain("scan_failing=2 auth=2");
    expect(text).toContain("by_state: closed=3");
    expect(text).toContain("closed=3 repaired_closed=1 consecutive_normal_closed=2");
    expect(text).toContain("registration_to_close_ms: median=20 latest=30");
  });
  it("prints CI chain with loop stats and averages the middle pair", () => {
    const text = output({ ...chain, ci_chain_registration_to_close_ms: chain.ci_chain_registration_to_close_ms.slice(0, 2) },
      { per_loop: [], avg_cycle_duration_ms: null });
    expect(text).toContain("registration_to_close_ms: median=20 latest=30");
  });
  it("keeps the latest missing duration unknown instead of substituting an older close", () => {
    expect(output({ ...chain, ci_chain_registration_to_close_ms: [{ mission_id: "latest", duration_ms: null }, { mission_id: "older", duration_ms: 10 }] }))
      .toContain("registration_to_close_ms: median=10 latest=-");
  });
  it("prints zero counts and missing durations for an empty ledger", () => {
    const text = output({ ...chain, ci_chain_by_state: [], ci_chain_closed: 0, ci_chain_repaired_closed: 0,
      ci_chain_consecutive_normal_closed: 0, ci_chain_registration_to_close_ms: [] });
    expect(text).toContain("by_state: -");
    expect(text).toContain("closed=0 repaired_closed=0 consecutive_normal_closed=0");
    expect(text).toContain("registration_to_close_ms: median=- latest=-");
  });
  it.each([undefined, null, { ci_chain_available: false }])("prints dashes when CI chain data is unavailable: %j", value => {
    const text = output(value);
    expect(text).toContain("by_state: -");
    expect(text).toContain("closed=- repaired_closed=- consecutive_normal_closed=-");
    expect(text).toContain("registration_to_close_ms: median=- latest=-");
  });
});

describe("CI chain wait and outcome lines", () => {
  const reason = "not_wired: needs a read of later commits on the default branch; only the pure calculation exists";
  const full = {
    ...chain,
    ci_chain_first_pass: { closed: 4, first_pass: 3, rate: 0.75 },
    ci_chain_hop_wait_ms: { closed_chains: 4, out_of_order: 0, hops: [{ hop: "registered->pr_opened", n: 4, median_ms: 10, p95_ms: 20 }] },
    ci_chain_open_wait_ms: { open_chains: 2, clock_skew: 0, by_state: [{ state: "initial_ci_waiting", n: 2, median_ms: 1000.5, max_ms: 3000 }],
      longest: [{ mission_id: "root:one", state: "initial_ci_waiting", wait_ms: 3000 }] },
    ci_chain_reverted_or_hotfixed_7d: { value: null, reason },
  };
  function lines(stats: unknown) {
    const all = output(stats).split("\n");
    return all.slice(1 + all.findIndex(line => line.startsWith("registration_to_close_ms:")));
  }
  it("prints first pass, hop and open waits, and the followup read status", () => {
    expect(lines(full)).toEqual([
      "first_pass_rate: 3/4 = 75.0% (n=4 closed chains; first pass = no CI failure observed and no repair dispatched)",
      "hop_wait_ms (n=4 closed chains; wait between consecutive recorded stages):",
      "  registered->pr_opened n=4 median=10 p95=20",
      "open_wait_ms (n=2 open chains; now minus start of current state):",
      "  initial_ci_waiting n=2 median=1000.5 max=3000",
      "  longest: root:one initial_ci_waiting wait_ms=3000",
      `reverted_or_hotfixed_within_7d: not measured (${reason})`,
    ]);
  });
  it("reports empty samples", () => {
    expect(lines({ ...full, ci_chain_first_pass: { closed: 0, first_pass: 0, rate: null },
      ci_chain_hop_wait_ms: { closed_chains: 0, hops: [], out_of_order: 0 },
      ci_chain_open_wait_ms: { open_chains: 0, by_state: [], longest: [], clock_skew: 0 } })).toEqual([
      "first_pass_rate: no data (n=0 closed chains)", "hop_wait_ms: no data (n=0 closed chains)",
      "open_wait_ms: no data (n=0 open chains)", `reverted_or_hotfixed_within_7d: not measured (${reason})`,
    ]);
  });
  it("reports each field missing from an older daemon", () => {
    expect(lines(chain)).toEqual(["first_pass_rate: unavailable", "hop_wait_ms: unavailable",
      "open_wait_ms: unavailable", "reverted_or_hotfixed_within_7d: unavailable"]);
  });
  it("prints skew counts, missing stage pairs and at most three safe mission IDs", () => {
    const result = lines({ ...full, ci_chain_hop_wait_ms: { closed_chains: 1, hops: [], out_of_order: 2 },
      ci_chain_open_wait_ms: { ...full.ci_chain_open_wait_ms, open_chains: 5, clock_skew: 1,
        longest: ["bad\nid", "x".repeat(81), "abc.:-_1", "fourth"].map(mission_id => ({ mission_id, state: "merge_held", wait_ms: 1 })) } });
    expect(result).toContain("hop_wait_ms: no data (n=1 closed chains, no stage pairs recorded) out_of_order=2");
    expect(result).toContain("open_wait_ms (n=5 open chains; now minus start of current state): clock_skew=1");
    expect(result.filter(line => line.startsWith("  longest:"))).toEqual([
      "  longest: ? merge_held wait_ms=1", "  longest: ? merge_held wait_ms=1", "  longest: abc.:-_1 merge_held wait_ms=1",
    ]);
  });
});
