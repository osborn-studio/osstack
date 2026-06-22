import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-knowledge-cli-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("knowledge CLI", () => {
  it("lists local knowledge pack metadata", async () => {
    const packPath = await writePack();

    const exitCode = await main(["knowledge", "list", "--pack", packPath, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      packs: [{
        id: "osstack-cloud-bootstrap",
        version: "2026.06.22",
        license: "MIT-derived-processed",
        source_kind: "processed_mit",
        quality_score: 88,
        chunks: 2,
      }],
    });
  });

  it("lists official osstack knowledge packs without explicit manifest paths", async () => {
    const exitCode = await main(["knowledge", "list", "--official", "--json"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs.join("\n")) as {
      packs: Array<{ id: string; source_kind: string; chunks: number }>;
    };
    expect(output.packs).toHaveLength(6);
    expect(output.packs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "osstack-core/loop-engineering",
        source_kind: "osstack_native",
        chunks: 1,
      }),
      expect.objectContaining({
        id: "osstack-core/proof-and-scorecard",
        source_kind: "osstack_native",
        chunks: 1,
      }),
    ]));
  });

  it("searches local knowledge pack chunks", async () => {
    const packPath = await writePack();

    const exitCode = await main(["knowledge", "search", "cloud governance", "--pack", packPath, "--json"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs.join("\n")) as {
      query: string;
      results: Array<{ pack_id: string; chunk_id: string; title: string }>;
    };
    expect(output.query).toBe("cloud governance");
    expect(output.results[0]).toMatchObject({
      pack_id: "osstack-cloud-bootstrap",
      chunk_id: "chunk-cloud-governance",
      title: "Cloud governance trace",
    });
  });

  it("searches official osstack knowledge packs", async () => {
    const exitCode = await main(["knowledge", "search", "proof pack sha256 manifest", "--official", "--json"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs.join("\n")) as {
      mode: string;
      results: Array<{ pack_id: string; chunk_id: string }>;
    };
    expect(output.mode).toBe("local");
    expect(output.results[0]).toMatchObject({
      pack_id: "osstack-core/proof-and-scorecard",
      chunk_id: "proof-checksum-pack",
    });
  });

  it("inspects a local knowledge chunk with pack metadata and provenance refs", async () => {
    const packPath = await writePack();

    const exitCode = await main(["knowledge", "inspect", "chunk-cloud-governance", "--pack", packPath, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      pack: {
        id: "osstack-cloud-bootstrap",
        version: "2026.06.22",
        source_kind: "processed_mit",
        quality_score: 88,
      },
      chunk: {
        chunk_id: "chunk-cloud-governance",
        title: "Cloud governance trace",
        body: expect.stringContaining("Osstack Knowledge Cloud should record pack ids"),
        tags: ["cloud", "governance"],
        source_refs: ["osstack-knowledge-cloud-v1"],
      },
      sources: [expect.objectContaining({
        source_id: "osstack-knowledge-cloud-v1",
        path: "processed/cloud-governance.md",
        scope: "official",
      })],
    });
  });

  it("searches Knowledge Cloud when a cloud URL is provided", async () => {
    const requests: Array<{ authorization: string | null; body?: unknown }> = [];
    const server = await startKnowledgeServer({ requests });
    try {
      const address = server.address() as AddressInfo;
      const exitCode = await main([
        "knowledge",
        "search",
        "cloud cockpit",
        "--cloud-url",
        `http://127.0.0.1:${address.port}`,
        "--token",
        "kst_cli_search",
        "--tenant",
        "team_alpha",
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const output = JSON.parse(logs.join("\n")) as {
        mode: string;
        status: string;
        packs: Array<{ id: string; source_kind: string }>;
        results: Array<{ pack_id: string; chunk_id: string }>;
      };
      expect(output).toMatchObject({
        mode: "cloud",
        status: "recorded",
        packs: [expect.objectContaining({ id: "osstack-cloud-cockpit", source_kind: "osstack_native" })],
        results: [expect.objectContaining({ chunk_id: "chunk-cockpit" })],
      });
      expect(requests).toContainEqual({
        authorization: "Bearer kst_cli_search",
        body: { query: "cloud cockpit", limit: 5, tenant_id: "team_alpha" },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("requires at least one pack path", async () => {
    const exitCode = await main(["knowledge", "list"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("knowledge list requires at least one --pack path");
  });

  it("imports project docs into a local knowledge pack and lists internal sources", async () => {
    const docsDir = join(tmp, "docs");
    await mkdir(docsDir);
    await writeFile(join(docsDir, "agent-guide.md"), [
      "# Agent Guide",
      "",
      "Project agents must record proof evidence and cite knowledge chunks in reports.",
    ].join("\n"));
    const outputPath = join(tmp, "project-pack.json");

    const importExitCode = await main([
      "knowledge",
      "import",
      docsDir,
      "--scope",
      "project",
      "--id",
      "project/agent-guide",
      "--name",
      "Project Agent Guide",
      "--license",
      "Internal",
      "--taxonomy",
      "agent-operations/multi-agent-review",
      "--output",
      outputPath,
      "--json",
    ]);

    expect(importExitCode).toBe(0);
    const manifest = JSON.parse(await readFile(outputPath, "utf-8")) as {
      id: string;
      scope: string;
      source_provenance: Array<{ path: string; license: string }>;
    };
    expect(manifest).toMatchObject({
      id: "project/agent-guide",
      scope: "project",
      source_provenance: [expect.objectContaining({ path: "agent-guide.md", license: "Internal" })],
    });

    logs = [];
    const sourcesExitCode = await main(["knowledge", "sources", "--internal", "--pack", outputPath, "--json"]);

    expect(sourcesExitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      packs: [expect.objectContaining({
        pack_id: "project/agent-guide",
        sources: [expect.objectContaining({ path: "agent-guide.md", scope: "project" })],
      })],
    });
  });

  it("lists internal provenance for official knowledge packs", async () => {
    const exitCode = await main(["knowledge", "sources", "--internal", "--official", "--json"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs.join("\n")) as {
      packs: Array<{
        pack_id: string;
        version: string;
        sources: Array<{ source_id: string; path: string; license: string; scope: string }>;
      }>;
    };
    expect(output.packs).toHaveLength(6);
    const loopPack = output.packs.find((pack) => pack.pack_id === "osstack-core/loop-engineering");
    expect(loopPack).toMatchObject({
      version: "2026.06.22",
      sources: [expect.objectContaining({
        source_id: "osstack-run-spec-v1",
        path: "docs/specs/OSSTACK_RUN_SPEC_V1.md",
        scope: "official",
        license: "Osstack-native",
      })],
    });
    expect(output.packs.every((pack) => pack.sources.length > 0)).toBe(true);
  });

  it("ingests licensed sources into an osstack-native knowledge pack", async () => {
    const sourceDir = join(tmp, "mit-sources");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "release.md"), [
      "# Release Evidence",
      "",
      "Ship releases with verification logs, risk notes, rollback notes, and proof artifacts.",
    ].join("\n"));
    const outputPath = join(tmp, "release-pack.json");

    const ingestExitCode = await main([
      "knowledge",
      "ingest",
      sourceDir,
      "--scope",
      "official",
      "--id",
      "osstack-core/release-evidence",
      "--name",
      "Osstack Release Evidence",
      "--license",
      "MIT-derived-processed",
      "--source-kind",
      "processed_mit",
      "--taxonomy",
      "osstack-core/pr-and-release",
      "--quality-score",
      "87",
      "--output",
      outputPath,
      "--json",
    ]);

    expect(ingestExitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      pack_id: "osstack-core/release-evidence",
      output: outputPath,
      source_kind: "processed_mit",
      taxonomy: ["osstack-core/pr-and-release"],
      chunks: 1,
      sources: 1,
    });
    const manifest = JSON.parse(await readFile(outputPath, "utf-8")) as {
      source_kind: string;
      chunks: Array<{ chunk_id: string; body: string }>;
      source_provenance: Array<{ path: string; license: string }>;
    };
    expect(manifest).toMatchObject({
      source_kind: "processed_mit",
      source_provenance: [expect.objectContaining({ path: "release.md", license: "MIT-derived-processed" })],
    });
    expect(manifest.chunks[0]?.body).toContain("Osstack taxonomy: osstack-core/pr-and-release.");
    expect(manifest.chunks[0]?.body).toContain("proof packs");

    logs = [];
    const searchExitCode = await main(["knowledge", "search", "rollback proof release", "--pack", outputPath, "--json"]);

    expect(searchExitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      mode: "local",
      results: [expect.objectContaining({
        pack_id: "osstack-core/release-evidence",
        chunk_id: "ing_1",
      })],
    });
  });

  it("syncs cloud packs into cache and searches cached packs", async () => {
    const server = await startKnowledgeServer();
    const cacheDir = join(tmp, "knowledge-cache");
    try {
      const address = server.address() as AddressInfo;
      const cloudUrl = `http://127.0.0.1:${address.port}`;
      const syncExitCode = await main([
        "knowledge",
        "sync",
        "--cloud-url",
        cloudUrl,
        "--cache-dir",
        cacheDir,
        "--json",
      ]);
      expect(syncExitCode).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        status: "synced",
        packs: [expect.objectContaining({ id: "osstack-cloud-cockpit" })],
      });

      logs = [];
      const searchExitCode = await main([
        "knowledge",
        "search",
        "cockpit proof",
        "--cache-dir",
        cacheDir,
        "--json",
      ]);

      expect(searchExitCode).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        mode: "local",
        results: [expect.objectContaining({ pack_id: "osstack-cloud-cockpit", chunk_id: "chunk-cockpit" })],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("evaluates official osstack knowledge packs with repository fixtures", async () => {
    const fixtures = join(__dirname, "..", "..", "..", "knowledge-evals", "retrieval", "osstack-core.json");

    const exitCode = await main(["knowledge", "eval", "--official", "--fixtures", fixtures, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      total: 30,
      passed: 30,
      failed: 0,
      top_k: 3,
    });
  });

  it("syncs tenant private cloud packs into cache and searches them locally", async () => {
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/private-packs") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        requests.push({ url: req.url, body: JSON.parse(body) as unknown });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          packs: [cloudCockpitPack({
            id: "team/private-cockpit",
            name: "Team Private Cockpit",
            license: "Internal",
            source_kind: "internal",
            scope: "team",
          })],
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const cacheDir = join(tmp, "private-cache");
    try {
      const address = server.address() as AddressInfo;
      const cloudUrl = `http://127.0.0.1:${address.port}`;
      const syncExitCode = await main([
        "knowledge",
        "sync",
        "--cloud-url",
        cloudUrl,
        "--cache-dir",
        cacheDir,
        "--private",
        "--tenant",
        "team_alpha",
        "--json",
      ]);

      expect(syncExitCode).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        status: "synced",
        private: true,
        tenant_id: "team_alpha",
        packs: [expect.objectContaining({ id: "team/private-cockpit", source_kind: "internal" })],
      });
      expect(requests).toMatchObject([{ url: "/v1/private-packs", body: { tenant_id: "team_alpha" } }]);

      logs = [];
      const searchExitCode = await main([
        "knowledge",
        "search",
        "cockpit proof",
        "--cache-dir",
        cacheDir,
        "--json",
      ]);

      expect(searchExitCode).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        mode: "local",
        results: [expect.objectContaining({ pack_id: "team/private-cockpit", chunk_id: "chunk-cockpit" })],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("logs in to Knowledge Cloud and reuses the saved config without printing the token", async () => {
    const requests: Array<{ authorization: string | null }> = [];
    const server = await startKnowledgeServer({ requests });
    const cacheDir = join(tmp, "knowledge-cache");
    try {
      const address = server.address() as AddressInfo;
      const cloudUrl = `http://127.0.0.1:${address.port}`;
      const loginExitCode = await main([
        "knowledge",
        "login",
        "--cloud-url",
        cloudUrl,
        "--token",
        "kst_test_token",
        "--cache-dir",
        cacheDir,
        "--json",
      ]);

      expect(loginExitCode).toBe(0);
      expect(logs.join("\n")).not.toContain("kst_test_token");
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        login: { cloud_url: cloudUrl, cache_dir: cacheDir, authenticated: true },
      });
      expect(await readFile(join(cacheDir, "config.json"), "utf-8")).toContain("kst_test_token");

      logs = [];
      const syncExitCode = await main(["knowledge", "sync", "--cache-dir", cacheDir, "--json"]);

      expect(syncExitCode).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({
        status: "synced",
        packs: [expect.objectContaining({ id: "osstack-cloud-cockpit" })],
      });
      expect(requests).toContainEqual(expect.objectContaining({ authorization: "Bearer kst_test_token" }));
    } finally {
      await closeServer(server);
    }
  });

  it("pins pack versions and records chunk feedback", async () => {
    const cacheDir = join(tmp, "knowledge-cache");

    const pinExitCode = await main(["knowledge", "pin", "osstack-core/loop-engineering@2026.06.22", "--cache-dir", cacheDir, "--json"]);
    expect(pinExitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      pin: { pack_id: "osstack-core/loop-engineering", version: "2026.06.22" },
    });

    logs = [];
    const feedbackExitCode = await main(["knowledge", "feedback", "chunk-cockpit", "--useful", "--cache-dir", cacheDir, "--json"]);
    expect(feedbackExitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      feedback: { chunk_id: "chunk-cockpit", rating: "useful", status: "recorded" },
    });
  });

  it("runs retrieval eval fixtures against knowledge packs", async () => {
    const packPath = join(tmp, "pack.json");
    const fixturesPath = join(tmp, "fixtures.json");
    await writeFile(packPath, JSON.stringify(cloudCockpitPack(), null, 2));
    await writeFile(fixturesPath, JSON.stringify([
      { id: "eval_cockpit", query: "cockpit proof guidance", expected_chunk_id: "chunk-cockpit" },
    ], null, 2));

    const exitCode = await main([
      "knowledge",
      "eval",
      "--pack",
      packPath,
      "--fixtures",
      fixturesPath,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
    });
  });
});

