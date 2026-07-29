import type { DeployTargetPolicy } from "@osstack/core";
import { describe, expect, it } from "vitest";
import {
  deriveChangeTypes,
  evaluateDeployEligibility,
  type DeployEligibilityInput,
} from "./deploy-policy.js";

const PROOF_SHA = "a".repeat(64);
const SCRIPT_SHA = "b".repeat(64);
const NOW = new Date("2026-07-27T12:00:00.000Z");

function policy(
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
    allowed_base_branches: ["main"],
    freeze_windows: [],
    ...patch,
  };
}

function input(
  patch: Partial<DeployEligibilityInput> = {},
): DeployEligibilityInput {
  return {
    target: "staging",
    base_branch: "main",
    changed_paths: ["src/feature.ts"],
    diff_stats: {
      additions: 10,
      deletions: 2,
      files_changed: 1,
    },
    final_risk: "R2",
    deterministic_pass: true,
    kimi_pass: true,
    governance_pass: true,
    ci_pass: true,
    candidate_proof_sha256: PROOF_SHA,
    deploy_script_digest_sha256: SCRIPT_SHA,
    production_frozen: false,
    now: NOW,
    ...patch,
  };
}

describe("deterministic deployment change types", () => {
  it("derives only closed change types and reports every unknown path", () => {
    expect(
      deriveChangeTypes(
        [
          "README.md",
          "packages/app/src/index.ts",
          "packages/app/src/index.test.ts",
          "pnpm-lock.yaml",
          ".github/workflows/ci.yml",
          "migrations/001-add-table.sql",
          "assets/logo.png",
        ],
        { additions: 20, deletions: 5, files_changed: 7 },
      ),
    ).toEqual({
      change_types: [
        "ci",
        "database_migrations",
        "dependencies",
        "docs",
        "source",
        "tests",
      ],
      unknown_paths: ["assets/logo.png"],
    });
  });

  it("does not treat similarly prefixed paths as source or tests", () => {
    expect(
      deriveChangeTypes(["src-old/feature.ts", "contest/example.ts"], {
        additions: 2,
        deletions: 0,
        files_changed: 2,
      }),
    ).toEqual({
      change_types: [],
      unknown_paths: ["contest/example.ts", "src-old/feature.ts"],
    });
  });
});

