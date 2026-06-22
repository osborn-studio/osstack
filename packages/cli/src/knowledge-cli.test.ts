import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
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

  it("requires at least one pack path", async () => {
    const exitCode = await main(["knowledge", "list"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("knowledge list requires at least one --pack path");
  });
});

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
