import { describe, expect, it } from "vitest";
import { compileMissionGlob } from "./path-rules.js";
import {
  canonicalMissionProtectedRules,
  matchMissionProtectedPath,
  MISSION_PROTECTED_RULES,
  missionProtectedSetDigest,
} from "./protected-set.js";

describe("mission protected set", () => {
  it.each([
    "package.json",
    "packages/core/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "packages/cli/tsconfig.json",
    "packages/loop/vitest.config.ts",
    "packages/cli/tsup.config.ts",
    "biome.json",
    ".github/workflows/ci.yml",
    ".changeset/config.json",
    "scripts/bench-cli-startup.mjs",
    "legacy-python/osstack/__init__.py",
    ".osstack/policy.yaml",
    "packages/core/src/state/migrations.ts",
    "packages/core/src/state/engineering-ddl.ts",
    "packages/core/src/state/db.ts",
    "packages/cli/src/policy-gate.ts",
    "packages/cli/src/guarded-open-db.ts",
    "packages/cli/src/control-plane-guard.ts",
    "packages/cli/src/contained-mission-runner.ts",
    "packages/cli/src/contained-mission-host.ts",
    "packages/cli/src/contained-mission-command.ts",
    "packages/cli/src/contained-patch-apply.ts",
    "packages/governance/src/mission-patch/classify.ts",
    ".codex/config.toml",
    ".claude/settings.json",
    ".cursor/rules",
    ".mcp.json",
    ".vscode/settings.json",
    ".idea/workspace.xml",
    ".gitattributes",
    ".gitmodules",
    "src/.gitignore",
    ".GITHUB/workflows/x.yml",
    ".env.local",
    "deploy/server.pem",
    "deploy/ca.crt",
    "secrets/prod.json",
    "config/credentials/token.json",
    "packages/cli/src/graph-contained-tests.ts",
    "packages/agents/src/contained-command.ts",
    "packages/loop/src/reviewer-isolation.ts",
    "packages/cli/src/contained-verification.ts",
    "packages/agents/src/contained-image.ts",
    "packages/agents/src/contained-workspace/plumbing.ts",
    "packages/agents/src/contained-workspace/safe-write.ts",
    "packages/agents/src/adapters/codex-proxy.ts",
    "packages/core/src/state/engineering-contained-store.ts",
    "packages/cli/src/engineering-upgrade-guard.ts",
    "packages/cli/src/upgrade-native-port.ts",
  ])("protects %s", (path) => {
    expect(matchMissionProtectedPath(path).length).toBeGreaterThan(0);
  });

  it.each([
    "src/app.ts",
    "docs/design/x.md",
    "packages/core/src/state/engineering-store.ts",
    ".changeset/new-feature.md",
    "packages/governance/src/scanner.ts",
    "packages/agents/src/adapters/codex-cli.ts",
    "packages/cli/src/contained-verification-notes.md",
  ])("leaves %s unprotected", (path) => {
    expect(matchMissionProtectedPath(path)).toEqual([]);
  });

  it("has a digest that ignores rule order and duplicates", () => {
    const shuffled = [...MISSION_PROTECTED_RULES].reverse();
    const duplicated = [...MISSION_PROTECTED_RULES, MISSION_PROTECTED_RULES[0]!];
    const digest = missionProtectedSetDigest();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(missionProtectedSetDigest(shuffled)).toBe(digest);
    expect(missionProtectedSetDigest(duplicated)).toBe(digest);
    expect(canonicalMissionProtectedRules(shuffled)).toEqual(canonicalMissionProtectedRules());
    expect(missionProtectedSetDigest(MISSION_PROTECTED_RULES.slice(1))).not.toBe(digest);
    expect(missionProtectedSetDigest([{ id: "x", glob: "a" }, { id: "y", glob: "b" }]))
      .toBe(missionProtectedSetDigest([{ id: "y", glob: "b" }, { id: "x", glob: "a" }]));
  });

  it("compiles globs segment-aware", () => {
    expect(compileMissionGlob("src/**").test("src")).toBe(true);
    expect(compileMissionGlob("src/**").test("src/a/b.ts")).toBe(true);
    expect(compileMissionGlob("src/**").test("srcx/a.ts")).toBe(false);
    expect(compileMissionGlob("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(compileMissionGlob("**/a.ts").test("a.ts")).toBe(true);
    expect(compileMissionGlob("**/a.ts").test("x/y/a.ts")).toBe(true);
    expect(compileMissionGlob("src/a?.ts").test("src/ab.ts")).toBe(true);
    expect(compileMissionGlob("src/a.ts").test("src/aXts")).toBe(false);
  });
});
