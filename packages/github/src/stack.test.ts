import { describe, expect, it } from "vitest";
import { detectDrift, ingestStack, mapRollupToCheckState } from "./stack.js";
import type { CommandRunner } from "./branch-scanner.js";
import type { StackModel } from "./stack.js";

function prViewJson(pr: {
  number: number;
  state?: string;
  baseRefName: string;
  headRefName: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: unknown[];
  title?: string;
  url?: string;
}): string {
  return JSON.stringify({
    number: pr.number,
    state: pr.state ?? "OPEN",
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    mergeable: pr.mergeable ?? "MERGEABLE",
    mergeStateStatus: pr.mergeStateStatus ?? "CLEAN",
    statusCheckRollup: pr.statusCheckRollup ?? [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    title: pr.title ?? `PR #${pr.number}`,
    url: pr.url ?? `https://github.com/o/r/pull/${pr.number}`,
  });
}

describe("mapRollupToCheckState", () => {
  it("returns unknown for empty/absent rollup", () => {
    expect(mapRollupToCheckState(undefined)).toBe("unknown");
    expect(mapRollupToCheckState([])).toBe("unknown");
  });

  it("returns failure when any check has a failing conclusion", () => {
    expect(
      mapRollupToCheckState([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: "FAILURE", status: "COMPLETED" },
      ]),
    ).toBe("failure");
  });

  it("returns pending when any check is still in progress", () => {
    expect(
      mapRollupToCheckState([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: null, status: "IN_PROGRESS" },
      ]),
    ).toBe("pending");
  });

  it("returns success when all checks succeeded/neutral/skipped", () => {
    expect(
      mapRollupToCheckState([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: "NEUTRAL", status: "COMPLETED" },
        { conclusion: "SKIPPED", status: "COMPLETED" },
      ]),
    ).toBe("success");
  });
});

describe("StatusContext rollups", () => {
  const context = (state: unknown) => ({ __typename: "StatusContext", context: "legacy-ci", state, targetUrl: "https://example.invalid/build" });

  it.each([
    ["SUCCESS", "success"], ["FAILURE", "failure"], ["ERROR", "failure"],
    ["PENDING", "pending"], ["EXPECTED", "pending"],
  ])("maps legacy status %s to %s", (state, expected) => {
    expect(mapRollupToCheckState([context(state)])).toBe(expected);
  });

  it.each([undefined, null, "FUTURE_STATE"])("does not invent success for missing or unknown status %s", state => {
    expect(mapRollupToCheckState([{ ...context(state), conclusion: "SUCCESS", status: "COMPLETED" }])).not.toBe("success");
  });

  it("accepts a state-shaped legacy context without a typename", () => {
    expect(mapRollupToCheckState([{ context: "legacy-ci", state: "SUCCESS" }])).toBe("success");
    expect(mapRollupToCheckState([{ context: "legacy-ci", state: "FAILURE" }])).toBe("failure");
  });

  it("a legacy failure dominates a pending CheckRun and successful context", () => {
    expect(mapRollupToCheckState([
      context("SUCCESS"), { conclusion: null, status: "QUEUED" }, context("ERROR"),
    ])).toBe("failure");
  });

  it("a CheckRun failure still dominates pending and successful legacy contexts", () => {
    expect(mapRollupToCheckState([
      context("PENDING"), { __typename: "CheckRun", conclusion: "FAILURE", status: "COMPLETED" }, context("SUCCESS"),
    ])).toBe("failure");
  });

  it("legacy success does not hide a pending CheckRun", () => {
    expect(mapRollupToCheckState([context("SUCCESS"), { conclusion: null, status: "IN_PROGRESS" }])).toBe("pending");
  });

  it("keeps the existing neutral and skipped CheckRun policy beside legacy success", () => {
    expect(mapRollupToCheckState([
      context("SUCCESS"), { conclusion: "NEUTRAL", status: "COMPLETED" }, { conclusion: "SKIPPED", status: "COMPLETED" },
    ])).toBe("success");
  });

  it.each([
    ["SUCCESS", "success", null], ["FAILURE", "failure", "ci_failing"],
    ["ERROR", "failure", "ci_failing"], ["PENDING", "pending", "ci_pending"], ["EXPECTED", "pending", "ci_pending"],
  ])("ingests %s through the real stack parser with correct drift classification", async (state, expected, issue) => {
    const calls: string[][] = [];
    const runner: CommandRunner = { run: async (command, args) => {
      calls.push([command, ...args]);
      return prViewJson({ number: 9, baseRefName: "main", headRefName: "feature", statusCheckRollup: [context(state)] });
    } };
    const model = await ingestStack({ repo: "fixture/repo", prNumbers: [9] }, runner);
    expect(model.nodes[0]?.ciState).toBe(expected);
    expect(model.order).toEqual([9]); expect(model.edges).toEqual([]);
    const drift = detectDrift(model);
    expect(drift.issues.map(row => row.kind)).toEqual(issue ? [issue] : []);
    expect(drift.clean).toBe(issue === null);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(["gh", "pr", "view", "9"]);
  });
});

