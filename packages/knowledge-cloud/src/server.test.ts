import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeFeedbackEntry, KnowledgePack } from "@osstack/knowledge";
import {
  createKnowledgeCloudHandler,
  loadKnowledgeCloudPacksFromIndex,
  loadPublishedKnowledgeCloudPacksFromDir,
} from "./index.js";

let server: Server | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  if (server !== undefined) {
    await closeServer(server);
    server = undefined;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Knowledge Cloud HTTP service", () => {
  it("serves official pack metadata, sync manifests, and search results", async () => {
    const packs = await officialPacks();
    const feedback: KnowledgeFeedbackEntry[] = [];
    const url = await startCloud({
      packs,
      now: () => "2026-06-22T00:00:00.000Z",
      feedbackSink: (entry) => {
        feedback.push(entry);
      },
    });

    const health = await fetchJson(`${url}/healthz`);
    expect(health).toMatchObject({
      ok: true,
      service: "osstack-knowledge-cloud",
      packs: 6,
      private_packs: 0,
    });

    const packsResponse = await fetchJson(`${url}/v1/packs`);
    expect(packsResponse).toMatchObject({
      packs: expect.arrayContaining([
        expect.objectContaining({ id: "osstack-core/loop-engineering", source_kind: "osstack_native" }),
      ]),
    });

    const syncResponse = await fetchJson(`${url}/v1/sync`, { client: "test" });
    expect(syncResponse).toMatchObject({
      packs: expect.arrayContaining([
        expect.objectContaining({
          id: "osstack-core/proof-and-scorecard",
          chunks: [expect.objectContaining({ chunk_id: "proof-checksum-pack" })],
        }),
      ]),
    });

    const searchResponse = await fetchJson(`${url}/v1/search`, {
      query: "proof pack checksum manifest",
      limit: 2,
    });
    expect(searchResponse).toMatchObject({
      packs: expect.arrayContaining([
        expect.objectContaining({ id: "osstack-core/proof-and-scorecard" }),
      ]),
      results: expect.arrayContaining([
        expect.objectContaining({
          pack_id: "osstack-core/proof-and-scorecard",
          chunk_id: "proof-checksum-pack",
        }),
      ]),
    });

    const feedbackResponse = await fetchJson(`${url}/v1/feedback`, {
      chunk_id: "proof-checksum-pack",
      rating: "useful",
      tenant_id: "team_alpha",
    }, {
      authorization: "Bearer kst_feedback_test",
    });
    expect(feedbackResponse).toMatchObject({
      ok: true,
      feedback: {
        chunk_id: "proof-checksum-pack",
        rating: "useful",
        status: "sent",
        tenant_id: "team_alpha",
        authorized: true,
        created_at: "2026-06-22T00:00:00.000Z",
      },
    });
    expect(feedback).toEqual([
      expect.objectContaining({
        chunk_id: "proof-checksum-pack",
        tenant_id: "team_alpha",
        authorized: true,
      }),
    ]);

    await fetchJson(`${url}/v1/feedback`, {
      chunk_id: "proof-checksum-pack",
      rating: "bad",
      tenant_id: "team_beta",
    });
    const feedbackSummary = await fetchJson(`${url}/v1/feedback/summary`, {
      tenant_id: "team_alpha",
    });
    expect(feedbackSummary).toMatchObject({
      total: 1,
      useful: 1,
      bad: 0,
      tenant_id: "team_alpha",
      chunks: [expect.objectContaining({
        chunk_id: "proof-checksum-pack",
        useful: 1,
        bad: 0,
      })],
    });
  });

  it("serves tenant private packs only to authorized matching tenants", async () => {
    const packs = await officialPacks();
    const privatePack = teamPack();
    const url = await startCloud({
      packs,
      privatePacks: [privatePack],
      privateAuthToken: "kst_private_test",
    });

    const unauthorized = await fetch(`${url}/v1/private-packs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "team_alpha" }),
    });
    expect(unauthorized.status).toBe(401);

    const wrongTenant = await fetchJson(
      `${url}/v1/private-packs`,
      { tenant_id: "team_beta" },
      { authorization: "Bearer kst_private_test" },
    );
    expect(wrongTenant).toMatchObject({ packs: [] });

    const privateResponse = await fetchJson(
      `${url}/v1/private-packs`,
      { tenant_id: "team_alpha" },
      { authorization: "Bearer kst_private_test" },
    );
    expect(privateResponse).toMatchObject({
      packs: [expect.objectContaining({ id: "team/private-runbook", source_kind: "internal" })],
    });

    const publicSearch = await fetchJson(`${url}/v1/search`, {
      query: "private release approval",
      limit: 3,
      tenant_id: "team_alpha",
    });
    expect(publicSearch).toMatchObject({
      results: expect.not.arrayContaining([
        expect.objectContaining({ pack_id: "team/private-runbook" }),
      ]),
    });

    const searchResponse = await fetchJson(
      `${url}/v1/search`,
      {
        query: "private release approval",
        limit: 3,
        tenant_id: "team_alpha",
      },
      { authorization: "Bearer kst_private_test" },
    );
    expect(searchResponse).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          pack_id: "team/private-runbook",
          chunk_id: "private-release",
        }),
      ]),
    });
  });

  it("enforces tenant-bound private tokens when configured", async () => {
    const url = await startCloud({
      packs: await officialPacks(),
      privatePacks: [teamPack()],
      privateTenantTokens: {
        team_alpha: "kst_alpha_private",
        team_beta: "kst_beta_private",
      },
    });

    const wrongTenantToken = await fetch(`${url}/v1/private-packs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer kst_beta_private",
      },
      body: JSON.stringify({ tenant_id: "team_alpha" }),
    });
    expect(wrongTenantToken.status).toBe(401);

    const privateResponse = await fetchJson(
      `${url}/v1/private-packs`,
      { tenant_id: "team_alpha" },
      { authorization: "Bearer kst_alpha_private" },
    );
    expect(privateResponse).toMatchObject({
      packs: [expect.objectContaining({ id: "team/private-runbook" })],
    });

    const searchWithWrongTenantToken = await fetchJson(
      `${url}/v1/search`,
      {
        query: "private release approval",
        tenant_id: "team_alpha",
      },
      { authorization: "Bearer kst_beta_private" },
    );
    expect(searchWithWrongTenantToken).toMatchObject({
      results: expect.not.arrayContaining([
        expect.objectContaining({ pack_id: "team/private-runbook" }),
      ]),
    });
  });

  it("does not let one tenant token authorize another tenant without an explicit token", async () => {
    const url = await startCloud({
      packs: await officialPacks(),
      privatePacks: [teamPack({}, { tenantId: "team_gamma" })],
      privateTenantTokens: {
        team_alpha: "kst_alpha_private",
      },
    });

    const crossTenant = await fetch(`${url}/v1/private-packs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer kst_alpha_private",
      },
      body: JSON.stringify({ tenant_id: "team_gamma" }),
    });

    expect(crossTenant.status).toBe(401);
  });

  it("requires an explicit tenant before returning private packs", async () => {
    const url = await startCloud({
      packs: await officialPacks(),
      privatePacks: [teamPack({}, { omitTenant: true })],
      privateAuthToken: "kst_private_test",
    });

    const missingTenant = await fetch(`${url}/v1/private-packs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer kst_private_test",
      },
      body: JSON.stringify({}),
    });
    expect(missingTenant.status).toBe(400);
    await expect(missingTenant.json()).resolves.toMatchObject({
      error: "private knowledge packs require tenant_id",
    });

    const searchWithoutTenant = await fetchJson(
      `${url}/v1/search`,
      {
        query: "private release approval",
        limit: 3,
      },
      { authorization: "Bearer kst_private_test" },
    );
    expect(searchWithoutTenant).toMatchObject({
      results: expect.not.arrayContaining([
        expect.objectContaining({ pack_id: "team/private-runbook" }),
      ]),
    });
  });

  it("publishes reviewed official packs through the cloud publish gate", async () => {
    const url = await startCloud({ packs: await officialPacks() });
    const unreviewed = await fetch(`${url}/v1/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pack: reviewedOfficialPack({
          review: {
            status: "changes_requested",
            reviewer_id: "knowledge-reviewer",
            reviewed_at: "2026-06-22T00:00:00.000Z",
            summary: "Needs rewrite before publication.",
          },
        }),
      }),
    });
    expect(unreviewed.status).toBe(400);
    await expect(unreviewed.json()).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "official_review_not_approved" })],
    });

    const published = await fetchJson(`${url}/v1/publish`, {
      pack: reviewedOfficialPack(),
    });
    expect(published).toMatchObject({
      ok: true,
      private: false,
      pack: expect.objectContaining({ id: "osstack-core/cloud-publish" }),
    });

    const search = await fetchJson(`${url}/v1/search`, {
      query: "cloud publish approved review",
      limit: 1,
    });
    expect(search).toMatchObject({
      results: [expect.objectContaining({
        pack_id: "osstack-core/cloud-publish",
        chunk_id: "cloud-publish-review",
      })],
    });
  });

  it("publishes tenant private packs only with the target tenant token", async () => {
    const url = await startCloud({
      packs: await officialPacks(),
      privateTenantTokens: { team_alpha: "kst_alpha_private" },
    });
    const pack = teamPack({
      id: "team/private-published",
      chunks: [{
        chunk_id: "private-published-review",
        title: "Private published runbook",
        body: "Private published runbooks include approved review notes and tenant-scoped release evidence.",
        tags: ["private", "publish", "review"],
      }],
    });

    const unauthorized = await fetch(`${url}/v1/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pack }),
    });
    expect(unauthorized.status).toBe(401);

    const published = await fetchJson(
      `${url}/v1/publish`,
      { pack },
      { authorization: "Bearer kst_alpha_private" },
    );
    expect(published).toMatchObject({
      ok: true,
      private: true,
      tenant_id: "team_alpha",
      pack: expect.objectContaining({ id: "team/private-published" }),
    });

    const search = await fetchJson(
      `${url}/v1/search`,
      {
        query: "tenant scoped release evidence",
        tenant_id: "team_alpha",
        limit: 1,
      },
      { authorization: "Bearer kst_alpha_private" },
    );
    expect(search).toMatchObject({
      results: [expect.objectContaining({ pack_id: "team/private-published" })],
    });
  });

  it("persists published packs and reloads them after restart", async () => {
    const publishedPackDir = tempDir();
    let url = await startCloud({
      packs: await officialPacks(),
      privateTenantTokens: { team_alpha: "kst_alpha_private" },
      publishedPackDir,
    });
    await fetchJson(`${url}/v1/publish`, {
      pack: reviewedOfficialPack({
        id: "osstack-core/persisted-cloud-publish",
        chunks: [{
          chunk_id: "persisted-cloud-publish-review",
          title: "Persisted cloud publish review",
          body: "Osstack Knowledge Cloud persists approved publish artifacts so restarted services can search reviewed packs.",
          tags: ["cloud", "publish", "persisted"],
          source_refs: ["cloud-publish"],
        }],
      }),
    });
    const privatePack = teamPack({
      id: "team/private-persisted",
      chunks: [{
        chunk_id: "private-persisted-review",
        title: "Private persisted runbook",
        body: "Private persisted Osstack runbooks keep alpha vault rotation notes scoped to tenant authorization.",
        tags: ["private", "persisted", "review"],
      }],
    });
    await fetchJson(
      `${url}/v1/publish`,
      { pack: privatePack },
      { authorization: "Bearer kst_alpha_private" },
    );
    await closeServer(server!);
    server = undefined;

    await expect(readdir(join(publishedPackDir, "official"))).resolves.toEqual([
      "osstack-core%2Fpersisted-cloud-publish.json",
    ]);
    await expect(readdir(join(publishedPackDir, "private", "team_alpha"))).resolves.toEqual([
      "team%2Fprivate-persisted.json",
    ]);

    const persisted = await loadPublishedKnowledgeCloudPacksFromDir(publishedPackDir);
    url = await startCloud({
      packs: [...await officialPacks(), ...persisted.packs],
      privatePacks: persisted.privatePacks,
      privateTenantTokens: { team_alpha: "kst_alpha_private" },
    });

    const officialSearch = await fetchJson(`${url}/v1/search`, {
      query: "restarted services can search reviewed packs",
      limit: 1,
    });
    expect(officialSearch).toMatchObject({
      results: [expect.objectContaining({ pack_id: "osstack-core/persisted-cloud-publish" })],
    });

    const unauthorizedPrivateSearch = await fetchJson(`${url}/v1/search`, {
      query: "alpha vault rotation notes",
      tenant_id: "team_alpha",
      limit: 1,
    });
    expect(unauthorizedPrivateSearch).toMatchObject({ results: [] });

    const privateSearch = await fetchJson(
      `${url}/v1/search`,
      {
        query: "alpha vault rotation notes",
        tenant_id: "team_alpha",
        limit: 1,
      },
      { authorization: "Bearer kst_alpha_private" },
    );
    expect(privateSearch).toMatchObject({
      results: [expect.objectContaining({ pack_id: "team/private-persisted" })],
    });
  });
});

