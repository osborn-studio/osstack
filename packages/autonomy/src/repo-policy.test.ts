import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AutonomyRepoPolicy,
  DeployRepoPolicy,
  DeployTargetPolicy,
} from "@osstack/core";
import {
  intersectPolicyPaths,
  loadPrivateRepoOverlay,
  mergeRepoPolicy,
  parsePrivateRepoOverlay,
} from "./repo-policy.js";

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

function target(
  patch: Partial<DeployTargetPolicy> = {},
): DeployTargetPolicy {
  return {
    enabled: true,
    command: ["scripts/deploy.sh"],
    verify_command: ["scripts/verify.sh"],
    health_check: ["scripts/health.sh"],
    rollback: ["scripts/rollback.sh"],
    timeout_ms: 60_000,
    health_timeout_ms: 30_000,
    allowed_change_types: ["docs", "source"],
    allowed_paths: ["docs/**", "src/**"],
    forbidden_paths: ["src/secrets/**"],
    allowed_base_branches: ["main", "release"],
    allowed_environment: ["DEPLOY_REGION", "DEPLOY_TOKEN"],
    freeze_windows: [
      {
        timezone: "America/Los_Angeles",
        days: [0],
        start: "01:00",
        end: "02:00",
      },
    ],
    ...patch,
  };
}

function repositoryPolicy(): {
  autonomy: AutonomyRepoPolicy;
  deploy: DeployRepoPolicy;
} {
  return {
    autonomy: {
      max_auto_risk: "R2",
      require_independent_evaluator: false,
      max_builder_iterations: 5,
      max_review_rounds: 4,
      max_wall_time_minutes: 120,
      max_no_progress_rounds: 3,
    },
    deploy: {
      staging: target(),
      production: target({
        command: ["scripts/deploy-production.sh"],
      }),
    },
  };
}