describe("ingestStack", () => {
  it("builds a 3-PR linear chain with edges and bottom-up order", async () => {
    const runner: CommandRunner = {
      run: async (command, args) => {
        const joined = `${command} ${args.join(" ")}`;
        if (joined.startsWith("gh pr view 47")) {
          return prViewJson({ number: 47, baseRefName: "main", headRefName: "feat/a" });
        }
        if (joined.startsWith("gh pr view 48")) {
          return prViewJson({ number: 48, baseRefName: "feat/a", headRefName: "feat/b" });
        }
        if (joined.startsWith("gh pr view 49")) {
          return prViewJson({ number: 49, baseRefName: "feat/b", headRefName: "feat/c" });
        }
        throw new Error(`unexpected command: ${joined}`);
      },
    };

    const stack = await ingestStack({ prNumbers: [49, 47, 48] }, runner);

    expect(stack.nodes).toHaveLength(3);
    expect(stack.edges).toEqual(
      expect.arrayContaining([
        { parent: 47, child: 48 },
        { parent: 48, child: 49 },
      ]),
    );
    expect(stack.order).toEqual([47, 48, 49]);
  });

  it("passes --repo when spec.repo is provided", async () => {
    let sawRepoFlag = false;
    const runner: CommandRunner = {
      run: async (_command, args) => {
        if (args.includes("--repo") && args.includes("o/r")) sawRepoFlag = true;
        return prViewJson({ number: 1, baseRefName: "main", headRefName: "feat/x" });
      },
    };

    await ingestStack({ prNumbers: [1], repo: "o/r" }, runner);
    expect(sawRepoFlag).toBe(true);
  });

  it("builds a single-PR stack with order [1], no edges, no drift", async () => {
    const runner: CommandRunner = {
      run: async () => prViewJson({ number: 1, baseRefName: "main", headRefName: "feat/x" }),
    };

    const stack = await ingestStack({ prNumbers: [1] }, runner);

    expect(stack.order).toEqual([1]);
    expect(stack.edges).toEqual([]);
    expect(detectDrift(stack)).toEqual({ clean: true, issues: [] });
  });

  it("rejects with PR context when gh output is not valid JSON", async () => {
    const runner: CommandRunner = {
      run: async (command, args) => {
        const joined = `${command} ${args.join(" ")}`;
        if (joined.startsWith("gh pr view 47")) {
          return prViewJson({ number: 47, baseRefName: "main", headRefName: "feat/a" });
        }
        if (joined.startsWith("gh pr view 48")) return "not json";
        throw new Error(`unexpected command: ${joined}`);
      },
    };

    await expect(ingestStack({ prNumbers: [47, 48] }, runner)).rejects.toThrow(/#48/);
  });

  it("rejects on a dependency cycle among PRs", async () => {
    const runner: CommandRunner = {
      run: async (command, args) => {
        const joined = `${command} ${args.join(" ")}`;
        // 10's base is 11's head and 11's base is 10's head -> a 2-cycle.
        if (joined.startsWith("gh pr view 10")) {
          return prViewJson({ number: 10, baseRefName: "feat/b", headRefName: "feat/a" });
        }
        if (joined.startsWith("gh pr view 11")) {
          return prViewJson({ number: 11, baseRefName: "feat/a", headRefName: "feat/b" });
        }
        throw new Error(`unexpected command: ${joined}`);
      },
    };

    await expect(ingestStack({ prNumbers: [10, 11] }, runner)).rejects.toThrow(/cycle/i);
  });

  it("propagates a runner rejection out of ingestStack", async () => {
    const runner: CommandRunner = {
      run: async () => {
        throw new Error("gh exploded");
      },
    };

    await expect(ingestStack({ prNumbers: [1] }, runner)).rejects.toThrow("gh exploded");
  });
});

describe("detectDrift", () => {
  function baseStack(): StackModel {
    return {
      nodes: [
        {
          number: 47,
          state: "OPEN",
          base: "main",
          head: "feat/a",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          ciState: "success",
          title: "PR 47",
          url: "https://github.com/o/r/pull/47",
        },
        {
          number: 48,
          state: "OPEN",
          base: "feat/a",
          head: "feat/b",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          ciState: "success",
          title: "PR 48",
          url: "https://github.com/o/r/pull/48",
        },
      ],
      edges: [{ parent: 47, child: 48 }],
      order: [47, 48],
    };
  }

  it("returns clean for a healthy stack", () => {
    expect(detectDrift(baseStack())).toEqual({ clean: true, issues: [] });
  });

  it("flags not_mergeable when a node is CONFLICTING", () => {
    const stack = baseStack();
    stack.nodes[1]!.mergeable = "CONFLICTING";

    const report = detectDrift(stack);
    expect(report.clean).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ number: 48, kind: "not_mergeable" }),
    );
  });

  it("flags ci_failing when a node's CI failed", () => {
    const stack = baseStack();
    stack.nodes[1]!.ciState = "failure";

    const report = detectDrift(stack);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ number: 48, kind: "ci_failing" }),
    );
  });

  it("flags orphan_base when a node's base isn't in the stack and isn't the root base", () => {
    const stack = baseStack();
    stack.nodes[1]!.base = "feat/unrelated";
    stack.edges = [];

    const report = detectDrift(stack);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ number: 48, kind: "orphan_base" }),
    );
  });

  it("flags a non-root PR based directly on the root ref as orphan_base", () => {
    // Stack: 47(main->a), 48(a->b), 49(main->c). #47 is the true root; #49 is a
    // mis-rebased non-root PR that bases directly on "main" and must be flagged.
    const stack: StackModel = {
      nodes: [
        {
          number: 47,
          state: "OPEN",
          base: "main",
          head: "feat/a",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          ciState: "success",
          title: "PR 47",
          url: "https://github.com/o/r/pull/47",
        },
        {
          number: 48,
          state: "OPEN",
          base: "feat/a",
          head: "feat/b",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          ciState: "success",
          title: "PR 48",
          url: "https://github.com/o/r/pull/48",
        },
        {
          number: 49,
          state: "OPEN",
          base: "main",
          head: "feat/c",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          ciState: "success",
          title: "PR 49",
          url: "https://github.com/o/r/pull/49",
        },
      ],
      edges: [{ parent: 47, child: 48 }],
      order: [47, 48, 49],
    };

    const report = detectDrift(stack);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ number: 49, kind: "orphan_base" }),
    );
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ number: 47, kind: "orphan_base" }),
    );
  });
});