async function officialPacks(): Promise<KnowledgePack[]> {
  const root = resolve(process.cwd(), "../..");
  return loadKnowledgeCloudPacksFromIndex(join(root, "knowledge-packs", "official", "index.json"));
}

async function startCloud(options: Parameters<typeof createKnowledgeCloudHandler>[0]): Promise<string> {
  server = createServer(createKnowledgeCloudHandler(options));
  await new Promise<void>((resolveListen) => server?.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function fetchJson(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, body === undefined
    ? undefined
    : {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  expect(response.ok).toBe(true);
  return response.json() as Promise<unknown>;
}

async function closeServer(target: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    target.close((error) => {
      if (error !== undefined) reject(error);
      else resolveClose();
    });
  });
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "osstack-knowledge-cloud-published-"));
  tempDirs.push(dir);
  return dir;
}

function teamPack(
  overrides: Partial<KnowledgePack["manifest"]> = {},
  options: { omitTenant?: boolean; tenantId?: string } = {},
): KnowledgePack {
  const tenant = options.omitTenant === true ? {} : { tenant_id: options.tenantId ?? "team_alpha" };
  return {
    path: "memory://team/private-runbook",
    manifest: {
      id: "team/private-runbook",
      version: "2026.06.22",
      name: "Team Private Runbook",
      license: "Internal",
      source_kind: "internal",
      quality_score: 82,
      scope: "team",
      ...tenant,
      taxonomy: ["agent-operations/private-release"],
      chunks: [{
        chunk_id: "private-release",
        title: "Private release approval",
        body: "Private team releases require approval notes, proof paths, and rollback ownership.",
        tags: ["private", "release", "approval"],
      }],
      ...overrides,
    },
  };
}

