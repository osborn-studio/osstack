import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeFeedbackEntry, KnowledgePack } from "@osstack/knowledge";
import { createKnowledgeCloudHandler, loadKnowledgeCloudPacksFromIndex } from "./index.js";

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await closeServer(server);
    server = undefined;
  }
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

function teamPack(
  overrides: Partial<KnowledgePack["manifest"]> = {},
  options: { omitTenant?: boolean } = {},
): KnowledgePack {
  const tenant = options.omitTenant === true ? {} : { tenant_id: "team_alpha" };
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