describe("private repository deployment policy", () => {
  it("keeps an omitted target effective and cannot replace repository commands", () => {
    const repository = repositoryPolicy();
    const overlay = parsePrivateRepoOverlay({
      schema_version: 1,
      deploy: {
        production: {
          enabled: false,
        },
      },
    });

    const effective = mergeRepoPolicy(repository, overlay);

    expect(effective.deploy?.staging).toEqual(repository.deploy.staging);
    expect(effective.deploy?.production).toMatchObject({
      enabled: false,
      command: ["scripts/deploy-production.sh"],
      verify_command: ["scripts/verify.sh"],
      health_check: ["scripts/health.sh"],
      rollback: ["scripts/rollback.sh"],
    });

    expect(() =>
      parsePrivateRepoOverlay({
        schema_version: 1,
        deploy: {
          staging: {
            command: ["scripts/private-deploy.sh"],
          },
        },
      }),
    ).toThrow(/command|unrecognized/i);
  });

  it("merges every authority field to the stricter result", () => {
    const repository = repositoryPolicy();
    const overlay = parsePrivateRepoOverlay({
      schema_version: 1,
      autonomy: {
        max_auto_risk: "R1",
        require_independent_evaluator: true,
        max_builder_iterations: 3,
        max_review_rounds: 6,
        max_wall_time_minutes: 90,
        max_no_progress_rounds: 2,
      },
      deploy: {
        staging: {
          enabled: true,
          timeout_ms: 90_000,
          health_timeout_ms: 10_000,
          allowed_change_types: ["source"],
          allowed_paths: ["src/features/**", "other/**"],
          forbidden_paths: ["src/private/**"],
          allowed_base_branches: ["main"],
          allowed_environment: ["DEPLOY_TOKEN"],
          freeze_windows: [
            {
              timezone: "UTC",
              days: [1],
              start: "23:00",
              end: "02:00",
            },
          ],
        },
      },
    });

    const effective = mergeRepoPolicy(repository, overlay);

    expect(effective.autonomy).toEqual({
      max_auto_risk: "R1",
      require_independent_evaluator: true,
      max_builder_iterations: 3,
      max_review_rounds: 4,
      max_wall_time_minutes: 90,
      max_no_progress_rounds: 2,
    });
    expect(effective.deploy?.staging).toMatchObject({
      enabled: true,
      command: ["scripts/deploy.sh"],
      timeout_ms: 60_000,
      health_timeout_ms: 10_000,
      allowed_change_types: ["source"],
      allowed_paths: ["src/features/**"],
      forbidden_paths: ["src/private/**", "src/secrets/**"],
      allowed_base_branches: ["main"],
      allowed_environment: ["DEPLOY_TOKEN"],
    });
    expect(effective.deploy?.staging?.freeze_windows).toHaveLength(2);
  });

  it("uses segment-aware path intersections and disables an empty authority set", () => {
    expect(intersectPolicyPaths(["src/**"], ["src/feature/**"])).toEqual([
      "src/feature/**",
    ]);
    expect(intersectPolicyPaths(["src/**"], ["src2/**"])).toEqual([]);
    expect(intersectPolicyPaths(["app/**"], ["app-old/**"])).toEqual([]);

    const repository = repositoryPolicy();
    const overlay = parsePrivateRepoOverlay({
      schema_version: 1,
      deploy: {
        staging: {
          allowed_paths: ["unrelated/**"],
        },
      },
    });
    const effective = mergeRepoPolicy(repository, overlay);
    expect(effective.deploy?.staging?.enabled).toBe(false);
    expect(effective.deploy?.staging?.allowed_paths).toEqual([]);
  });

  it("loads a strict overlay from the explicit OSSTACK_HOME only", async () => {
    const home = await mkdtemp(join(tmpdir(), "osstack-private-policy-"));
    temporaryHomes.push(home);
    await mkdir(join(home, "repos"), { recursive: true });
    await writeFile(
      join(home, "repos", "example-web.yaml"),
      [
        "schema_version: 1",
        "autonomy:",
        "  max_auto_risk: R1",
        "deploy:",
        "  production:",
        "    enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadPrivateRepoOverlay(home, "example-web")).resolves.toMatchObject({
      schema_version: 1,
      autonomy: { max_auto_risk: "R1" },
    });
    await expect(loadPrivateRepoOverlay(home, "missing")).resolves.toBeUndefined();
    await expect(loadPrivateRepoOverlay(home, "../escape")).rejects.toThrow(
      /repo id/i,
    );
  });

  it("rejects credentials, private commands, unknown keys, and widening targets", () => {
    expect(() =>
      parsePrivateRepoOverlay({
        schema_version: 1,
        deploy: {
          staging: {
            forbidden_paths: ["TOKEN=not-a-real-token"],
          },
        },
      }),
    ).toThrow(/credential/i);
    expect(() =>
      parsePrivateRepoOverlay({
        schema_version: 1,
        unexpected: true,
      }),
    ).toThrow(/unrecognized/i);
    expect(() =>
      parsePrivateRepoOverlay({
        schema_version: 1,
        deploy: {
          staging: {
            allowed_paths: ["../outside/**"],
          },
        },
      }),
    ).toThrow(/path/i);
    expect(() =>
      parsePrivateRepoOverlay({
        schema_version: 1,
        deploy: {
          staging: {
            allowed_paths: ["src/*/generated"],
          },
        },
      }),
    ).toThrow(/path/i);
    expect(() =>
      parsePrivateRepoOverlay({
        schema_version: 1,
        deploy: {
          staging: {
            allowed_change_types: ["source", "source"],
          },
        },
      }),
    ).toThrow(/duplicate/i);

    const repository = repositoryPolicy();
    repository.deploy = {};
    const overlay = parsePrivateRepoOverlay({
      schema_version: 1,
      deploy: {
        production: {
          enabled: false,
        },
      },
    });
    expect(() => mergeRepoPolicy(repository, overlay)).toThrow(
      /cannot introduce.*production/i,
    );
  });
});
