import { describe, expect, it } from "vitest";
import type { AutonomyRiskLevel } from "@osstack/protocol";
import {
  classifyPostDiffRisk,
  classifyPreflightRisk,
  maxRisk,
} from "./risk.js";

const POLICY_SHA = "a".repeat(64);
const NOW = "2026-07-28T21:00:00.000Z";

function intent(expectedPaths: string[], requestedActions = ["build"]) {
  return {
    autonomy_run_id: "run-1",
    task_id: "task-1",
    repo_id: "gilosbornhello/osstack",
    workspace_path: "/worktrees/task-1",
    goal: "implement the requested change",
    expected_paths: expectedPaths,
    requested_actions: requestedActions,
    contract_sha256: "b".repeat(64),
  };
}

function postDiff(options: {
  paths?: string[];
  diff?: string;
  commands?: string[];
  majorDependency?: boolean;
}) {
  const paths = options.paths ?? [];
  return {
    base_commit_sha: "c".repeat(40),
    changed_paths: [...paths].sort(),
    staged_diff_binary:
      options.diff ??
      paths
        .map(
          (path) =>
            `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n+safe change\n`,
        )
        .join(""),
    status_porcelain_v1_z: paths.map((path) => `M  ${path}\0`).join(""),
    commands: options.commands ?? [],
    dependency_changes:
      options.majorDependency === undefined
        ? []
        : [
            {
              name: "example-dependency",
              from: "1.0.0",
              to: options.majorDependency ? "2.0.0" : "1.1.0",
              major: options.majorDependency,
            },
          ],
  };
}

function classifyPost(
  options: Parameters<typeof postDiff>[0],
  context: {
    repo_id?: string;
    protected_policy_paths?: string[];
  } = {},
) {
  return classifyPostDiffRisk(postDiff(options), {
    policy_sha256: POLICY_SHA,
    now: () => NOW,
    repo_id: context.repo_id ?? "gilosbornhello/example",
    protected_policy_paths: context.protected_policy_paths ?? [],
  });
}