async function startKnowledgeServer(options: { requests?: Array<{ authorization: string | null; body?: unknown }> } = {}): Promise<Server> {
  const server = createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    req.on("end", () => {
      const parsedBody = rawBody.length === 0 ? undefined : JSON.parse(rawBody);
      options.requests?.push({ authorization: req.headers.authorization ?? null, body: parsedBody });
      if (req.method === "POST" && req.url === "/v1/feedback") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sync") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          packs: [cloudCockpitPack()],
        }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/search") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        packs: [{
          id: "osstack-cloud-cockpit",
          version: "2026.06.22",
          license: "Osstack Cloud Terms",
          source_kind: "osstack_native",
          quality_score: 97,
        }],
        results: [{
          pack_id: "osstack-cloud-cockpit",
          pack_version: "2026.06.22",
          chunk_id: "chunk-cockpit",
          title: "Cockpit evidence surface",
          score: 10,
          snippet: "Knowledge Cloud should return Osstack-native cockpit and proof guidance.",
          tags: ["cockpit"],
          source_refs: ["osstack-cloud"],
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function cloudCockpitPack(overrides: Record<string, unknown> = {}) {
  return {
    id: "osstack-cloud-cockpit",
    version: "2026.06.22",
    name: "Osstack Cloud Cockpit",
    license: "Osstack Cloud Terms",
    source_kind: "osstack_native",
    quality_score: 97,
    last_reviewed_at: "2026-06-22T00:00:00.000Z",
    taxonomy: ["osstack-core/proof-and-scorecard"],
    chunks: [{
      chunk_id: "chunk-cockpit",
      title: "Cockpit evidence surface",
      body: "Knowledge Cloud should return Osstack-native cockpit and proof guidance.",
      tags: ["cockpit", "proof"],
      source_refs: ["osstack-cloud"],
    }],
    ...overrides,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writePack(): Promise<string> {
  const packPath = join(tmp, "knowledge-pack.json");
  await writeFile(packPath, JSON.stringify({
    id: "osstack-cloud-bootstrap",
    version: "2026.06.22",
    name: "Osstack Cloud Bootstrap",
    license: "MIT-derived-processed",
    source_kind: "processed_mit",
    quality_score: 88,
    chunks: [
      {
        chunk_id: "chunk-cloud-governance",
        title: "Cloud governance trace",
        body: "Osstack Knowledge Cloud should record pack ids and chunk ids in report and proof evidence.",
        tags: ["cloud", "governance"],
        source_refs: ["osstack-knowledge-cloud-v1"],
      },
      {
        chunk_id: "chunk-local-cache",
        title: "Local cache fallback",
        body: "If cloud search is unavailable, osstack should fail open to local knowledge packs or off mode.",
        tags: ["local", "cache"],
      },
    ],
    source_provenance: [{
      source_id: "osstack-knowledge-cloud-v1",
      path: "processed/cloud-governance.md",
      sha256: "sha256-placeholder",
      license: "MIT-derived-processed",
      scope: "official",
      imported_at: "2026-06-22T00:00:00.000Z",
    }],
  }, null, 2));
  return packPath;
}
