import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeCloudHandler, loadKnowledgeCloudPacksFromIndex, loadPublishedKnowledgeCloudPacksFromDir, } from "./index.js";
let server;
const tempDirs = [];
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
    it("clamps search limits to production-safe bounds", async () => {
        const url = await startCloud({
            packs: Array.from({ length: 60 }, (_value, index) => memorySearchPack(index + 1)),
        });
        const negativeLimit = await fetchJson(`${url}/v1/search`, {
            query: "osstack limit clamp",
            limit: -5,
        });
        expect(negativeLimit.results).toHaveLength(1);
        const hugeLimit = await fetchJson(`${url}/v1/search`, {
            query: "osstack limit clamp",
            limit: 999,
        });
        expect(hugeLimit.results).toHaveLength(50);
    });
    it("returns bad request for malformed JSON bodies", async () => {
        const url = await startCloud({ packs: await officialPacks() });
        const response = await fetch(`${url}/v1/search`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{\"query\":",
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: "invalid JSON body",
        });
    });
    it("rejects oversized JSON request bodies", async () => {
        const url = await startCloud({ packs: await officialPacks() });
        const response = await fetch(`${url}/v1/search`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                query: "proof",
                padding: "x".repeat(1024 * 1024),
            }),
        });
        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({
            error: "request body too large",
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
        const wrongTenant = await fetchJson(`${url}/v1/private-packs`, { tenant_id: "team_beta" }, { authorization: "Bearer kst_private_test" });
        expect(wrongTenant).toMatchObject({ packs: [] });
        const privateResponse = await fetchJson(`${url}/v1/private-packs`, { tenant_id: "team_alpha" }, { authorization: "Bearer kst_private_test" });
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
        const searchResponse = await fetchJson(`${url}/v1/search`, {
            query: "private release approval",
            limit: 3,
            tenant_id: "team_alpha",
        }, { authorization: "Bearer kst_private_test" });
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
        const privateResponse = await fetchJson(`${url}/v1/private-packs`, { tenant_id: "team_alpha" }, { authorization: "Bearer kst_alpha_private" });
        expect(privateResponse).toMatchObject({
            packs: [expect.objectContaining({ id: "team/private-runbook" })],
        });
        const searchWithWrongTenantToken = await fetchJson(`${url}/v1/search`, {
            query: "private release approval",
            tenant_id: "team_alpha",
        }, { authorization: "Bearer kst_beta_private" });
        expect(searchWithWrongTenantToken).toMatchObject({
            results: expect.not.arrayContaining([
                expect.objectContaining({ pack_id: "team/private-runbook" }),
            ]),
        });
    });
    it("rejects unauthorized tenant feedback before it can pollute tenant summaries", async () => {
        const url = await startCloud({
            packs: await officialPacks(),
            privateTenantTokens: {
                team_alpha: "kst_alpha_private",
            },
            now: () => "2026-06-22T00:00:00.000Z",
        });
        const unauthorizedFeedback = await fetch(`${url}/v1/feedback`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                chunk_id: "private-release",
                rating: "bad",
                tenant_id: "team_alpha",
            }),
        });
        expect(unauthorizedFeedback.status).toBe(401);
        const feedbackSummary = await fetchJson(`${url}/v1/feedback/summary`, { tenant_id: "team_alpha" }, { authorization: "Bearer kst_alpha_private" });
        expect(feedbackSummary).toMatchObject({
            total: 0,
            useful: 0,
            bad: 0,
            tenant_id: "team_alpha",
            chunks: [],
        });
        const tenantAudit = await fetchJson(`${url}/v1/audit`, { tenant_id: "team_alpha", action: "feedback", status: "unauthorized" }, { authorization: "Bearer kst_alpha_private" });
        expect(tenantAudit).toMatchObject({
            events: [expect.objectContaining({
                    action: "feedback",
                    status: "unauthorized",
                    tenant_id: "team_alpha",
                    chunk_id: "private-release",
                    rating: "bad",
                    authorized: false,
                })],
        });
    });
    it("requires tenant authorization before reading tenant feedback summaries", async () => {
        const url = await startCloud({
            packs: await officialPacks(),
            privateTenantTokens: {
                team_alpha: "kst_alpha_private",
            },
            now: () => "2026-06-22T00:00:00.000Z",
        });
        await fetchJson(`${url}/v1/feedback`, {
            chunk_id: "private-release",
            rating: "useful",
            tenant_id: "team_alpha",
        }, { authorization: "Bearer kst_alpha_private" });
        const unauthorizedSummary = await fetch(`${url}/v1/feedback/summary`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tenant_id: "team_alpha" }),
        });
        expect(unauthorizedSummary.status).toBe(401);
        const authorizedSummary = await fetchJson(`${url}/v1/feedback/summary`, { tenant_id: "team_alpha" }, { authorization: "Bearer kst_alpha_private" });
        expect(authorizedSummary).toMatchObject({
            total: 1,
            useful: 1,
            bad: 0,
            tenant_id: "team_alpha",
            chunks: [expect.objectContaining({
                    chunk_id: "private-release",
                    useful: 1,
                })],
        });
    });
    it("excludes tenant feedback from public feedback summaries", async () => {
        const url = await startCloud({
            packs: await officialPacks(),
            privateTenantTokens: {
                team_alpha: "kst_alpha_private",
            },
            now: () => "2026-06-22T00:00:00.000Z",
        });
        await fetchJson(`${url}/v1/feedback`, {
            chunk_id: "official-runbook",
            rating: "useful",
        });
        await fetchJson(`${url}/v1/feedback`, {
            chunk_id: "private-release",
            rating: "bad",
            tenant_id: "team_alpha",
        }, { authorization: "Bearer kst_alpha_private" });
        const publicSummary = await fetchJson(`${url}/v1/feedback/summary`, {});
        expect(publicSummary).toMatchObject({
            total: 1,
            useful: 1,
            bad: 0,
            chunks: [expect.objectContaining({
                    chunk_id: "official-runbook",
                    useful: 1,
                })],
        });
        expect(JSON.stringify(publicSummary)).not.toContain("private-release");
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
        const searchWithoutTenant = await fetchJson(`${url}/v1/search`, {
            query: "private release approval",
            limit: 3,
        }, { authorization: "Bearer kst_private_test" });
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
    it("serves a public review queue for official packs that still need review", async () => {
        const url = await startCloud({
            packs: [
                packFromManifest(reviewedOfficialPack()),
                packFromManifest(reviewedOfficialPack({
                    id: "osstack-core/needs-rewrite",
                    name: "Needs Rewrite",
                    review: {
                        status: "changes_requested",
                        reviewer_id: "knowledge-reviewer",
                        reviewed_at: "2026-06-22T00:00:00.000Z",
                        summary: "Rewrite upstream phrasing before publication.",
                    },
                })),
                packFromManifest(unreviewedOfficialPack({
                    id: "osstack-core/missing-review",
                    name: "Missing Review",
                })),
            ],
            privatePacks: [teamPack()],
        });
        const queue = await fetchJson(`${url}/v1/review/queue`, {});
        expect(queue).toMatchObject({
            scope: "official",
            total: 2,
            items: [
                expect.objectContaining({
                    pack_id: "osstack-core/missing-review",
                    review_status: "missing",
                    scope: "official",
                    chunk_count: 1,
                    source_count: 1,
                }),
                expect.objectContaining({
                    pack_id: "osstack-core/needs-rewrite",
                    review_status: "changes_requested",
                    reviewer_id: "knowledge-reviewer",
                    review_summary: "Rewrite upstream phrasing before publication.",
                }),
            ],
        });
        expect(JSON.stringify(queue)).not.toContain("team/private-runbook");
    });
    it("serves tenant review queues only to authorized tenant tokens", async () => {
        const url = await startCloud({
            packs: await officialPacks(),
            privatePacks: [
                teamPack({
                    id: "team/alpha-needs-review",
                    review: {
                        status: "changes_requested",
                        reviewer_id: "team-reviewer",
                        reviewed_at: "2026-06-22T00:00:00.000Z",
                        summary: "Add rollback owner before reuse.",
                    },
                }),
                teamPack({ id: "team/beta-private" }, { tenantId: "team_beta" }),
            ],
            privateTenantTokens: {
                team_alpha: "kst_alpha_private",
                team_beta: "kst_beta_private",
            },
        });
        const unauthorized = await fetch(`${url}/v1/review/queue`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tenant_id: "team_alpha" }),
        });
        expect(unauthorized.status).toBe(401);
        const tenantQueue = await fetchJson(`${url}/v1/review/queue`, { tenant_id: "team_alpha" }, { authorization: "Bearer kst_alpha_private" });
        expect(tenantQueue).toMatchObject({
            scope: "tenant",
            tenant_id: "team_alpha",
            total: 1,
            items: [expect.objectContaining({
                    pack_id: "team/alpha-needs-review",
                    review_status: "changes_requested",
                    tenant_id: "team_alpha",
                })],
        });
        expect(JSON.stringify(tenantQueue)).not.toContain("team/beta-private");
    });
    it("can include approved packs in the review queue for audit views", async () => {
        const url = await startCloud({
            packs: [packFromManifest(reviewedOfficialPack())],
        });
        const queue = await fetchJson(`${url}/v1/review/queue`, { status: "all" });
        expect(queue).toMatchObject({
            scope: "official",
            total: 1,
            items: [expect.objectContaining({
                    pack_id: "osstack-core/cloud-publish",
                    review_status: "approved",
                    reviewer_id: "knowledge-reviewer",
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
        const published = await fetchJson(`${url}/v1/publish`, { pack }, { authorization: "Bearer kst_alpha_private" });
        expect(published).toMatchObject({
            ok: true,
            private: true,
            tenant_id: "team_alpha",
            pack: expect.objectContaining({ id: "team/private-published" }),
        });
        const search = await fetchJson(`${url}/v1/search`, {
            query: "tenant scoped release evidence",
            tenant_id: "team_alpha",
            limit: 1,
        }, { authorization: "Bearer kst_alpha_private" });
        expect(search).toMatchObject({
            results: [expect.objectContaining({ pack_id: "team/private-published" })],
        });
    });
    it("rejects unsafe tenant ids before private publish authorization or persistence", async () => {
        const url = await startCloud({
            packs: await officialPacks(),
            privateTenantTokens: { team_alpha: "kst_alpha_private" },
        });
        const response = await fetch(`${url}/v1/publish`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer kst_alpha_private",
            },
            body: JSON.stringify({
                pack: teamPack({}, { tenantId: "../escape" }),
            }),
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: "tenant_id is invalid",
        });
    });
    it("records tenant-scoped audit events for publish, private access, search, and feedback", async () => {
        const auditEvents = [];
        const url = await startCloud({
            packs: await officialPacks(),
            privateTenantTokens: { team_alpha: "kst_alpha_private" },
            now: () => "2026-06-22T00:00:00.000Z",
            auditSink: (entry) => {
                auditEvents.push(entry);
            },
        });
        await fetchJson(`${url}/v1/publish`, {
            pack: reviewedOfficialPack(),
        });
        await fetchJson(`${url}/v1/publish`, { pack: teamPack({ id: "team/audited-private-pack" }) }, { authorization: "Bearer kst_alpha_private" });
        await fetchJson(`${url}/v1/private-packs`, { tenant_id: "team_alpha" }, { authorization: "Bearer kst_alpha_private" });
        await fetchJson(`${url}/v1/search`, {
            query: "private release approval",
            tenant_id: "team_alpha",
            limit: 2,
        }, { authorization: "Bearer kst_alpha_private" });
        await fetchJson(`${url}/v1/feedback`, {
            chunk_id: "private-release",
            rating: "useful",
            tenant_id: "team_alpha",
        }, { authorization: "Bearer kst_alpha_private" });
        expect(auditEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                event_id: "audit-1",
                action: "publish",
                status: "ok",
                private: false,
                pack_id: "osstack-core/cloud-publish",
            }),
            expect.objectContaining({
                action: "publish",
                status: "ok",
                private: true,
                tenant_id: "team_alpha",
                pack_id: "team/audited-private-pack",
            }),
            expect.objectContaining({
                action: "private_packs",
                status: "ok",
                tenant_id: "team_alpha",
                authorized: true,
            }),
            expect.objectContaining({
                action: "search",
                status: "ok",
                tenant_id: "team_alpha",
                authorized: true,
                result_count: 2,
            }),
            expect.objectContaining({
                action: "feedback",
                status: "ok",
                tenant_id: "team_alpha",
                chunk_id: "private-release",
                rating: "useful",
            }),
        ]));
        const publicAudit = await fetchJson(`${url}/v1/audit`, {});
        expect(publicAudit).toMatchObject({
            events: [expect.objectContaining({
                    action: "publish",
                    private: false,
                    pack_id: "osstack-core/cloud-publish",
                })],
        });
        expect(publicAudit).toMatchObject({
            events: expect.not.arrayContaining([
                expect.objectContaining({ tenant_id: "team_alpha" }),
            ]),
        });
        const unauthorizedTenantAudit = await fetch(`${url}/v1/audit`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tenant_id: "team_alpha" }),
        });
        expect(unauthorizedTenantAudit.status).toBe(401);
        const tenantAudit = await fetchJson(`${url}/v1/audit`, { tenant_id: "team_alpha" }, { authorization: "Bearer kst_alpha_private" });
        expect(tenantAudit).toMatchObject({
            tenant_id: "team_alpha",
            events: expect.arrayContaining([
                expect.objectContaining({ action: "publish", pack_id: "team/audited-private-pack" }),
                expect.objectContaining({ action: "private_packs", authorized: true }),
                expect.objectContaining({ action: "search", result_count: 2 }),
                expect.objectContaining({ action: "feedback", chunk_id: "private-release" }),
            ]),
        });
        const filteredTenantAudit = await fetchJson(`${url}/v1/audit`, {
            tenant_id: "team_alpha",
            action: "search",
            status: "ok",
            limit: 1,
        }, { authorization: "Bearer kst_alpha_private" });
        expect(filteredTenantAudit).toMatchObject({
            tenant_id: "team_alpha",
            filters: {
                action: "search",
                status: "ok",
                limit: 1,
            },
            events: [
                expect.objectContaining({
                    action: "search",
                    status: "ok",
                    tenant_id: "team_alpha",
                    result_count: 2,
                }),
            ],
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
        await fetchJson(`${url}/v1/publish`, { pack: privatePack }, { authorization: "Bearer kst_alpha_private" });
        await closeServer(server);
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
        const privateSearch = await fetchJson(`${url}/v1/search`, {
            query: "alpha vault rotation notes",
            tenant_id: "team_alpha",
            limit: 1,
        }, { authorization: "Bearer kst_alpha_private" });
        expect(privateSearch).toMatchObject({
            results: [expect.objectContaining({ pack_id: "team/private-persisted" })],
        });
    });
    it("rejects persisted private packs whose tenant id does not match the storage directory", async () => {
        const publishedPackDir = tempDir();
        const privateDir = join(publishedPackDir, "private", "team_alpha");
        await mkdir(privateDir, { recursive: true });
        await writeFile(join(privateDir, "team%2Fwrong-tenant.json"), `${JSON.stringify(teamPack({ id: "team/wrong-tenant" }, { tenantId: "team_beta" }).manifest, null, 2)}\n`, "utf-8");
        await expect(loadPublishedKnowledgeCloudPacksFromDir(publishedPackDir))
            .rejects.toThrow(/tenant_id does not match persisted private directory/);
    });
    it("rejects private packs persisted in the official storage directory", async () => {
        const publishedPackDir = tempDir();
        const officialDir = join(publishedPackDir, "official");
        await mkdir(officialDir, { recursive: true });
        await writeFile(join(officialDir, "team%2Fwrong-official.json"), `${JSON.stringify(teamPack({ id: "team/wrong-official" }).manifest, null, 2)}\n`, "utf-8");
        await expect(loadPublishedKnowledgeCloudPacksFromDir(publishedPackDir))
            .rejects.toThrow(/official persisted pack cannot be private/);
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
async function fetchJson(url, body, headers = {}) {
    const response = await fetch(url, body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
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
function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "osstack-knowledge-cloud-published-"));
    tempDirs.push(dir);
    return dir;
}
function teamPack(overrides = {}, options = {}) {
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
function packFromManifest(manifest) {
    return {
        path: `memory://${manifest.id}`,
        manifest,
    };
}
function memorySearchPack(index) {
    return {
        path: `memory://search-limit/${index}`,
        manifest: {
            id: `osstack-core/search-limit-${index}`,
            version: "2026.06.22",
            name: `Search Limit ${index}`,
            license: "Osstack-native",
            source_kind: "osstack_native",
            quality_score: 90,
            scope: "official",
            chunks: [{
                    chunk_id: `search-limit-${index}`,
                    title: `Search Limit ${index}`,
                    body: "Osstack limit clamp guidance for Knowledge Cloud search result bounds.",
                }],
        },
    };
}
function reviewedOfficialPack(overrides = {}) {
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
function unreviewedOfficialPack(overrides = {}) {
    const { review: _review, last_reviewed_at: _lastReviewedAt, ...manifest } = reviewedOfficialPack(overrides);
    return manifest;
}
//# sourceMappingURL=server.test.js.map