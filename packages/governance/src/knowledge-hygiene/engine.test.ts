import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkKnowledgeHygiene } from "./engine.js";

const claudeLimitGolden = JSON.parse(readFileSync(
  new URL(
    "../../fixtures/knowledge-hygiene/adapters/claude-code-limit.golden.json",
    import.meta.url,
  ),
  "utf8",
)) as { expected_report: Record<string, unknown> };

async function snapshotPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(path);
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
    }
  };
  await walk(root, "");
  return paths;
}

describe("checkKnowledgeHygiene", () => {
  it("composes config, inventory, rules, sorting, and metrics with zero writes", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-engine-"));
    await mkdir(join(repoRoot, ".osstack"));
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 1
instructions:
  canonical: AGENTS.md
required_surfaces:
  - { id: readme, path: README.md, severity: warning }
`);
    const before = await snapshotPaths(repoRoot);

    const report = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      {
        now: () => new Date("2026-07-17T23:00:00.000Z"),
        repo_identity: () => "repo-1",
      },
    );

    expect(report.generated_at).toBe("2026-07-17T23:00:00.000Z");
    expect(report.repo.repo_id).toBe("repo-1");
    expect(report.summary).toEqual({
      error: 1,
      warning: 1,
      info: 0,
      suppressed: 0,
    });
    expect(report.findings.map((finding) => finding.rule_id)).toEqual([
      "instruction.canonical_missing",
      "surface.required_missing",
    ]);
    expect(report.metrics).toEqual([
      expect.objectContaining({ path: "AGENTS.md", exists: false }),
      expect.objectContaining({ path: "README.md", exists: false }),
    ]);
    expect(JSON.stringify(report.metrics)).not.toContain("content");
    await expect(snapshotPaths(repoRoot)).resolves.toEqual(before);
  });

  it("produces byte-stable normalized JSON for the same input and clock", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-engine-"));
    await writeFile(join(repoRoot, "AGENTS.md"), "# Canonical\n");
    await writeFile(join(repoRoot, "CLAUDE.md"), "# Independent\n");
    const ports = {
      now: () => new Date("2026-07-17T23:00:00.000Z"),
      repo_identity: () => "repo-1",
    };

    const first = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      ports,
    );
    const second = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      ports,
    );

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.findings).toEqual([
      expect.objectContaining({
        rule_id: "instruction.mirror_drift",
        severity: "warning",
      }),
    ]);
  });

  it("excludes suppressed findings and counts them in the report", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-engine-"));
    await mkdir(join(repoRoot, ".osstack"));
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 1
required_surfaces:
  - { id: guide, path: docs/guide.md, severity: warning }
ignore:
  - rule_id: surface.required_missing
    paths: [docs/**]
    reason: generated during release
`);

    const report = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      {
        now: () => new Date("2026-07-17T23:00:00.000Z"),
        repo_identity: () => "repo-1",
      },
    );

    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({
      error: 0,
      warning: 0,
      info: 0,
      suppressed: 1,
    });
  });

  it("keeps a configured but disabled memory adapter as a strict no-op", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-engine-"));
    const memoryRoot = await mkdtemp(join(tmpdir(), "osstack-neat-memory-"));
    await writeFile(join(memoryRoot, "MEMORY.md"), `${"line\n".repeat(201)}`);
    await mkdir(join(repoRoot, ".osstack"));
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 1
adapters:
  claude_code:
    enabled: false
    memory_dir: ${JSON.stringify(memoryRoot)}
`);

    const report = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      {
        now: () => new Date("2026-07-17T23:00:00.000Z"),
        repo_identity: () => "repo-1",
        home_directory: () => {
          throw new Error("disabled adapter must not request home");
        },
      },
    );

    expect(report.findings).toEqual([]);
    expect(report.metrics).toEqual([]);
    expect(report.adapters).toBeUndefined();
  });

  it("adds Claude-specific metrics and an evidence-backed hard-limit finding", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-engine-"));
    const memoryRoot = await mkdtemp(join(tmpdir(), "osstack-neat-memory-"));
    await writeFile(join(memoryRoot, "MEMORY.md"), `${"line\n".repeat(201)}`);
    await mkdir(join(repoRoot, ".osstack"));
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 1
adapters:
  claude_code:
    enabled: true
    memory_dir: ${JSON.stringify(memoryRoot)}
`);

    const report = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      {
        now: () => new Date("2026-07-17T23:00:00.000Z"),
        repo_identity: () => "repo-1",
        home_directory: () => repoRoot,
      },
    );

    expect(report.adapters).toEqual([{
      id: "claude-code",
      version: "1",
      status: "available",
      source: "https://code.claude.com/docs/en/memory",
    }]);
    expect(report.metrics).toEqual([
      expect.objectContaining({
        path: "claude-code://auto-memory/MEMORY.md",
        surface: "memory",
        lines: 201,
        adapter: {
          id: "claude-code",
          version: "1",
          source: "https://code.claude.com/docs/en/memory",
        },
      }),
    ]);
    expect(report.findings).toEqual([
      expect.objectContaining({
        rule_id: "memory.platform_limit_exceeded",
        surface: "memory",
        severity: "warning",
        observed: expect.objectContaining({
          adapter_id: "claude-code",
          adapter_version: "1",
          evidence_source: "https://code.claude.com/docs/en/memory",
          lines: 201,
        }),
        evidence_refs: expect.arrayContaining([{
          kind: "external",
          ref: "https://code.claude.com/docs/en/memory",
        }]),
      }),
    ]);
    expect(report).toMatchObject(claudeLimitGolden.expected_report);
  });

  it("reports an explicitly enabled but absent Claude platform as a clean skip", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-engine-"));
    await mkdir(join(repoRoot, ".osstack"));
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 1
adapters:
  claude_code:
    enabled: true
    memory_dir: ${JSON.stringify(join(repoRoot, "missing-memory"))}
`);

    const report = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      {
        now: () => new Date("2026-07-17T23:00:00.000Z"),
        repo_identity: () => "repo-1",
        home_directory: () => repoRoot,
      },
    );

    expect(report.adapters).toEqual([{
      id: "claude-code",
      version: "1",
      status: "absent",
      source: "https://code.claude.com/docs/en/memory",
    }]);
    expect(report.findings).toEqual([]);
    expect(report.metrics).toEqual([]);
  });

  it("inventories configured Codex local memory without applying Claude-specific rules", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-engine-"));
    const memoryRoot = await mkdtemp(join(tmpdir(), "osstack-neat-codex-memory-"));
    await writeFile(join(memoryRoot, "memory.jsonl"), `${"line\n".repeat(201)}`);
    await mkdir(join(repoRoot, ".osstack"));
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 1
adapters:
  codex_local:
    enabled: true
    memory_dir: ${JSON.stringify(memoryRoot)}
`);

    const report = await checkKnowledgeHygiene(
      { repo_root: repoRoot, mode: "all" },
      {
        now: () => new Date("2026-07-17T23:00:00.000Z"),
        repo_identity: () => "repo-1",
      },
    );

    expect(report.adapters).toEqual([{
      id: "codex-local",
      version: "1",
      status: "available",
      source: "https://learn.chatgpt.com/docs/customization/memories.md",
    }]);
    expect(report.metrics).toEqual([expect.objectContaining({
      path: "codex-local://generated-memory/memory.jsonl",
      adapter: expect.objectContaining({ id: "codex-local" }),
    })]);
    expect(report.findings).toEqual([]);
  });
});
