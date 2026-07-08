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
});
