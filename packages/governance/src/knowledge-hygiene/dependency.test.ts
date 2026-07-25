import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DependencyObligationV2,
  createDependencyCandidateV2,
  createDependencyObligationV2,
  createDeclaredDependencyEdgeIdV2,
  scanKnowledgeHygieneDependencyCandidatesV2,
  transitionDependencyObligationV2,
} from "./dependency.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("cross-repository dependency contracts", () => {
  it("scans deterministic package and env-name evidence without reading .env values", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-dependency-scan-"));
    created.push(root);
    const upstream = join(root, "upstream");
    const downstream = join(root, "downstream");
    await mkdir(join(upstream, "src"), { recursive: true });
    await mkdir(join(downstream, "src"), { recursive: true });
    await writeFile(join(upstream, "package.json"), JSON.stringify({
      name: "@demo/upstream",
      version: "1.0.0",
    }));
    await writeFile(join(downstream, "package.json"), JSON.stringify({
      name: "@demo/downstream",
      dependencies: { "@demo/upstream": "workspace:*" },
    }));
    await writeFile(join(upstream, "src", "config.ts"), "process.env.SHARED_API_URL;\n");
    await writeFile(
      join(upstream, "src", "client.ts"),
      "export function createUpstreamClient() { return true; }\n",
    );
    await writeFile(
      join(downstream, "src", "client.ts"),
      [
        'import { createUpstreamClient } from "@demo/upstream";',
        "process.env.SHARED_API_URL;",
        'fetch("https://upstream.internal.example/v1");',
        "createUpstreamClient();",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(upstream, "service.yaml"),
      "endpoint: https://upstream.internal.example/v1\n",
    );
    await writeFile(
      join(downstream, ".gitmodules"),
      '[submodule "upstream"]\n  path = vendor/upstream\n  url = ../upstream\n',
    );
    await writeFile(join(downstream, ".env"), "SHARED_API_URL=https://secret.example/token-value\n");

    const result = await scanKnowledgeHygieneDependencyCandidatesV2({
      registry_scope: "a".repeat(64),
      repositories: [
        { repo_id: "upstream", root_realpath: await realpath(upstream) },
        { repo_id: "downstream", root_realpath: await realpath(downstream) },
      ],
    });
    const edge = result.candidates.find((candidate) =>
      candidate.upstream_repo_id === "upstream"
      && candidate.downstream_repo_id === "downstream"
    );
    expect(edge?.kinds).toEqual(expect.arrayContaining([
      "sdk",
      "env_name",
      "url",
      "symbol",
      "path",
    ]));
    expect(JSON.stringify(result)).not.toContain("token-value");
    expect(result.files_skipped).toBeGreaterThanOrEqual(1);
  });

  it("keeps obligation and declared edge identities stable across evidence updates", () => {
    const candidate = createDependencyCandidateV2({
      registry_scope: "a".repeat(64),
      source_repo_id: "downstream",
      upstream_repo_id: "upstream",
      downstream_repo_id: "downstream",
      kinds: ["api", "sdk"] as const,
      evidence_refs: [{ kind: "proof" as const, ref: "downstream:package.json" }],
    });
    const obligation = createDependencyObligationV2(candidate, {
      created_at: "2026-07-18T00:00:00.000Z",
      expires_at: "2026-08-18T00:00:00.000Z",
    });
    expect(DependencyObligationV2.parse(obligation)).toEqual(obligation);
    const advisory = transitionDependencyObligationV2(obligation, {
      to_state: "advisory",
      actor: "judge:isolated",
      reason: "Evidence-bound semantic verdict.",
      if_revision: 1,
      occurred_at: "2026-07-18T00:01:00.000Z",
      rationale: "The SDK import creates a downstream review obligation.",
      evidence_refs: [{
        kind: "evidence_pack",
        ref: "pack:khep_1",
        sha256: "b".repeat(64),
        run_id: "run-1",
      }],
    });
    expect(advisory.state).toBe("advisory");
    expect(advisory.revision).toBe(2);
    expect(createDeclaredDependencyEdgeIdV2({
      registry_scope: candidate.registry_scope,
      upstream_repo_id: "upstream",
      downstream_repo_id: "downstream",
      kinds: ["sdk", "api"],
    })).toBe(createDeclaredDependencyEdgeIdV2({
      registry_scope: candidate.registry_scope,
      upstream_repo_id: "upstream",
      downstream_repo_id: "downstream",
      kinds: ["api", "sdk"],
    }));
  });
});