describe("deterministic guarded-autonomy risk", () => {
  it("classifies preflight read-only, docs/tests, and source intent", () => {
    expect(
      classifyPreflightRisk(intent([], ["analyze"]), {
        policy_sha256: POLICY_SHA,
        now: () => NOW,
      }).level,
    ).toBe("R0");
    expect(
      classifyPreflightRisk(intent(["docs/guide.md"]), {
        policy_sha256: POLICY_SHA,
        now: () => NOW,
      }).level,
    ).toBe("R1");
    expect(
      classifyPreflightRisk(intent(["src/feature.ts"]), {
        policy_sha256: POLICY_SHA,
        now: () => NOW,
      }).level,
    ).toBe("R2");
  });

  it.each<[string, Parameters<typeof postDiff>[0], AutonomyRiskLevel]>([
    ["no staged change", { paths: [], diff: "" }, "R0"],
    ["Markdown only", { paths: ["docs/readme.md"] }, "R1"],
    ["test only", { paths: ["src/example.test.ts"] }, "R1"],
    ["ordinary source", { paths: ["src/feature.ts"] }, "R2"],
    ["auth path", { paths: ["src/auth/session.ts"] }, "R3"],
    ["login path", { paths: ["src/login.ts"] }, "R3"],
    ["OAuth path", { paths: ["src/oauth/callback.ts"] }, "R3"],
    ["billing path", { paths: ["src/payments/charge.ts"] }, "R3"],
    ["migration path", { paths: ["migrations/001-add-user.sql"] }, "R3"],
    [".env variant", { paths: [".env.production"] }, "R3"],
    ["certificate file", { paths: ["config/server.pem"] }, "R3"],
    ["workflow", { paths: [".github/workflows/release.yml"] }, "R3"],
    ["composite action", { paths: [".github/actions/release/action.yml"] }, "R3"],
    ["repo policy", { paths: [".osstack/repo.yaml"] }, "R3"],
    ["policy profile", { paths: [".osstack/policy.yml"] }, "R3"],
    ["major dependency", { paths: ["package.json"], majorDependency: true }, "R3"],
    [
      "verification script change",
      {
        paths: ["package.json"],
        diff:
          "diff --git a/package.json b/package.json\n" +
          "--- a/package.json\n" +
          "+++ b/package.json\n" +
          "+    \"test\": \"true\"\n",
        commands: ["pnpm test"],
      },
      "R3",
    ],
    [
      "force push",
      { paths: ["scripts/release.sh"], commands: ["git push --force origin main"] },
      "R3",
    ],
    ["production config", { paths: ["infra/production/service.yaml"] }, "R3"],
    [
      "SQL DDL",
      {
        paths: ["src/storage/query.ts"],
        diff: "+await db.exec(\"ALTER TABLE users ADD COLUMN name TEXT\")\n",
      },
      "R3",
    ],
    [
      "privilege escalation",
      {
        paths: ["scripts/install.sh"],
        diff: "+sudo launchctl bootstrap system service.plist\n",
      },
      "R3",
    ],
    [
      "new network destination",
      {
        paths: ["src/client.ts"],
        diff: "+const endpoint = \"https://new.example.invalid/v1\";\n",
      },
      "R3",
    ],
    [
      "ambiguous destructive intent",
      {
        paths: ["scripts/cache.sh"],
        commands: ["delete all stale cache entries"],
      },
      "R3",
    ],
    [
      "delete production data",
      {
        paths: ["scripts/cleanup.sql"],
        diff: "+DROP TABLE production_users;\n",
      },
      "R4",
    ],
    [
      "approval bypass",
      {
        paths: ["src/config.ts"],
        diff: "+disableApprovalChecks = true;\n",
      },
      "R4",
    ],
    [
      "credential exfiltration",
      {
        paths: ["src/debug.ts"],
        diff: "+sendToRemote(process.env.GITHUB_TOKEN);\n",
      },
      "R4",
    ],
    [
      "recursive root deletion",
      {
        paths: ["scripts/cleanup.sh"],
        commands: ["rm -rf /"],
      },
      "R4",
    ],
  ])("%s", (_name, input, expected) => {
    expect(classifyPost(input).level).toBe(expected);
  });

  it("classifies a newly staged auth file as R3 and binds staged material", () => {
    const result = classifyPost({
      paths: ["src/auth/new-session.ts"],
      diff:
        "diff --git a/src/auth/new-session.ts b/src/auth/new-session.ts\n" +
        "new file mode 100644\n" +
        "--- /dev/null\n" +
        "+++ b/src/auth/new-session.ts\n" +
        "+export const session = true;\n",
    });

    expect(result.level).toBe("R3");
    expect(result.input_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "risk.auth",
          path: "src/auth/new-session.ts",
        }),
      ]),
    );
  });

  it("rejects changed_paths that omit an auth file present in staged porcelain", () => {
    const input = postDiff({ paths: ["docs/readme.md"] });
    expect(() =>
      classifyPostDiffRisk(
        {
          ...input,
          status_porcelain_v1_z: "A  src/auth/hidden.ts\0",
        },
        {
          policy_sha256: POLICY_SHA,
          now: () => NOW,
          repo_id: "gilosbornhello/example",
          protected_policy_paths: [],
        },
      ),
    ).toThrow(/changed_paths.*porcelain/i);
  });

  it("protects base-policy scripts and osstack autonomy trust-kernel sources", () => {
    expect(
      classifyPost(
        { paths: ["scripts/rollback.sh"] },
        { protected_policy_paths: ["scripts/rollback.sh"] },
      ).level,
    ).toBe("R3");
    expect(
      classifyPost(
        { paths: ["scripts/rollback.sh"] },
        { protected_policy_paths: ["./scripts/rollback.sh"] },
      ).level,
    ).toBe("R3");
    expect(
      classifyPost(
        { paths: ["packages/autonomy/src/state-machine.ts"] },
        { repo_id: "gilosbornhello/osstack" },
      ).level,
    ).toBe("R3");
    expect(
      classifyPost(
        { paths: ["packages/autonomy/src/git-candidate.ts"] },
        { repo_id: "gilosbornhello/osstack" },
      ).level,
    ).toBe("R3");
    expect(
      classifyPost(
        { paths: ["packages/github/src/delivery.ts"] },
        { repo_id: "gilosbornhello/osstack" },
      ).level,
    ).toBe("R3");
  });

  it.each(["rm -fr /", "rm -r -f /", "rm --recursive --force /"])(
    "treats recursive root deletion variant %s as R4",
    (command) => {
      expect(
        classifyPost({
          paths: ["scripts/cleanup.sh"],
          commands: [command],
        }).level,
      ).toBe("R4");
    },
  );

  it("ignores removed dangerous text and is stable for identical inputs", () => {
    const input = {
      paths: ["docs/security.md"],
      diff:
        "diff --git a/docs/security.md b/docs/security.md\n" +
        "--- a/docs/security.md\n" +
        "+++ b/docs/security.md\n" +
        "-Never run rm -rf /\n" +
        "+Removed an unsafe example.\n",
    };
    const first = classifyPost(input);
    const second = classifyPost(input);

    expect(first.level).toBe("R1");
    expect(first).toEqual(second);
    expect(first.decided_at).toBe(NOW);
  });

  it("returns the strict maximum across preflight and post-diff", () => {
    expect(maxRisk("R1", "R3")).toBe("R3");
    expect(maxRisk("R4", "R2")).toBe("R4");
    expect(maxRisk("R2", "R2")).toBe("R2");
  });
});

it.each(["packages/cli/src/delivery-contract-host.ts", "packages/cli/src/deliver-command.ts", "packages/core/src/delivery-contract.ts",
  "packages/protocol/src/delivery-contract.ts", "packages/loop/src/loop-engine.ts", "packages/cli/src/execution-context.ts", "packages/knowledge/src/context-budget.ts"])("protects V2 authority source %s", path => {
  expect(classifyPost({ paths: [path] }, { repo_id: "gilosbornhello/osstack" }).level).toBe("R3");
});
