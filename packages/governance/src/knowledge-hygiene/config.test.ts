import {
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KnowledgeHygieneConfigError,
  loadKnowledgeHygieneConfig,
  parseKnowledgeHygieneConfigV1,
} from "./config.js";

const goodConfig = `
version: 1
instructions:
  canonical: AGENTS.md
  mirrors:
    - path: CLAUDE.md
      mode: import_or_symlink
required_surfaces:
  - id: readme
    path: README.md
    severity: error
  - id: decisions
    path: docs/decisions
    kind: directory
    severity: warning
budgets:
  - id: agent-context
    path: AGENTS.md
    warn:
      lines: 200
      bytes: 15360
    error:
      bytes: 25600
contracts:
  - id: cli-public-surface
    when:
      any_path:
        - packages/cli/src/**
    review:
      any_path:
        - README.md
        - docs/inventory/CLI_COMMANDS.md
    enforcement: advisory
ignore:
  - rule_id: reference.markdown_target_missing
    paths:
      - docs/generated/**
    reason: generated on release
`;

describe("parseKnowledgeHygieneConfigV1", () => {
  it("parses the accepted config contract and applies only documented defaults", () => {
    expect(parseKnowledgeHygieneConfigV1(goodConfig)).toEqual({
      version: 1,
      instructions: {
        canonical: "AGENTS.md",
        mirrors: [{ path: "CLAUDE.md", mode: "import_or_symlink" }],
      },
      required_surfaces: [
        { id: "readme", path: "README.md", kind: "file", severity: "error" },
        {
          id: "decisions",
          path: "docs/decisions",
          kind: "directory",
          severity: "warning",
        },
      ],
      budgets: [{
        id: "agent-context",
        path: "AGENTS.md",
        warn: { lines: 200, bytes: 15360 },
        error: { bytes: 25600 },
      }],
      contracts: [{
        id: "cli-public-surface",
        when: { any_path: ["packages/cli/src/**"] },
        review: { any_path: ["README.md", "docs/inventory/CLI_COMMANDS.md"] },
        enforcement: "advisory",
      }],
      ignore: [{
        rule_id: "reference.markdown_target_missing",
        paths: ["docs/generated/**"],
        reason: "generated on release",
      }],
    });
  });

  it.each([
    ["unknown version", "version: 2"],
    [
      "duplicate id",
      `version: 1\nrequired_surfaces:\n  - { id: docs, path: README.md }\n  - { id: docs, path: docs }`,
    ],
    [
      "absolute path",
      `version: 1\ninstructions:\n  canonical: /tmp/AGENTS.md`,
    ],
    [
      "parent escape",
      `version: 1\nrequired_surfaces:\n  - { id: outside, path: ../outside.md }`,
    ],
    [
      "non-normalized path",
      `version: 1\nrequired_surfaces:\n  - { id: guide, path: docs//guide.md }`,
    ],
    [
      "broad ignore",
      `version: 1\nignore:\n  - rule_id: scan.incomplete\n    paths: ["**"]\n    reason: hide everything`,
    ],
    [
      "unsupported pattern",
      `version: 1\ncontracts:\n  - id: docs\n    when: { any_path: ["src/[ab].ts"] }\n    review: { any_path: ["README.md"] }`,
    ],
    [
      "invalid budget ordering",
      `version: 1\nbudgets:\n  - id: agents\n    path: AGENTS.md\n    warn: { lines: 200 }\n    error: { lines: 100 }`,
    ],
    [
      "unknown field",
      `version: 1\nsecret_mode: permissive`,
    ],
    [
      "implicit adapter enablement",
      `version: 1\nadapters:\n  claude_code:\n    memory_dir: ~/memory`,
    ],
    [
      "relative external memory path",
      `version: 1\nadapters:\n  claude_code:\n    enabled: true\n    memory_dir: relative/memory`,
    ],
  ])("rejects %s", (_label, source) => {
    expect(() => parseKnowledgeHygieneConfigV1(source)).toThrow(
      KnowledgeHygieneConfigError,
    );
  });

  it("parses explicit Claude Code adapter consent and an exact memory directory", () => {
    expect(parseKnowledgeHygieneConfigV1(`
version: 1
adapters:
  claude_code:
    enabled: true
    memory_dir: ~/claude-memory
`)).toMatchObject({
      adapters: {
        claude_code: {
          enabled: true,
          memory_dir: "~/claude-memory",
        },
      },
    });
  });

  it("rejects direct parser input above the size limit", () => {
    const oversized = `version: 1\n# ${"x".repeat(1024 * 1024)}`;

    expect(() => parseKnowledgeHygieneConfigV1(oversized)).toThrow(
      /exceeds .* byte limit/i,
    );
  });
});

describe("loadKnowledgeHygieneConfig", () => {
  it("returns explicit zero-config mode only when the config is absent", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-config-"));
    const resolvedRoot = await realpath(repoRoot);

    await expect(loadKnowledgeHygieneConfig({ repo_root: repoRoot })).resolves
      .toEqual({
        mode: "zero_config",
        path: join(resolvedRoot, ".osstack", "neat.yaml"),
      });
  });

  it("loads valid config with content evidence and fails closed on invalid YAML", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-config-"));
    await mkdir(join(repoRoot, ".osstack"));
    const configPath = join(repoRoot, ".osstack", "neat.yaml");
    await writeFile(configPath, goodConfig, "utf8");

    const loaded = await loadKnowledgeHygieneConfig({ repo_root: repoRoot });
    expect(loaded.mode).toBe("configured");
    if (loaded.mode === "configured") {
      expect(loaded.config.version).toBe(1);
      expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/);
    }

    await writeFile(configPath, "version: [", "utf8");
    await expect(loadKnowledgeHygieneConfig({ repo_root: repoRoot })).rejects
      .toThrow(KnowledgeHygieneConfigError);
  });

  it("rejects a config symlink that resolves outside the repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-config-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "osstack-neat-external-"));
    const externalConfig = join(externalRoot, "neat.yaml");
    await writeFile(externalConfig, goodConfig, "utf8");
    await mkdir(join(repoRoot, ".osstack"));
    await symlink(externalConfig, join(repoRoot, ".osstack", "neat.yaml"));

    await expect(loadKnowledgeHygieneConfig({ repo_root: repoRoot })).rejects
      .toThrow(/outside repository/i);
  });
});
