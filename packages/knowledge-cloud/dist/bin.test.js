import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./bin.js";
let logs;
let errors;
let originalOnce;
let tmp;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "osstack-knowledge-cloud-bin-"));
    logs = [];
    errors = [];
    originalOnce = process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"];
    vi.spyOn(console, "log").mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
        errors.push(args.map(String).join(" "));
    });
});
afterEach(async () => {
    vi.restoreAllMocks();
    if (originalOnce === undefined) {
        delete process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"];
    }
    else {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = originalOnce;
    }
    await rm(tmp, { recursive: true, force: true });
});
describe("osstack-knowledge-cloud bin", () => {
    it("prints help", async () => {
        const exitCode = await main(["--help"]);
        expect(exitCode).toBe(0);
        expect(logs.join("\n")).toContain("osstack-knowledge-cloud");
        expect(logs.join("\n")).toContain("--official-index");
        expect(logs.join("\n")).toContain("--published-pack-dir");
    });
    it("rejects invalid ports", async () => {
        const exitCode = await main(["--port", "99999"]);
        expect(exitCode).toBe(1);
        expect(errors.join("\n")).toContain("--port must be an integer");
    });
    it("starts from the official index and prints startup metadata", async () => {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = "1";
        const exitCode = await main(["--port", "0", "--json"]);
        expect(exitCode).toBe(0);
        const output = JSON.parse(logs.join("\n"));
        expect(output).toMatchObject({
            packs: 6,
            private_packs: 0,
            private_auth_required: false,
        });
        expect(output.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
    it("reports private auth when a private token is configured", async () => {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = "1";
        const exitCode = await main(["--port", "0", "--private-token", "kst_private_test", "--json"]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
            packs: 6,
            private_packs: 0,
            private_auth_required: true,
        });
    });
    it("reports tenant-bound private auth when tenant tokens are configured", async () => {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = "1";
        const exitCode = await main([
            "--port",
            "0",
            "--private-tenant-token",
            "team_alpha=kst_alpha_private",
            "--private-tenant-token",
            "team_beta=kst_beta_private",
            "--json",
        ]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
            private_auth_required: true,
            private_tenant_tokens: 2,
        });
    });
    it("configures a feedback JSONL audit log path", async () => {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = "1";
        const feedbackLog = join(tmp, "audit", "feedback.jsonl");
        const exitCode = await main(["--port", "0", "--feedback-log", feedbackLog, "--json"]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
            feedback_log: feedbackLog,
        });
        await expect(readFile(feedbackLog, "utf-8")).resolves.toBe("");
    });
    it("preloads existing feedback JSONL entries for summaries", async () => {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = "1";
        const feedbackLog = join(tmp, "audit", "feedback.jsonl");
        await mkdir(join(tmp, "audit"), { recursive: true });
        await writeFile(feedbackLog, `${JSON.stringify({
            chunk_id: "proof-checksum-pack",
            rating: "useful",
            status: "sent",
            created_at: "2026-06-22T00:00:00.000Z",
            tenant_id: "team_alpha",
            authorized: true,
        })}\n`, "utf-8");
        const exitCode = await main(["--port", "0", "--feedback-log", feedbackLog, "--json"]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
            feedback_log: feedbackLog,
            feedback_log_loaded: 1,
        });
    });
    it("preloads published pack storage on startup", async () => {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = "1";
        const publishedPackDir = join(tmp, "published-packs");
        await mkdir(join(publishedPackDir, "official"), { recursive: true });
        await writeFile(join(publishedPackDir, "official", "osstack-core%2Fpublished-startup.json"), JSON.stringify({
            id: "osstack-core/published-startup",
            version: "2026.06.22",
            name: "Published Startup Pack",
            license: "Osstack-native",
            source_kind: "osstack_native",
            quality_score: 90,
            scope: "official",
            taxonomy: ["osstack-core/knowledge-cloud"],
            last_reviewed_at: "2026-06-22T00:00:00.000Z",
            review: {
                status: "approved",
                reviewer_id: "knowledge-reviewer",
                reviewed_at: "2026-06-22T00:00:00.000Z",
                summary: "Approved persisted startup pack.",
            },
            source_attribution: ["osstack-native product knowledge"],
            source_provenance: [{
                    source_id: "published-startup",
                    path: "published-startup.md",
                    sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                    license: "Osstack-native",
                    scope: "official",
                    imported_at: "2026-06-22T00:00:00.000Z",
                }],
            chunks: [{
                    chunk_id: "published-startup-pack",
                    title: "Published startup pack",
                    body: "Osstack Knowledge Cloud reloads approved published packs from persistent startup storage.",
                    tags: ["published", "startup"],
                    source_refs: ["published-startup"],
                }],
        }, null, 2), "utf-8");
        const exitCode = await main(["--port", "0", "--published-pack-dir", publishedPackDir, "--json"]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
            packs: 7,
            published_pack_dir: publishedPackDir,
            published_packs_loaded: 1,
            published_private_packs_loaded: 0,
        });
    });
});
//# sourceMappingURL=bin.test.js.map