describe("deployment eligibility", () => {
  it("allows an allowlisted R1/R2 staging change", () => {
    expect(evaluateDeployEligibility(policy(), input())).toEqual({
      allowed: true,
      reasons: [],
      requires_approval: false,
      change_types: ["source"],
      unknown_paths: [],
    });
    expect(
      evaluateDeployEligibility(
        policy(),
        input({
          final_risk: "R1",
          changed_paths: ["docs/runbook.md"],
        }),
      ).allowed,
    ).toBe(true);
  });

  it("returns every closed-policy and evidence failure", () => {
    const decision = evaluateDeployEligibility(
      policy({
        enabled: false,
        allowed_change_types: ["docs"],
      }),
      input({
        base_branch: "release",
        changed_paths: ["src/feature.ts", "assets/logo.png"],
        diff_stats: {
          additions: 10,
          deletions: 2,
          files_changed: 2,
        },
        deterministic_pass: false,
        kimi_pass: false,
        governance_pass: false,
        ci_pass: false,
        candidate_proof_sha256: "not-a-digest",
        deploy_script_digest_sha256: "not-a-digest",
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "target_disabled",
        "base_branch_not_allowed:release",
        "path_not_allowed:assets/logo.png",
        "change_type_not_allowed:source",
        "unknown_change_type:assets/logo.png",
        "deterministic_verification_failed",
        "kimi_verification_failed",
        "governance_verification_failed",
        "ci_verification_failed",
        "candidate_proof_digest_invalid",
        "deploy_script_digest_invalid",
      ]),
    );
  });

  it("escalates forbidden paths and R3, and permanently denies R4", () => {
    const forbidden = evaluateDeployEligibility(
      policy(),
      input({ changed_paths: ["src/secrets/key.ts"] }),
    );
    expect(forbidden).toMatchObject({
      allowed: false,
      requires_approval: true,
    });
    expect(forbidden.reasons).toContain(
      "forbidden_path:src/secrets/key.ts",
    );

    const r3 = evaluateDeployEligibility(
      policy(),
      input({ final_risk: "R3" }),
    );
    expect(r3.reasons).toContain("risk_r3_requires_approval");
    expect(r3.requires_approval).toBe(true);

    const r4 = evaluateDeployEligibility(
      policy(),
      input({ final_risk: "R4" }),
    );
    expect(r4.reasons).toContain("risk_r4_forbidden");
    expect(r4.requires_approval).toBe(false);
  });

  it("fails closed on inconsistent diff evidence and an invalid clock", () => {
    const decision = evaluateDeployEligibility(
      policy(),
      input({
        target: "production",
        diff_stats: {
          additions: 10,
          deletions: 2,
          files_changed: 2,
        },
        now: new Date(Number.NaN),
      }),
    );
    expect(decision.reasons).toContain("diff_stats_invalid");
    expect(decision.reasons).toContain("evaluation_clock_invalid");
    expect(decision.allowed).toBe(false);
  });

  it("requires a recent successful production rollback drill with matching scripts", () => {
    const missing = evaluateDeployEligibility(
      policy(),
      input({ target: "production" }),
    );
    expect(missing.reasons).toContain("rollback_drill_missing");

    const stale = evaluateDeployEligibility(
      policy(),
      input({
        target: "production",
        rollback_drill: {
          passed_at: "2026-06-20T12:00:00.000Z",
          deploy_script_digest_sha256: SCRIPT_SHA,
          post_rollback_health_passed: true,
        },
      }),
    );
    expect(stale.reasons).toContain("rollback_drill_stale");

    const mismatch = evaluateDeployEligibility(
      policy(),
      input({
        target: "production",
        rollback_drill: {
          passed_at: "2026-07-20T12:00:00.000Z",
          deploy_script_digest_sha256: "c".repeat(64),
          post_rollback_health_passed: true,
        },
      }),
    );
    expect(mismatch.reasons).toContain("rollback_drill_digest_mismatch");

    const healthy = evaluateDeployEligibility(
      policy(),
      input({
        target: "production",
        rollback_drill: {
          passed_at: "2026-07-20T12:00:00.000Z",
          deploy_script_digest_sha256: SCRIPT_SHA,
          post_rollback_health_passed: true,
        },
      }),
    );
    expect(healthy.allowed).toBe(true);
  });

  it("honors production freezes and cross-midnight IANA windows", () => {
    const rollbackDrill = {
      passed_at: "2026-07-20T12:00:00.000Z",
      deploy_script_digest_sha256: SCRIPT_SHA,
      post_rollback_health_passed: true,
    };
    const frozen = evaluateDeployEligibility(
      policy(),
      input({
        target: "production",
        rollback_drill: rollbackDrill,
        production_frozen: true,
      }),
    );
    expect(frozen.reasons).toContain("production_frozen");

    const crossMidnight = policy({
      freeze_windows: [
        {
          timezone: "UTC",
          days: [1],
          start: "23:00",
          end: "02:00",
        },
      ],
    });
    const mondayNight = evaluateDeployEligibility(
      crossMidnight,
      input({
        target: "production",
        rollback_drill: rollbackDrill,
        now: new Date("2026-07-27T23:30:00.000Z"),
      }),
    );
    expect(mondayNight.reasons).toContain("production_freeze_window_active");

    const tuesdayCarry = evaluateDeployEligibility(
      crossMidnight,
      input({
        target: "production",
        rollback_drill: rollbackDrill,
        now: new Date("2026-07-28T01:30:00.000Z"),
      }),
    );
    expect(tuesdayCarry.reasons).toContain("production_freeze_window_active");

    const staging = evaluateDeployEligibility(
      crossMidnight,
      input({
        target: "staging",
        production_frozen: true,
        now: new Date("2026-07-27T23:30:00.000Z"),
      }),
    );
    expect(staging.allowed).toBe(true);
  });
});
