import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deliverToGitHub,
  githubDeliveryEnvironment,
  type DeliveryCommandResult,
  type DeliveryCommandRunner,
  type GitHubDeliveryInput,
} from "./delivery.js";

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

interface RecordedCall {
  command: string;
  args: readonly string[];
  options: { cwd: string; timeoutMs: number };
}

type Override = (
  call: RecordedCall,
  runner: ScenarioRunner,
) => DeliveryCommandResult | undefined;

function result(
  stdout = "",
  exitCode = 0,
  stderr = "",
): DeliveryCommandResult {
  return { stdout, stderr, exitCode };
}

class ScenarioRunner implements DeliveryCommandRunner {
  readonly calls: RecordedCall[] = [];
  prExists = false;

  constructor(private readonly override?: Override) {}

  async run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<DeliveryCommandResult> {
    const call = { command, args: [...args], options };
    this.calls.push(call);
    const overridden = this.override?.(call, this);
    if (overridden !== undefined) return overridden;
    return this.defaultResult(call);
  }

  private defaultResult(call: RecordedCall): DeliveryCommandResult {
    const [first, second, third] = call.args;
    if (call.command === "gh" && first === "auth" && second === "status") {
      return result("Logged in");
    }
    if (
      call.command === "git" &&
      first === "check-ref-format" &&
      second === "--branch"
    ) {
      return result("osstack/task-123");
    }
    if (
      call.command === "git" &&
      first === "branch" &&
      second === "--show-current"
    ) {
      return result("osstack/task-123\n");
    }
    if (
      call.command === "git" &&
      first === "status" &&
      second === "--porcelain=v1" &&
      third === "-z"
    ) {
      return result("");
    }
    if (
      call.command === "git" &&
      first === "remote" &&
      second === "get-url"
    ) {
      return result("git@github.com:gilosbornhello/osstack.git\n");
    }
    if (
      call.command === "git" &&
      first === "rev-parse" &&
      second === "HEAD"
    ) {
      return result(`${HEAD_SHA}\n`);
    }
    if (call.command === "git" && first === "push") {
      return result("pushed");
    }
    if (
      call.command === "gh" &&
      first === "repo" &&
      second === "view"
    ) {
      return result(JSON.stringify({ nameWithOwner: "gilosbornhello/osstack" }));
    }
    if (
      call.command === "gh" &&
      first === "pr" &&
      second === "view" &&
      third === "osstack/task-123"
    ) {
      return this.prExists
        ? result(
            JSON.stringify({
              number: 42,
              url: "https://github.com/gilosbornhello/osstack/pull/42",
              headRefOid: HEAD_SHA,
              state: "OPEN",
            }),
          )
        : result("", 1, "no pull requests found");
    }
    if (
      call.command === "gh" &&
      first === "pr" &&
      second === "create"
    ) {
      this.prExists = true;
      return result("https://github.com/gilosbornhello/osstack/pull/42\n");
    }
    if (
      call.command === "gh" &&
      first === "pr" &&
      second === "checks"
    ) {
      return result("ci pass");
    }
    if (
      call.command === "gh" &&
      first === "api" &&
      call.args.some((arg) =>
        arg.includes("/branches/osstack%2Ftask-123/protection"),
      )
    ) {
      return result("", 1, "HTTP 404: Branch not protected");
    }
    if (
      call.command === "gh" &&
      first === "api" &&
      call.args.some((arg) =>
        arg.includes("/rules/branches/osstack%2Ftask-123"),
      )
    ) {
      return result("[]");
    }
    if (
      call.command === "gh" &&
      first === "api" &&
      call.args.some((arg) => arg.includes("/branches/main/protection"))
    ) {
      return result(
        JSON.stringify({
          required_status_checks: {
            contexts: ["ci"],
            checks: [],
          },
          required_pull_request_reviews: {},
        }),
      );
    }
    if (
      call.command === "gh" &&
      first === "api" &&
      call.args.some((arg) => arg.includes("/rules/branches/main"))
    ) {
      return result("[]");
    }
    if (
      call.command === "gh" &&
      first === "pr" &&
      second === "view" &&
      third === "42" &&
      call.args.includes(
        "number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup",
      )
    ) {
      return result(
        JSON.stringify({
          number: 42,
          url: "https://github.com/gilosbornhello/osstack/pull/42",
          headRefOid: HEAD_SHA,
          state: "OPEN",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            {
              name: "ci",
              status: "COMPLETED",
              conclusion: "SUCCESS",
            },
          ],
        }),
      );
    }
    if (
      call.command === "gh" &&
      first === "pr" &&
      second === "merge"
    ) {
      return result("merged");
    }
    if (
      call.command === "gh" &&
      first === "pr" &&
      second === "view" &&
      third === "42" &&
      call.args.includes("state,mergedAt,mergeCommit,url,headRefOid")
    ) {
      return result(
        JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-07-28T22:30:00Z",
          mergeCommit: { oid: OTHER_SHA },
          url: "https://github.com/gilosbornhello/osstack/pull/42",
          headRefOid: HEAD_SHA,
        }),
      );
    }
    throw new Error(
      `Unexpected command: ${call.command} ${call.args.join(" ")}`,
    );
  }
}

