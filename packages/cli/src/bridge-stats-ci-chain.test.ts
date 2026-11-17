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
