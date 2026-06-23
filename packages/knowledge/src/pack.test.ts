import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleKnowledgeSnippet,
  cacheKnowledgeFeedback,
  createKnowledgeAdaptationPlan,
  evaluateKnowledgeRetrieval,
  ingestKnowledgeSource,
  importKnowledgeSource,
  listCachedKnowledgePacks,
  loadKnowledgePackIndex,
  loadKnowledgePack,
  pinKnowledgePack,
  pruneKnowledgeCache,
  retrieveKnowledge,
  resolveKnowledgeSearch,
  searchKnowledgePacks,
  syncKnowledgeCache,
  validateKnowledgePackIndex,
  validateKnowledgeAdaptationPlan,
  validateKnowledgePackManifest,
  validateKnowledgePublishGate,
  type KnowledgeRetrievalEvalCase,
} from "./index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-knowledge-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("knowledge packs", () => {
  it("loads an osstack-native manifest from a file", async () => {
    const path = join(tmp, "pack.json");
    await writeFile(path, JSON.stringify(samplePack(), null, 2));

    const pack = await loadKnowledgePack(path);

    expect(pack.manifest).toMatchObject({
      id: "osstack-web-quality",
      version: "2026.06.22",
      license: "MIT-derived-processed",
      source_kind: "processed_mit",
      quality_score: 91,
    });
    expect(JSON.parse(await readFile(path, "utf-8"))).toHaveProperty("chunks");
  });

  it("rejects manifests without required ownership metadata", () => {
    expect(() => validateKnowledgePackManifest({
      id: "bad",
      version: "1",
      name: "Bad",
      chunks: [],
    })).toThrow(/license/);
  });

  it("rejects source provenance paths that escape the knowledge pack", () => {
    expect(() => validateKnowledgePackManifest(samplePack({
      source_provenance: [{
        source_id: "src_escape",
        path: "nested/../upstream.md",
        sha256: createHash("sha256").update("upstream").digest("hex"),
        license: "MIT-derived-processed",
        scope: "official",
        imported_at: "2026-06-22T00:00:00.000Z",
      }],
    }))).toThrow(/source_provenance path is unsafe/);

    expect(() => validateKnowledgePackManifest(samplePack({
      source_provenance: [{
        source_id: "src_absolute",
        path: "/tmp/upstream.md",
        sha256: createHash("sha256").update("upstream").digest("hex"),
        license: "MIT-derived-processed",
        scope: "official",
        imported_at: "2026-06-22T00:00:00.000Z",
      }],
    }))).toThrow(/source_provenance path is unsafe/);
  });

  it("searches local packs and assembles prompt snippets", async () => {
    const path = join(tmp, "pack.json");
    await writeFile(path, JSON.stringify(samplePack(), null, 2));
    const pack = await loadKnowledgePack(path);

    const results = searchKnowledgePacks([pack], "frontend governance", { limit: 2 });

    expect(results[0]).toMatchObject({
      pack_id: "osstack-web-quality",
      chunk_id: "chunk-frontend-governance",
      title: "Frontend governance checks",
      matched_terms: ["frontend", "governance"],
    });
    expect(assembleKnowledgeSnippet(results)).toContain("pack=osstack-web-quality@2026.06.22");
    expect(assembleKnowledgeSnippet(results)).toContain("matched_terms=frontend,governance");
  });

  it("ranks chunks with rare query term coverage above repeated generic matches", async () => {
    const path = join(tmp, "ranking-pack.json");
    await writeFile(path, JSON.stringify(samplePack({
      chunks: [
        {
          chunk_id: "chunk-repeated-generic",
          title: "Proof repetition",
          body: "proof proof proof proof proof proof proof proof proof proof",
          tags: ["proof"],
          source_refs: ["ranking-fixture"],
        },
        {
          chunk_id: "chunk-specific-coverage",
          title: "Proof checksum manifest",
          body: "Proof evidence should include a checksum manifest for audit review.",
          tags: ["proof", "checksum"],
          source_refs: ["ranking-fixture"],
        },
      ],
    }), null, 2));
    const pack = await loadKnowledgePack(path);

    const results = searchKnowledgePacks([pack], "proof checksum", { limit: 2 });

    expect(results.map((result) => result.chunk_id)).toEqual([
      "chunk-specific-coverage",
      "chunk-repeated-generic",
    ]);
    expect(results[0]?.matched_terms).toEqual(["proof", "checksum"]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("exposes a stable retrieval boundary with metadata for local BM25 search", async () => {
    const path = join(tmp, "pack.json");
    await writeFile(path, JSON.stringify(samplePack(), null, 2));
    const pack = await loadKnowledgePack(path);

    const evidence = await retrieveKnowledge({
      mode: "local",
      query: "a governance",
      packs: [pack],
      limit: 1,
    });

    expect(evidence).toMatchObject({
      mode: "local",
      status: "recorded",
      query: "a governance",
      packs: [expect.objectContaining({ id: "osstack-web-quality" })],
      results: [expect.objectContaining({ chunk_id: "chunk-frontend-governance" })],
      retrieval: {
        engine: "bm25",
        query_terms: ["governance"],
        searched_packs: 1,
        searched_chunks: 2,
      },
    });
  });

  it("handles CJK retrieval terms through the stable retrieval boundary", async () => {
    const path = join(tmp, "cjk-pack.json");
    await writeFile(path, JSON.stringify(samplePack({
      chunks: [
        {
          chunk_id: "chunk-cjk-proof",
          title: "中文证据链",
          body: "Osstack 证据链 应该包含 proof pack、验证结果和回滚记录。",
          tags: ["证据链", "proof"],
          source_refs: ["cjk-fixture"],
        },
        {
          chunk_id: "chunk-cjk-generic",
          title: "中文通用说明",
          body: "Osstack 工作流 应该保持清晰。",
          tags: ["workflow"],
          source_refs: ["cjk-fixture"],
        },
      ],
    }), null, 2));
    const pack = await loadKnowledgePack(path);

    const evidence = await retrieveKnowledge({
      mode: "local",
      query: "证据链",
      packs: [pack],
      limit: 1,
    });

    expect(evidence).toMatchObject({
      mode: "local",
      status: "recorded",
      retrieval: {
        engine: "bm25",
        query_terms: ["证据链"],
        searched_packs: 1,
        searched_chunks: 2,
      },
      results: [expect.objectContaining({
        chunk_id: "chunk-cjk-proof",
        matched_terms: ["证据链"],
      })],
    });
  });

  it("uses cloud search when a cloud endpoint returns osstack-native results", async () => {
    const requests: Array<{ authorization: string | null; body: unknown }> = [];
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      packs: [{
        id: "osstack-cloud-web",
        version: "2026.06.22",
        license: "Osstack Cloud Terms",
        source_kind: "osstack_native",
        quality_score: 96,
      }],
      results: [{
        pack_id: "osstack-cloud-web",
        pack_version: "2026.06.22",
        chunk_id: "chunk-cloud-ui",
        title: "Cloud UI guidance",
        score: 12,
        snippet: "Use osstack-native cockpit guidance from the cloud pack.",
        tags: ["ui"],
        source_refs: ["osstack-cloud"],
        matched_terms: ["ui", "guidance"],
      }],
    }), { status: 200 });

    const evidence = await resolveKnowledgeSearch({
      mode: "cloud",
      query: "ui guidance",
      cloudUrl: "https://knowledge.osstack.ai",
      authToken: "kst_search_token",
      fetchImpl: async (url, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return fetchImpl(url, init);
      },
      tenantId: "team_alpha",
    });

    expect(evidence).toMatchObject({
      mode: "cloud",
      status: "recorded",
      packs: [expect.objectContaining({ id: "osstack-cloud-web", source_kind: "osstack_native" })],
      results: [expect.objectContaining({ chunk_id: "chunk-cloud-ui", matched_terms: ["ui", "guidance"] })],
    });
    expect(requests).toEqual([{
      authorization: "Bearer kst_search_token",
      body: { query: "ui guidance", limit: 5, tenant_id: "team_alpha" },
    }]);
  });

  it("fails open from cloud to local packs", async () => {
    const path = join(tmp, "pack.json");
    await writeFile(path, JSON.stringify(samplePack(), null, 2));
    const pack = await loadKnowledgePack(path);

    const evidence = await resolveKnowledgeSearch({
      mode: "cloud",
      query: "frontend governance",
      packs: [pack],
      cloudUrl: "https://knowledge.osstack.ai",
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(evidence).toMatchObject({
      mode: "local",
      status: "recorded",
      fallback_mode: "local",
      packs: [expect.objectContaining({ id: "osstack-web-quality" })],
      results: [expect.objectContaining({ chunk_id: "chunk-frontend-governance" })],
    });
  });

  it("turns off knowledge when cloud is unavailable and no local packs exist", async () => {
    const evidence = await resolveKnowledgeSearch({
      mode: "cloud",
      query: "frontend governance",
      cloudUrl: "https://knowledge.osstack.ai",
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(evidence).toMatchObject({
      mode: "off",
      status: "not_used",
      fallback_mode: "off",
    });
  });

  it("imports local docs into an osstack-native pack with provenance", async () => {
    const sourceDir = join(tmp, "team-docs");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "runbook.md"), [
      "# Release Runbook",
      "",
      "Every osstack release should include proof packs, scorecards, and a rollback note.",
    ].join("\n"));

    const manifest = await importKnowledgeSource({
      path: sourceDir,
      id: "team/release-runbook",
      name: "Team Release Runbook",
      license: "Internal",
      scope: "team",
      taxonomy: ["osstack-core/pr-and-release"],
      generatedAt: "2026-06-22T00:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      id: "team/release-runbook",
      source_kind: "internal",
      scope: "team",
      taxonomy: ["osstack-core/pr-and-release"],
      quality_score: 50,
      last_reviewed_at: "2026-06-22T00:00:00.000Z",
      source_provenance: [expect.objectContaining({
        path: "runbook.md",
        license: "Internal",
        scope: "team",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
      chunks: [expect.objectContaining({
        title: "Release Runbook",
        tags: expect.arrayContaining(["team", "osstack-core/pr-and-release"]),
        source_refs: ["src_1"],
      })],
    });

    const results = searchKnowledgePacks([{ manifest, path: sourceDir }], "rollback proof", { limit: 1 });
    expect(results[0]).toMatchObject({
      pack_id: "team/release-runbook",
      chunk_id: "chk_1",
    });
  });

  it("ingests licensed sources into processed osstack-native guidance", async () => {
    const sourceDir = join(tmp, "mit-notes");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "quality.md"), [
      "# Frontend Quality",
      "",
      "Avoid placeholder content, inaccessible controls, and fake loading states before release.",
    ].join("\n"));

    const manifest = await ingestKnowledgeSource({
      path: sourceDir,
      id: "osstack-core/frontend-quality",
      name: "Osstack Frontend Quality",
      license: "MIT-derived-processed",
      scope: "official",
      sourceKind: "processed_mit",
      taxonomy: ["software-engineering/frontend-quality"],
      qualityScore: 86,
      generatedAt: "2026-06-22T00:00:00.000Z",
      sourceAttribution: ["processed from MIT-compatible frontend quality notes"],
      review: {
        status: "approved",
        reviewer_id: "knowledge-reviewer",
        reviewed_at: "2026-06-22T00:00:00.000Z",
        summary: "Processed notes use osstack-native terminology and source references.",
      },
    });

    expect(manifest).toMatchObject({
      id: "osstack-core/frontend-quality",
      source_kind: "processed_mit",
      scope: "official",
      taxonomy: ["software-engineering/frontend-quality"],
      quality_score: 86,
      review: {
        status: "approved",
        reviewer_id: "knowledge-reviewer",
        reviewed_at: "2026-06-22T00:00:00.000Z",
      },
      source_attribution: ["processed from MIT-compatible frontend quality notes"],
      source_provenance: [expect.objectContaining({
        path: "quality.md",
        license: "MIT-derived-processed",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
      chunks: [expect.objectContaining({
        chunk_id: "ing_1",
        title: "Osstack Frontend Quality",
        tags: expect.arrayContaining(["official", "osstack-native", "software-engineering/frontend-quality"]),
        source_refs: ["src_1"],
      })],
    });
    expect(manifest.chunks[0]?.body).toContain("Osstack taxonomy: software-engineering/frontend-quality.");
    expect(manifest.chunks[0]?.body).toContain("runs, loops, agents, verifiers, proof packs");
    expect(manifest.chunks[0]?.body).toContain("Operational guidance:");
  });

  it("plans external MIT corpus adaptation without keeping upstream product identity", async () => {
    const sourceDir = join(tmp, "umadev-knowledge");
    await mkdir(join(sourceDir, "ai"), { recursive: true });
    await mkdir(join(sourceDir, "security"), { recursive: true });
    await writeFile(join(sourceDir, "ai", "agent-evaluation.md"), [
      "# Agent Evaluation",
      "",
      "Evaluate agent runs with scorecards, review gates, and retrieval traces.",
    ].join("\n"));
    await writeFile(join(sourceDir, "security", "secrets.md"), [
      "# Secrets Management",
      "",
      "Prevent secret leakage during generated-code delivery.",
    ].join("\n"));

    const plan = await createKnowledgeAdaptationPlan({
      path: sourceDir,
      sourceName: "umacloud/umadev",
      sourceLicense: "MIT",
      generatedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(plan).toMatchObject({
      source_name: "umacloud/umadev",
      source_license: "MIT",
      target_scope: "official",
      target_source_kind: "processed_mit",
      families: [
        expect.objectContaining({
          family_id: "ai",
          source_paths: ["ai/agent-evaluation.md"],
          source_count: 1,
          target_pack_id: "osstack-corpus/ai",
          target_name: "Osstack Ai",
          target_taxonomy: ["ai-agent-engineering/general"],
          target_license: "MIT-derived-processed",
          required_actions: expect.arrayContaining([
            "rewrite_in_osstack_voice",
            "record_source_provenance",
            "review_before_official_publish",
            "add_retrieval_eval",
          ]),
        }),
        expect.objectContaining({
          family_id: "security",
          source_paths: ["security/secrets.md"],
          target_pack_id: "osstack-corpus/security",
          target_taxonomy: ["security/devsecops"],
        }),
      ],
    });
    expect(validateKnowledgeAdaptationPlan(plan)).toMatchObject({ ok: true, issues: [] });
  });

  it("rejects adaptation plans that would publish upstream-branded pack identities", () => {
    const report = validateKnowledgeAdaptationPlan({
      generated_at: "2026-06-23T00:00:00.000Z",
      source_name: "umacloud/umadev",
      source_root: "knowledge",
      source_license: "MIT",
      target_scope: "official",
      target_source_kind: "processed_mit",
      families: [{
        family_id: "ai",
        source_paths: ["ai/agent-evaluation.md"],
        source_count: 1,
        target_pack_id: "umadev/ai",
        target_name: "UmaDev AI",
        target_taxonomy: [],
        source_license: "MIT",
        target_license: "MIT",
        status: "planned",
        required_actions: ["record_source_provenance"],
      }],
    });

    expect(report).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "adaptation_target_pack_not_osstack" }),
        expect.objectContaining({ code: "adaptation_target_keeps_upstream_identity" }),
        expect.objectContaining({ code: "adaptation_missing_taxonomy" }),
        expect.objectContaining({ code: "adaptation_processed_license_not_osstack_derived" }),
        expect.objectContaining({ code: "adaptation_missing_required_action" }),
      ]),
    });
  });

  it("rejects official publish candidates without Osstack processing evidence", async () => {
    const report = validateKnowledgePublishGate({
      id: "osstack-core/raw",
      version: "2026.06.22",
      name: "Raw Official Notes",
      license: "MIT",
      source_kind: "processed_mit",
      quality_score: 70,
      scope: "official",
      chunks: [{
        chunk_id: "raw_1",
        title: "Raw Notes",
        body: "Generic release notes copied from an upstream source.",
      }],
    });

    expect(report).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "official_low_quality_score" }),
        expect.objectContaining({ code: "official_missing_taxonomy" }),
        expect.objectContaining({ code: "official_missing_review" }),
        expect.objectContaining({ code: "official_review_not_approved" }),
        expect.objectContaining({ code: "missing_source_attribution" }),
        expect.objectContaining({ code: "missing_source_provenance" }),
        expect.objectContaining({ code: "chunk_missing_osstack_voice" }),
        expect.objectContaining({ code: "chunk_missing_source_refs" }),
      ]),
    });
  });

  it("rejects processed official packs that keep a raw upstream license label", () => {
    const report = validateKnowledgePublishGate({
      id: "osstack-core/raw-mit-label",
      version: "2026.06.22",
      name: "Raw MIT Label",
      license: "MIT",
      source_kind: "processed_mit",
      quality_score: 90,
      scope: "official",
      taxonomy: ["software-engineering/release-quality"],
      last_reviewed_at: "2026-06-22T00:00:00.000Z",
      review: {
        status: "approved",
        reviewer_id: "knowledge-reviewer",
        reviewed_at: "2026-06-22T00:00:00.000Z",
        summary: "Reviewed as osstack-native processed guidance.",
      },
      source_attribution: ["processed from MIT-compatible upstream notes"],
      source_provenance: [{
        source_id: "src_1",
        path: "upstream.md",
        sha256: createHash("sha256").update("upstream").digest("hex"),
        license: "MIT",
        scope: "official",
        imported_at: "2026-06-22T00:00:00.000Z",
      }],
      chunks: [{
        chunk_id: "raw_mit_1",
        title: "Release Quality",
        body: "Osstack release quality guidance should convert upstream notes into runs, loops, verifiers, and proof pack actions.",
        source_refs: ["src_1"],
      }],
    });

    expect(report).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "processed_license_not_osstack_derived" }),
      ]),
    });
  });

  it("rejects official knowledge packs that are not review-approved", () => {
    const report = validateKnowledgePublishGate({
      id: "osstack-core/review-needed",
      version: "2026.06.22",
      name: "Review Needed",
      license: "Osstack-native",
      source_kind: "osstack_native",
      quality_score: 90,
      scope: "official",
      taxonomy: ["osstack-core/review-needed"],
      last_reviewed_at: "2026-06-22T00:00:00.000Z",
      review: {
        status: "changes_requested",
        reviewer_id: "knowledge-reviewer",
        reviewed_at: "2026-06-22T00:00:00.000Z",
        summary: "Needs source rewriting before publication.",
      },
      source_attribution: ["osstack-native product knowledge"],
      source_provenance: [{
        source_id: "src_1",
        path: "notes.md",
        sha256: createHash("sha256").update("notes").digest("hex"),
        license: "Osstack-native",
        scope: "official",
        imported_at: "2026-06-22T00:00:00.000Z",
      }],
      chunks: [{
        chunk_id: "review_needed_1",
        title: "Review Needed",
        body: "Osstack review guidance should map source intake into runs, loops, proof packs, and Knowledge Cloud publication.",
        source_refs: ["src_1"],
      }],
    });

    expect(report).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "official_review_not_approved" }),
      ]),
    });
  });

  it("blocks official ingest candidates without taxonomy before writing a weak pack", async () => {
    const sourceDir = join(tmp, "weak-official");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "notes.md"), [
      "# Release Notes",
      "",
      "Ship releases with verification artifacts.",
    ].join("\n"));

    await expect(ingestKnowledgeSource({
      path: sourceDir,
      id: "osstack-core/weak",
      name: "Osstack Weak Pack",
      license: "MIT-derived-processed",
      scope: "official",
      sourceKind: "processed_mit",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sourceAttribution: ["processed from MIT-compatible notes"],
    })).rejects.toThrow(/official_missing_taxonomy/);
  });

  it("syncs cloud packs into a local cache and loads them for search", async () => {
    const cacheDir = join(tmp, "cache");
    const requests: Array<{ authorization: string | null }> = [];
    const evidence = await syncKnowledgeCache({
      cacheDir,
      cloudUrl: "https://knowledge.osstack.ai",
      authToken: "kst_sync_token",
      fetchImpl: async (_url, init) => {
        requests.push({ authorization: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({
          packs: [samplePack({ id: "osstack-core/loop-engineering", source_kind: "osstack_native" })],
        }), { status: 200 });
      },
    });

    expect(evidence).toMatchObject({
      status: "synced",
      packs: [expect.objectContaining({ id: "osstack-core/loop-engineering", source_kind: "osstack_native" })],
    });
    expect(requests).toEqual([{ authorization: "Bearer kst_sync_token" }]);
    const packs = await listCachedKnowledgePacks(cacheDir);
    const results = searchKnowledgePacks(packs, "proof evidence", { limit: 1 });
    expect(results[0]).toMatchObject({ pack_id: "osstack-core/loop-engineering" });
  });

  it("syncs tenant private packs from the private-packs endpoint", async () => {
    const cacheDir = join(tmp, "private-cache");
    const requests: Array<{ path: string; tenant_id?: string }> = [];
    const evidence = await syncKnowledgeCache({
      cacheDir,
      cloudUrl: "https://knowledge.osstack.ai",
      privatePacks: true,
      tenantId: "team_alpha",
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { tenant_id?: string };
        requests.push({
          path: new URL(String(url)).pathname,
          ...(body.tenant_id === undefined ? {} : { tenant_id: body.tenant_id }),
        });
        return new Response(JSON.stringify({
          packs: [samplePack({
            id: "team/private-runbook",
            name: "Team Private Runbook",
            source_kind: "internal",
            scope: "team",
            license: "Internal",
          })],
        }), { status: 200 });
      },
    });

    expect(evidence).toMatchObject({
      status: "synced",
      packs: [expect.objectContaining({ id: "team/private-runbook", source_kind: "internal" })],
    });
    expect(requests).toEqual([{ path: "/v1/private-packs", tenant_id: "team_alpha" }]);
    const packs = await listCachedKnowledgePacks(cacheDir);
    expect(packs[0]?.manifest).toMatchObject({ id: "team/private-runbook", scope: "team" });
  });

  it("rejects unsafe tenant ids before syncing private cloud packs", async () => {
    const cacheDir = join(tmp, "private-cache");
    let requested = false;

    const evidence = await syncKnowledgeCache({
      cacheDir,
      cloudUrl: "https://knowledge.osstack.ai",
      privatePacks: true,
      tenantId: "../team_alpha",
      fetchImpl: async () => {
        requested = true;
        return new Response(JSON.stringify({ packs: [] }), { status: 200 });
      },
    });

    expect(evidence).toMatchObject({
      status: "error",
      reason: "tenant_id is invalid",
      packs: [],
    });
    expect(requested).toBe(false);
  });

  it("falls back locally for cloud search with unsafe tenant ids", async () => {
    let requested = false;

    const evidence = await resolveKnowledgeSearch({
      mode: "cloud",
      query: "proof evidence",
      cloudUrl: "https://knowledge.osstack.ai",
      tenantId: "../team_alpha",
      packs: [{ manifest: validateKnowledgePackManifest(samplePack({ id: "osstack-core/local-fallback" })), path: "local-fallback.json" }],
      fetchImpl: async () => {
        requested = true;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
    });

    expect(evidence).toMatchObject({
      mode: "local",
      status: "recorded",
      reason: "tenant_id is invalid",
      results: expect.arrayContaining([expect.objectContaining({ pack_id: "osstack-core/local-fallback" })]),
    });
    expect(requested).toBe(false);
  });

  it("marks local fallback evidence stale when cached packs exceed the freshness window", async () => {
    const evidence = await resolveKnowledgeSearch({
      mode: "cloud",
      query: "proof evidence",
      cloudUrl: "https://knowledge.osstack.ai",
      staleAfterDays: 7,
      now: "2026-06-23T00:00:00.000Z",
      packs: [{
        manifest: validateKnowledgePackManifest(samplePack({
          id: "osstack-core/local-fallback",
          generated_at: "2026-06-01T00:00:00.000Z",
          last_reviewed_at: "2026-06-01T00:00:00.000Z",
        })),
        path: "local-fallback.json",
      }],
      fetchImpl: async () => {
        throw new Error("cloud offline");
      },
    });

    expect(evidence).toMatchObject({
      mode: "local",
      status: "recorded",
      fallback_mode: "local",
      reason: "cloud offline",
      cache_stale: true,
      cache_age_days: 22,
      cache_stale_after_days: 7,
    });
  });

  it("pins pack versions in the local cache", async () => {
    const cacheDir = join(tmp, "cache");

    const pin = await pinKnowledgePack(cacheDir, "osstack-core/loop-engineering@2026.06.22");

    expect(pin).toEqual({ pack_id: "osstack-core/loop-engineering", version: "2026.06.22" });
    expect(JSON.parse(await readFile(join(cacheDir, "pins.json"), "utf-8"))).toMatchObject({
      pins: [{ pack_id: "osstack-core/loop-engineering", version: "2026.06.22" }],
    });
  });

  it("enforces pinned pack versions during sync and local listing", async () => {
    const cacheDir = join(tmp, "cache");
    const packId = "osstack-core/loop-engineering";

    const initial = await syncKnowledgeCache({
      cacheDir,
      cloudUrl: "https://knowledge.osstack.ai",
      fetchImpl: async () => new Response(JSON.stringify({
        packs: [samplePack({ id: packId, version: "2026.06.22" })],
      }), { status: 200 }),
    });
    expect(initial).toMatchObject({
      status: "synced",
      packs: [expect.objectContaining({ id: packId, version: "2026.06.22" })],
    });

    await pinKnowledgePack(cacheDir, `${packId}@2026.06.22`);

    const afterPin = await syncKnowledgeCache({
      cacheDir,
      cloudUrl: "https://knowledge.osstack.ai",
      fetchImpl: async () => new Response(JSON.stringify({
        packs: [samplePack({
          id: packId,
          version: "2026.06.23",
          chunks: [{
            chunk_id: "chunk-new-version",
            title: "New version only",
            body: "This should not become visible while the old version is pinned.",
            tags: ["pin"],
          }],
        })],
      }), { status: 200 }),
    });

    expect(afterPin).toMatchObject({
      status: "synced",
      packs: [],
      skipped_pins: [expect.objectContaining({ id: packId, version: "2026.06.23" })],
    });
    await expect(readFile(join(cacheDir, "packs", "osstack-core__loop-engineering", "2026.06.23.json"), "utf-8"))
      .rejects.toThrow();

    const packs = await listCachedKnowledgePacks(cacheDir);
    expect(packs.map((pack) => `${pack.manifest.id}@${pack.manifest.version}`)).toEqual([
      `${packId}@2026.06.22`,
    ]);
    expect(searchKnowledgePacks(packs, "new version only", { limit: 1 })).toEqual([]);
  });

  it("prunes unpinned old cached versions with a dry-run default", async () => {
    const cacheDir = join(tmp, "cache");
    const packId = "osstack-core/loop-engineering";
    for (const version of ["2026.06.21", "2026.06.22", "2026.06.23"]) {
      await syncKnowledgeCache({
        cacheDir,
        cloudUrl: "https://knowledge.osstack.ai",
        fetchImpl: async () => new Response(JSON.stringify({
          packs: [samplePack({ id: packId, version })],
        }), { status: 200 }),
      });
    }
    await pinKnowledgePack(cacheDir, `${packId}@2026.06.22`);

    const dryRun = await pruneKnowledgeCache({ cacheDir });

    expect(dryRun).toMatchObject({
      mode: "dry-run",
      keep_versions: 1,
      removed: [expect.objectContaining({ id: packId, version: "2026.06.21" })],
      kept: expect.arrayContaining([
        expect.objectContaining({ id: packId, version: "2026.06.22" }),
        expect.objectContaining({ id: packId, version: "2026.06.23" }),
      ]),
    });
    await expect(readFile(join(cacheDir, "packs", "osstack-core__loop-engineering", "2026.06.21.json"), "utf-8"))
      .resolves.toContain("2026.06.21");

    const applied = await pruneKnowledgeCache({ cacheDir, apply: true });

    expect(applied).toMatchObject({
      mode: "applied",
      removed: [expect.objectContaining({ id: packId, version: "2026.06.21" })],
    });
    await expect(readFile(join(cacheDir, "packs", "osstack-core__loop-engineering", "2026.06.21.json"), "utf-8"))
      .rejects.toThrow();
    await expect(readFile(join(cacheDir, "packs", "osstack-core__loop-engineering", "2026.06.22.json"), "utf-8"))
      .resolves.toContain("2026.06.22");
    await expect(readFile(join(cacheDir, "packs", "osstack-core__loop-engineering", "2026.06.23.json"), "utf-8"))
      .resolves.toContain("2026.06.23");
  });

  it("records feedback locally and sends it to cloud when configured", async () => {
    const cacheDir = join(tmp, "cache");
    const calls: unknown[] = [];

    const entry = await cacheKnowledgeFeedback({
      cacheDir,
      chunkId: "chunk-loop-proof",
      rating: "useful",
      cloudUrl: "https://knowledge.osstack.ai",
      authToken: "kst_feedback_token",
      tenantId: "team_alpha",
      fetchImpl: async (_url, init) => {
        calls.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    expect(entry).toMatchObject({ chunk_id: "chunk-loop-proof", rating: "useful", status: "sent" });
    expect(calls).toEqual([{
      authorization: "Bearer kst_feedback_token",
      body: expect.objectContaining({ chunk_id: "chunk-loop-proof", rating: "useful", tenant_id: "team_alpha" }),
    }]);
    const feedbackLines = (await readFile(join(cacheDir, "feedback.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(feedbackLines).toMatchObject([
      expect.objectContaining({ chunk_id: "chunk-loop-proof", rating: "useful", status: "sent", tenant_id: "team_alpha" }),
    ]);
  });

  it("rejects unsafe tenant ids before caching feedback", async () => {
    const cacheDir = join(tmp, "cache");

    await expect(cacheKnowledgeFeedback({
      cacheDir,
      chunkId: "chunk-loop-proof",
      rating: "useful",
      tenantId: "../team_alpha",
    })).rejects.toThrow(/tenant_id is invalid/);
  });

  it("rejects knowledge pack index paths that escape the index root", () => {
    expect(() => validateKnowledgePackIndex({
      generated_at: "2026-06-22T00:00:00.000Z",
      channel: "official",
      packs: [{
        id: "osstack-core/escaped",
        version: "2026.06.22",
        path: "../escaped/manifest.json",
        scope: "official",
        source_kind: "osstack_native",
        quality_score: 90,
      }],
    })).toThrow(/knowledge pack index path is unsafe/);
  });

  it("ships official osstack packs with reviewed metadata and passing retrieval fixtures", async () => {
    const root = resolve(process.cwd(), "../..");
    const indexRoot = join(root, "knowledge-packs", "official");
    const index = await loadKnowledgePackIndex(join(indexRoot, "index.json"));
    const packPaths = index.packs.map((pack) => join(indexRoot, pack.path));
    const packs = await Promise.all(packPaths.map((path) => loadKnowledgePack(path)));
    const fixtures = JSON.parse(
      await readFile(join(root, "knowledge-evals/retrieval/osstack-core.json"), "utf-8"),
    ) as KnowledgeRetrievalEvalCase[];

    expect(index).toMatchObject({
      channel: "official",
      packs: expect.arrayContaining([
        expect.objectContaining({
          id: "osstack-core/architecture-control-plane",
          path: "architecture-control-plane/manifest.json",
        }),
        expect.objectContaining({
          id: "osstack-core/contract-validation",
          path: "contract-validation/manifest.json",
        }),
        expect.objectContaining({ id: "osstack-core/loop-engineering", path: "loop-engineering/manifest.json" }),
        expect.objectContaining({ id: "osstack-core/operations-runbook", path: "operations-runbook/manifest.json" }),
        expect.objectContaining({ id: "osstack-core/proof-and-scorecard", path: "proof-and-scorecard/manifest.json" }),
        expect.objectContaining({ id: "osstack-core/testing-and-eval", path: "testing-and-eval/manifest.json" }),
      ]),
    });
    expect(packs).toHaveLength(10);
    for (const [entryIndex, indexEntry] of index.packs.entries()) {
      const pack = packs[entryIndex];
      expect(pack).toBeDefined();
      if (pack === undefined) throw new Error(`missing official knowledge pack for ${indexEntry.id}`);
      expect(pack.manifest).toMatchObject({
        id: indexEntry.id,
        version: indexEntry.version,
        source_kind: indexEntry.source_kind,
        scope: indexEntry.scope,
        quality_score: indexEntry.quality_score,
        taxonomy: indexEntry.taxonomy,
      });
      expect(pack.manifest).toMatchObject({
        source_kind: "osstack_native",
        scope: "official",
        license: "Osstack-native",
        last_reviewed_at: expect.stringMatching(/^2026-06-2[23]T00:00:00\.000Z$/),
        source_provenance: expect.arrayContaining([expect.objectContaining({
          license: "Osstack-native",
          scope: "official",
          imported_at: expect.stringMatching(/^2026-06-2[23]T00:00:00\.000Z$/),
        })]),
      });
      for (const source of pack.manifest.source_provenance ?? []) {
        const sourceBytes = await readFile(join(root, source.path));
        expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(source.sha256);
      }
      expect(pack.manifest.quality_score).toBeGreaterThanOrEqual(89);
      expect(validateKnowledgePublishGate(pack.manifest)).toMatchObject({ ok: true, issues: [] });
    }
    expect(fixtures).toHaveLength(42);
    expect(evaluateKnowledgeRetrieval(packs, fixtures, { topK: 3 })).toMatchObject({
      total: 42,
      passed: 42,
      failed: 0,
    });
  });
});

function samplePack(overrides: Record<string, unknown> = {}) {
  return {
    id: "osstack-web-quality",
    version: "2026.06.22",
    name: "Osstack Web Quality Knowledge",
    license: "MIT-derived-processed",
    source_kind: "processed_mit",
    quality_score: 91,
    generated_at: "2026-06-22T00:00:00.000Z",
    source_attribution: ["curated from MIT-compatible engineering notes"],
    chunks: [
      {
        chunk_id: "chunk-frontend-governance",
        title: "Frontend governance checks",
        body: "Frontend governance should catch placeholder text, hardcoded template palettes, fake emoji icons, and inaccessible controls before proof generation.",
        tags: ["frontend", "governance"],
        source_refs: ["osstack-governance-v1"],
      },
      {
        chunk_id: "chunk-loop-proof",
        title: "Loop proof evidence",
        body: "Loop proof packs should include manifest checksums, verify results, policy decisions, and replayable events.",
        tags: ["proof", "loop"],
      },
    ],
    ...overrides,
  };
}