let directory: string;
let bodyFile: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-github-delivery-"));
  bodyFile = join(directory, "osstack-pr-body-task-123.md");
  writeFileSync(bodyFile, "# Candidate proof\n");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function input(
  overrides: Partial<GitHubDeliveryInput> = {},
): GitHubDeliveryInput {
  return {
    workspacePath: directory,
    remote: "origin",
    base: "main",
    branch: "osstack/task-123",
    title: "feat: complete task-123",
    bodyFile,
    mergeStrategy: "squash",
    ciTimeoutMs: 5_000,
    ...overrides,
  };
}

function commandStrings(runner: ScenarioRunner): string[] {
  return runner.calls.map(
    (call) => `${call.command} ${call.args.join(" ")}`,
  );
}

describe("guarded GitHub delivery", () => {
  it("pushes, creates, checks, protects, and SHA-binds a squash merge", async () => {
    const runner = new ScenarioRunner();
    await expect(deliverToGitHub(input(), runner)).resolves.toMatchObject({
      pushedCommit: HEAD_SHA,
      pr: {
        number: 42,
        url: "https://github.com/gilosbornhello/osstack/pull/42",
        reused: false,
      },
      mergeCommit: OTHER_SHA,
    });

    const commands = commandStrings(runner);
    expect(commands).toContain(
      "git push --set-upstream origin osstack/task-123",
    );
    expect(commands).toContain(
      `gh pr create --base main --head osstack/task-123 --title feat: complete task-123 --body-file ${bodyFile}`,
    );
    expect(commands).toContain(
      "gh pr view osstack/task-123 --json number,url,headRefOid,state",
    );
    expect(commands).toContain("gh pr checks 42 --watch --fail-fast");
    expect(commands).toContain(
      "gh pr view 42 --json number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup",
    );
    expect(commands).toContain(
      `gh pr merge 42 --squash --delete-branch --match-head-commit ${HEAD_SHA}`,
    );
    expect(runner.calls.flatMap((call) => call.args)).not.toContain("--admin");
    expect(
      runner.calls.flatMap((call) => call.args).some((arg) =>
        /force/i.test(arg),
      ),
    ).toBe(false);
  });

  it("reuses an existing open PR only when it resolves to the pushed head", async () => {
    const runner = new ScenarioRunner();
    runner.prExists = true;
    const delivered = await deliverToGitHub(input(), runner);
    expect(delivered.pr.reused).toBe(true);
    expect(commandStrings(runner).some((command) =>
      command.startsWith("gh pr create "),
    )).toBe(false);
  });

  it("recovers an already merged exact-head PR without repeating GitHub writes", async () => {
    const runner = new ScenarioRunner((call) => {
      const [first, second, third] = call.args;
      if (
        call.command === "gh"
        && first === "pr"
        && second === "view"
        && third === "osstack/task-123"
      ) {
        return result(JSON.stringify({
          number: 42,
          url: "https://github.com/gilosbornhello/osstack/pull/42",
          headRefOid: HEAD_SHA,
          state: "MERGED",
        }));
      }
      if (
        call.command === "gh"
        && first === "pr"
        && second === "view"
        && third === "42"
        && call.args.includes(
          "number,state,mergedAt,mergeCommit,url,headRefOid,baseRefName,headRefName,statusCheckRollup",
        )
      ) {
        return result(JSON.stringify({
          number: 42,
          state: "MERGED",
          mergedAt: "2026-07-28T22:30:00Z",
          mergeCommit: { oid: OTHER_SHA },
          url: "https://github.com/gilosbornhello/osstack/pull/42",
          headRefOid: HEAD_SHA,
          baseRefName: "main",
          headRefName: "osstack/task-123",
          statusCheckRollup: [{
            name: "ci",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          }],
        }));
      }
      return undefined;
    });

    await expect(deliverToGitHub(input(), runner)).resolves.toMatchObject({
      pushedCommit: HEAD_SHA,
      pr: {
        number: 42,
        url: "https://github.com/gilosbornhello/osstack/pull/42",
        reused: true,
      },
      mergeCommit: OTHER_SHA,
    });
    const commands = commandStrings(runner);
    expect(commands.some((command) => command.startsWith("git push "))).toBe(false);
    expect(commands.some((command) => command.startsWith("gh pr create "))).toBe(false);
    expect(commands.some((command) => command.startsWith("gh pr merge "))).toBe(false);
  });

  it("retries bounded PR resolution after a creation acknowledgement", async () => {
    const runner = new ScenarioRunner((call, scenario) => {
      if (
        scenario.prExists &&
        call.command === "gh" &&
        call.args[1] === "view" &&
        call.args[2] === "osstack/task-123"
      ) {
        const viewCount = scenario.calls.filter(
          (candidate) =>
            candidate.command === "gh" &&
            candidate.args[1] === "view" &&
            candidate.args[2] === "osstack/task-123",
        ).length;
        if (viewCount === 2) {
          return result("", 1, "no pull requests found");
        }
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), runner)).resolves.toBeDefined();
    expect(
      runner.calls.filter(
        (call) =>
          call.command === "gh" &&
          call.args[1] === "view" &&
          call.args[2] === "osstack/task-123",
      ),
    ).toHaveLength(3);
  });

  it("accepts effective ruleset-only protection", async () => {
    const runner = new ScenarioRunner((call) => {
      if (
        call.command === "gh" &&
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/branches/main/protection"))
      ) {
        return result("", 1, "HTTP 404: Branch not protected");
      }
      if (
        call.command === "gh" &&
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/rules/branches/main"))
      ) {
        return result(
          JSON.stringify([
            {
              type: "pull_request",
              ruleset_source_type: "Repository",
            },
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "ci" }],
              },
            },
          ]),
        );
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), runner)).resolves.toBeDefined();
  });

  it.each([
    [
      "missing GitHub auth",
      (call: RecordedCall) =>
        call.command === "gh" && call.args[0] === "auth"
          ? result("", 1, "not logged in")
          : undefined,
      /auth/i,
    ],
    [
      "missing remote",
      (call: RecordedCall) =>
        call.command === "git" && call.args[0] === "remote"
          ? result("", 2, "No such remote")
          : undefined,
      /remote/i,
    ],
    [
      "push rejection",
      (call: RecordedCall) =>
        call.command === "git" && call.args[0] === "push"
          ? result("", 1, "rejected")
          : undefined,
      /push/i,
    ],
    [
      "CI failure",
      (call: RecordedCall) =>
        call.command === "gh" && call.args[1] === "checks"
          ? result("", 1, "check failed")
          : undefined,
      /CI/i,
    ],
    [
      "CI timeout",
      (call: RecordedCall) =>
        call.command === "gh" && call.args[1] === "checks"
          ? result("", 124, "timed out")
          : undefined,
      /timeout/i,
    ],
    [
      "dirty worktree",
      (call: RecordedCall) =>
        call.command === "git" && call.args[0] === "status"
          ? result(" M src/file.ts\0")
          : undefined,
      /clean|dirty/i,
    ],
    [
      "wrong branch",
      (call: RecordedCall) =>
        call.command === "git" && call.args[0] === "branch"
          ? result("other/task")
          : undefined,
      /branch/i,
    ],
  ] as const)(
    "fails closed on %s",
    async (_name, override, message) => {
      await expect(
        deliverToGitHub(input(), new ScenarioRunner(override)),
      ).rejects.toThrow(message);
    },
  );

  it("fails closed on malformed PR creation acknowledgement or PR metadata", async () => {
    const malformedUrl = new ScenarioRunner((call, scenario) => {
      if (call.command === "gh" && call.args[1] === "create") {
        scenario.prExists = true;
        return result("not-a-github-url");
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), malformedUrl)).rejects.toThrow(/URL/i);

    const malformedJson = new ScenarioRunner((call, scenario) => {
      if (
        scenario.prExists &&
        call.command === "gh" &&
        call.args[1] === "view" &&
        call.args[2] === "osstack/task-123"
      ) {
        return result("{bad json");
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), malformedJson)).rejects.toThrow(/JSON|metadata/i);
  });

  it("fails closed on no protection, unauthorized lookup, or zero required checks", async () => {
    const noProtection = new ScenarioRunner((call) => {
      if (
        call.command === "gh" &&
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/branches/main/protection"))
      ) {
        return result("", 1, "HTTP 404: Branch not protected");
      }
      if (
        call.command === "gh" &&
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/rules/branches/main"))
      ) {
        return result("[]");
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), noProtection)).rejects.toThrow(
      /protection/i,
    );

    const unauthorized = new ScenarioRunner((call) => {
      if (
        call.command === "gh" &&
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/rules/branches/main"))
      ) {
        return result("", 1, "HTTP 403: Resource not accessible");
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), unauthorized)).rejects.toThrow(
      /rules|protection|authorized/i,
    );

    const zeroChecks = new ScenarioRunner((call) => {
      if (
        call.command === "gh" &&
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/branches/main/protection"))
      ) {
        return result(JSON.stringify({ required_pull_request_reviews: {} }));
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), zeroChecks)).rejects.toThrow(
      /required check/i,
    );
  });

  it("rejects stale or changed PR heads and merge conflicts", async () => {
    const staleHead = new ScenarioRunner((call, scenario) => {
      if (
        scenario.prExists &&
        call.command === "gh" &&
        call.args[1] === "view" &&
        call.args[2] === "osstack/task-123"
      ) {
        return result(
          JSON.stringify({
            number: 42,
            url: "https://github.com/gilosbornhello/osstack/pull/42",
            headRefOid: OTHER_SHA,
            state: "OPEN",
          }),
        );
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), staleHead)).rejects.toThrow(/head|SHA/i);

    const changedHead = new ScenarioRunner((call) => {
      if (
        call.command === "gh" &&
        call.args[1] === "view" &&
        call.args[2] === "42" &&
        call.args.includes(
          "number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup",
        )
      ) {
        return result(
          JSON.stringify({
            number: 42,
            url: "https://github.com/gilosbornhello/osstack/pull/42",
            headRefOid: OTHER_SHA,
            state: "OPEN",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            statusCheckRollup: [
              {
                name: "ci",
                status: "COMPLETED",
                conclusion: "SUCCESS",
              },
            ],
          }),
        );
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), changedHead)).rejects.toThrow(
      /head|SHA/i,
    );

    const conflict = new ScenarioRunner((call) => {
      if (
        call.command === "gh" &&
        call.args[1] === "view" &&
        call.args[2] === "42" &&
        call.args.includes(
          "number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup",
        )
      ) {
        return result(
          JSON.stringify({
            number: 42,
            url: "https://github.com/gilosbornhello/osstack/pull/42",
            headRefOid: HEAD_SHA,
            state: "OPEN",
            mergeable: "CONFLICTING",
            mergeStateStatus: "DIRTY",
            statusCheckRollup: [
              {
                name: "ci",
                status: "COMPLETED",
                conclusion: "SUCCESS",
              },
            ],
          }),
        );
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), conflict)).rejects.toThrow(
      /merge|conflict/i,
    );
  });

  it("rejects protected/injected branches and a missing proof body before push", async () => {
    const protectedRunner = new ScenarioRunner((call) => {
      if (call.command === "git" && call.args[0] === "branch") {
        return result("main");
      }
      return undefined;
    });
    await expect(
      deliverToGitHub(input({ branch: "main" }), protectedRunner),
    ).rejects.toThrow(/protected|base/i);
    expect(commandStrings(protectedRunner).some((command) =>
      command.startsWith("git push "),
    )).toBe(false);

    const rulesetProtected = new ScenarioRunner((call) => {
      if (
        call.command === "gh" &&
        call.args[0] === "api" &&
        call.args.some((arg) =>
          arg.includes("/rules/branches/osstack%2Ftask-123"),
        )
      ) {
        return result(JSON.stringify([{ type: "pull_request" }]));
      }
      return undefined;
    });
    await expect(
      deliverToGitHub(input(), rulesetProtected),
    ).rejects.toThrow(/protected candidate/i);
    expect(commandStrings(rulesetProtected).some((command) =>
      command.startsWith("git push "),
    )).toBe(false);

    const injected = new ScenarioRunner();
    await expect(
      deliverToGitHub(input({ branch: "--force" }), injected),
    ).rejects.toThrow(/branch|unsafe/i);
    expect(commandStrings(injected).some((command) =>
      command.startsWith("git push "),
    )).toBe(false);

    await expect(
      deliverToGitHub(
        input({ bodyFile: join(directory, "missing.md") }),
        new ScenarioRunner(),
      ),
    ).rejects.toThrow(/body|proof|file/i);
  });

  it("builds a minimal child environment without approval or notification secrets", () => {
    const environment = githubDeliveryEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GH_TOKEN: "github-delivery-token",
      APPROVAL_PRIVATE_KEY: "must-not-leak",
      TELEGRAM_BOT_TOKEN: "must-not-leak",
      SLACK_WEBHOOK_URL: "must-not-leak",
      NODE_OPTIONS: "--require attacker.js",
    });
    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GH_TOKEN: "github-delivery-token",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    });
    expect(environment).not.toHaveProperty("APPROVAL_PRIVATE_KEY");
    expect(environment).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(environment).not.toHaveProperty("SLACK_WEBHOOK_URL");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
  });

  it("uses the configured CI timeout and retries push only within a bound", async () => {
    const runner = new ScenarioRunner((call) => {
      if (call.command === "git" && call.args[0] === "push") {
        return result("", 1, "rejected");
      }
      return undefined;
    });
    await expect(deliverToGitHub(input(), runner)).rejects.toThrow(/push/i);
    expect(
      runner.calls.filter(
        (call) => call.command === "git" && call.args[0] === "push",
      ),
    ).toHaveLength(3);

    const success = new ScenarioRunner();
    await deliverToGitHub(input({ ciTimeoutMs: 12_345 }), success);
    expect(
      success.calls.find(
        (call) => call.command === "gh" && call.args[1] === "checks",
      )?.options.timeoutMs,
    ).toBe(12_345);
  });
});