function reviewedOfficialPack(
  overrides: Partial<KnowledgePack["manifest"]> = {},
): KnowledgePack["manifest"] {
  return {
    id: "osstack-core/cloud-publish",
    version: "2026.06.22",
    name: "Osstack Cloud Publish",
    license: "Osstack-native",
    source_kind: "osstack_native",
    quality_score: 91,
    scope: "official",
    taxonomy: ["osstack-core/knowledge-cloud"],
    generated_at: "2026-06-22T00:00:00.000Z",
    last_reviewed_at: "2026-06-22T00:00:00.000Z",
    review: {
      status: "approved",
      reviewer_id: "knowledge-reviewer",
      reviewed_at: "2026-06-22T00:00:00.000Z",
      summary: "Reviewed for cloud publication.",
    },
    source_attribution: ["osstack-native product knowledge"],
    source_provenance: [{
      source_id: "cloud-publish",
      path: "cloud-publish.md",
      sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      license: "Osstack-native",
      scope: "official",
      imported_at: "2026-06-22T00:00:00.000Z",
    }],
    chunks: [{
      chunk_id: "cloud-publish-review",
      title: "Cloud publish review",
      body: "Osstack Knowledge Cloud publish gates require approved review metadata, source provenance, and proof-friendly pack evidence.",
      tags: ["cloud", "publish", "review"],
      source_refs: ["cloud-publish"],
    }],
    ...overrides,
  };
}
