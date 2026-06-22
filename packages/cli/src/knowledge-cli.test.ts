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

  it("searches Knowledge Cloud when a cloud URL is provided", async () => {
    const server = await startKnowledgeServer();
    try {
      const address = server.address() as AddressInfo;
      const exitCode = await main([
        "knowledge",
        "search",
        "cloud cockpit",
        "--cloud-url",
        `http://127.0.0.1:${address.port}`,
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
      pack_id: "project/agent-guide",
      sources: [expect.objectContaining({ path: "agent-guide.md", scope: "project" })],
    });
  });
});

async function startKnowledgeServer(): Promise<Server> {
  const server = createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
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
      },
      {
        chunk_id: "chunk-local-cache",
        title: "Local cache fallback",
        body: "If cloud search is unavailable, osstack should fail open to local knowledge packs or off mode.",
        tags: ["local", "cache"],
      },
    ],
  }, null, 2));
  return packPath;
}
