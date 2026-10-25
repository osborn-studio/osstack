import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import { createScratchDirSync } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, expect, it } from "vitest";
import { createHostExecutionContext } from "./execution-context-host.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
it("uses the explicit pinned config at invocation and persists references to exact host-written bytes", async () => {
  const repo = realpathSync(createScratchDirSync("tests", "context-host"));
  roots.push(repo);
  const pack = JSON.stringify({
    id: "local/test",
    version: "1",
    name: "Test",
    license: "MIT",
    source_kind: "internal",
    quality_score: 90,
    scope: "project",
    chunks: [
      {
        chunk_id: "cache",
        title: "Cache",
        body: "PRIVATE KNOWLEDGE cache isolation",
      },
    ],
  });
  writeFileSync(join(repo, "pack.json"), pack);
  const configPath = join(repo, "context.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      mode: "local",
      repo_path: repo,
      default_tenant: true,
      packs: [
        {
          path: "pack.json",
          pack_id: "local/test",
          version: "1",
          sha256: hash(pack),
          scope: "project",
          verified_at_ms: Date.now() - 1000,
          expires_at_ms: Date.now() + 60000,
        },
      ],
    }),
  );
  const captured: AgentTask[] = [];
  const adapter: AgentAdapter = {
    id: "fake",
    display_name: "Fake",
    cost_tier: "low",
    capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    async *invoke(task) {
      captured.push(task);
      yield { type: "run.started" } as HermesEvent;
    },
  };
  const host = await createHostExecutionContext(
    {
      adapters: [adapter],
      workspacePath: repo,
      configPath,
      contractDigest: "a".repeat(64),
      contractBrief: "VERIFY LOCAL ONLY",
    },
    join(repo, "serving-home"),
  );
  for await (const _event of host.adapters[0]!.invoke(
    {
      run_id: "run",
      session_id: "session",
      task_id: "task",
      capability_id: "code",
      prompt: "Inspect cache isolation",
      context: { repo_path: repo },
    },
    new AbortController().signal,
  )) {
    /* consume actual adapter */
  }
  expect(captured[0]!.prompt).toContain("PRIVATE KNOWLEDGE");
  expect(captured[0]!.prompt.match(/VERIFY LOCAL ONLY/g)).toHaveLength(1);
  expect(host.receiptRefs()).toHaveLength(2);
  expect(host.receiptRefs({ run_id: "foreign" })).toEqual([]);
  for (const ref of host.receiptRefs()) {
    const bytes = readFileSync(ref.path);
    expect(hash(bytes)).toBe(ref.digest);
    expect(statSync(ref.path).mode & 0o777).toBe(0o600);
    expect(bytes.toString()).not.toContain("PRIVATE KNOWLEDGE");
    expect(JSON.parse(bytes.toString())).toMatchObject({
      prompt_sha256: hash(captured[0]!.prompt),
      contract_digest: "a".repeat(64),
      evidence_boundary: "agent_task_prompt_not_provider_wire",
    });
  }
});
