import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeCloudHandler, loadKnowledgeCloudPacksFromIndex } from "./index.js";
let server;
afterEach(async () => {
    if (server !== undefined) {
        await closeServer(server);
        server = undefined;
    }
});
describe("Knowledge Cloud HTTP service", () => {
    it("serves official pack metadata, sync manifests, and search results", async () => {
        const packs = await officialPacks();
        const feedback = [];
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
        });
        expect(feedbackResponse).toMatchObject({
            ok: true,
            feedback: {
                chunk_id: "proof-checksum-pack",
                rating: "useful",
                status: "sent",
                created_at: "2026-06-22T00:00:00.000Z",
            },
        });
        expect(feedback).toHaveLength(1);
    });
    it("serves tenant private packs separately while including them in search", async () => {
        const packs = await officialPacks();
        const privatePack = teamPack();
        const url = await startCloud({ packs, privatePacks: [privatePack] });
        const privateResponse = await fetchJson(`${url}/v1/private-packs`, { tenant_id: "team_alpha" });
        expect(privateResponse).toMatchObject({
            packs: [expect.objectContaining({ id: "team/private-runbook", source_kind: "internal" })],
        });
        const searchResponse = await fetchJson(`${url}/v1/search`, {
            query: "private release approval",
            limit: 3,
        });
        expect(searchResponse).toMatchObject({
            results: expect.arrayContaining([
                expect.objectContaining({
                    pack_id: "team/private-runbook",
                    chunk_id: "private-release",
                }),
            ]),
        });
    });
});
async function officialPacks() {
    const root = resolve(process.cwd(), "../..");
    return loadKnowledgeCloudPacksFromIndex(join(root, "knowledge-packs", "official", "index.json"));
}
async function startCloud(options) {
    server = createServer(createKnowledgeCloudHandler(options));
    await new Promise((resolveListen) => server?.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}
async function fetchJson(url, body) {
    const response = await fetch(url, body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    expect(response.ok).toBe(true);
    return response.json();
}
async function closeServer(target) {
    await new Promise((resolveClose, reject) => {
        target.close((error) => {
            if (error !== undefined)
                reject(error);
            else
                resolveClose();
        });
    });
}
function teamPack() {
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
            taxonomy: ["agent-operations/private-release"],
            chunks: [{
                    chunk_id: "private-release",
                    title: "Private release approval",
                    body: "Private team releases require approval notes, proof paths, and rollback ownership.",
                    tags: ["private", "release", "approval"],
                }],
        },
    };
}
//# sourceMappingURL=server.test.js.map