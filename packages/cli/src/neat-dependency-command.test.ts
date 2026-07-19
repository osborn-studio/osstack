import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDeclaredDependencyEdgeProjectionV2,
  openDb,
} from "@osstack/core";
import type {
  KnowledgeHygieneTransactionApplyHooksV1,
  SemanticJudgePort,
  SemanticJudgeRequestV1,
  SemanticJudgeResponseV1,
} from "@osstack/governance";
import { KnowledgeHygieneSimulatedCrashV1 } from "@osstack/governance";
import {
  handleNeatDependencyCommand,
  type NeatDependencyCommandDependencies,
} from "./neat-dependency-command.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("neat dependencies", () => {
  it("records deterministic candidates idempotently and reads the downstream inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-dependencies-"));
    created.push(root);
    const home = join(root, "home");
    const upstream = join(root, "upstream");
    const downstream = join(root, "downstream");
    await mkdir(home, { recursive: true });
    await mkdir(upstream, { recursive: true });
    await mkdir(join(downstream, ".osstack"), { recursive: true });
    await writeFile(join(upstream, "package.json"), JSON.stringify({
      name: "@demo/upstream",
    }));
    await writeFile(join(downstream, "package.json"), JSON.stringify({
      name: "@demo/downstream",
      dependencies: { "@demo/upstream": "workspace:*" },
    }));
    await writeFile(join(downstream, ".osstack", "neat.yaml"), `
version: 2
instructions:
  canonical: AGENTS.md
`);
    const registry = join(root, "repos.json");
    await writeFile(registry, `${JSON.stringify([
      {
        repo_id: "upstream",
        name: "Upstream",
        path: upstream,
        role: "core_platform",
        enabled: true,
      },
      {
        repo_id: "downstream",
        name: "Downstream",
        path: downstream,
        role: "app",
        enabled: true,
      },
    ], null, 2)}\n`);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const judge: SemanticJudgePort = {
      id: "fake-no-tools",
      model_id: "fake-model",
      prompt_version: "test-1",
      supports_no_tools: true,
      judge: async (
        request: SemanticJudgeRequestV1,
      ): Promise<SemanticJudgeResponseV1> => {
        const source = request.evidence_pack.sources[0]!;
        const excerpt = source.excerpts[0]!;
        return {
          nonce: request.nonce,
          raw_output: {
            dimension: "cross_repository",
            verdict: "issue",
            confidence: "high",
            citations: [{
              source: source.source,
              blob_sha256: source.blob_sha256,
              start_line: excerpt.start_line,
              end_line: excerpt.end_line,
              excerpt: excerpt.text,
              text_sha256: createHash("sha256").update(excerpt.text).digest("hex"),
            }],
            rationale: "The downstream package declares a direct upstream SDK dependency.",
            proposed_disposition: "review",
            closure_conditions: [],
          },
          usage: { input_tokens: 10, output_tokens: 10, calls: 1 },
        };
      },
    };
    let clock = new Date("2026-07-18T00:00:00.000Z");
    const deps: NeatDependencyCommandDependencies = {
      cwd: () => root,
      home: () => home,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      now: () => clock,
      min_free_bytes: 0,
      is_tty: () => true,
      local_user_id: () => "501",
      judge_factory: () => judge,
    };

    expect(await handleNeatDependencyCommand([
      "scan",
      "--registry",
      registry,
      "--record",
      "--judge",
      "fake-no-tools",
      "--json",
    ], deps)).toBe(0);
    const scan = JSON.parse(stdout.at(-1) ?? "{}") as {
      candidates: unknown[];
      obligations_recorded: number;
    };
    expect(scan.candidates).toHaveLength(1);
    expect(scan.obligations_recorded).toBe(1);
    expect(await handleNeatDependencyCommand([
      "scan",
      "--registry",
      registry,
      "--record",
      "--json",
    ], deps)).toBe(0);

    expect(await handleNeatDependencyCommand([
      "inbox",
      "--registry",
      registry,
      "--repo-id",
      "downstream",
      "--json",
    ], deps)).toBe(0);
    const inbox = JSON.parse(stdout.at(-1) ?? "{}") as {
      obligations: Array<{ obligation_id: string; revision: number }>;
    };
    expect(inbox.obligations).toHaveLength(1);
    expect((inbox.obligations[0] as { state?: string }).state).toBe("advisory");

    const obligation = inbox.obligations[0]!;
    expect(await handleNeatDependencyCommand([
      "confirm",
      "--obligation",
      obligation.obligation_id,
      "--repo",
      downstream,
      "--actor",
      "owner",
      "--if-revision",
      String(obligation.revision),
      "--dry-run",
      "--json",
    ], deps)).toBe(0);
    const preview = JSON.parse(stdout.at(-1) ?? "{}") as { plan_id: string };
    let failCoreCommit = true;
    deps.after_config_apply_before_core = () => {
      if (failCoreCommit) throw new Error("simulated Core outage");
    };
    expect(await handleNeatDependencyCommand([
      "confirm",
      "--obligation",
      obligation.obligation_id,
      "--repo",
      downstream,
      "--actor",
      "owner",
      "--if-revision",
      String(obligation.revision),
      "--execute",
      "--json",
    ], deps)).toBe(3);
    expect(stderr.at(-1)).toContain("simulated Core outage");
    stderr.length = 0;
    expect(await readFile(join(downstream, ".osstack", "neat.yaml"), "utf8"))
      .toContain("dependencies:");
    failCoreCommit = false;
    expect(await handleNeatDependencyCommand([
      "confirm",
      "--obligation",
      obligation.obligation_id,
      "--repo",
      downstream,
      "--actor",
      "owner",
      "--if-revision",
      String(obligation.revision),
      "--execute",
      "--json",
    ], deps)).toBe(0);
    delete deps.after_config_apply_before_core;
    const confirmed = JSON.parse(stdout.at(-1) ?? "{}") as {
      edge: { edge_id: string };
      obligation_state: string;
    };
    expect(confirmed.obligation_state).toBe("promoted");
    expect(preview.plan_id).toMatch(/^khtp_/);
    expect(await readFile(join(downstream, ".osstack", "neat.yaml"), "utf8"))
      .toContain(confirmed.edge.edge_id);

    const rebuiltHome = join(root, "rebuilt-home");
    expect(await handleNeatDependencyCommand([
      "scan",
      "--registry",
      registry,
      "--record",
      "--json",
    ], { ...deps, home: () => rebuiltHome })).toBe(0);
    const rebuiltDb = openDb({ path: join(rebuiltHome, "state.db"), minFreeBytes: 0 });
    try {
      expect(getDeclaredDependencyEdgeProjectionV2(
        rebuiltDb,
        confirmed.edge.edge_id,
      )?.state).toBe("confirmed");
    } finally {
      rebuiltDb.close();
    }

    expect(await handleNeatDependencyCommand([
      "revoke",
      "--edge",
      confirmed.edge.edge_id,
      "--repo",
      downstream,
      "--actor",
      "owner",
      "--if-revision",
      "1",
      "--dry-run",
      "--json",
    ], deps)).toBe(0);
    const revokePreview = JSON.parse(stdout.at(-1) ?? "{}") as { plan_id: string };
    deps.apply_hooks = {
      after_write: (index: number) => {
        if (index === 0) throw new KnowledgeHygieneSimulatedCrashV1();
      },
    } satisfies KnowledgeHygieneTransactionApplyHooksV1;
    expect(await handleNeatDependencyCommand([
      "revoke",
      "--edge",
      confirmed.edge.edge_id,
      "--repo",
      downstream,
      "--actor",
      "owner",
      "--if-revision",
      "1",
      "--execute",
      "--json",
    ], deps)).toBe(3);
    expect(stderr.at(-1)).toContain("simulated process termination");
    stderr.length = 0;
    delete deps.apply_hooks;
    expect(await handleNeatDependencyCommand([
      "recover",
      "--plan",
      revokePreview.plan_id,
      "--json",
    ], deps)).toBe(0);
    expect(await readFile(join(downstream, ".osstack", "neat.yaml"), "utf8"))
      .toContain(confirmed.edge.edge_id);

    clock = new Date("2026-07-18T00:00:01.000Z");
    expect(await handleNeatDependencyCommand([
      "revoke",
      "--edge",
      confirmed.edge.edge_id,
      "--repo",
      downstream,
      "--actor",
      "owner",
      "--if-revision",
      "1",
      "--execute",
      "--json",
    ], deps)).toBe(0);
    expect(await readFile(join(downstream, ".osstack", "neat.yaml"), "utf8"))
      .not.toContain(confirmed.edge.edge_id);
    expect(stderr).toEqual([]);
  });
});
