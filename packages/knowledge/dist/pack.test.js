import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleKnowledgeSnippet, loadKnowledgePack, resolveKnowledgeSearch, searchKnowledgePacks, validateKnowledgePackManifest, } from "./index.js";
let tmp;
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
    it("searches local packs and assembles prompt snippets", async () => {
        const path = join(tmp, "pack.json");
        await writeFile(path, JSON.stringify(samplePack(), null, 2));
        const pack = await loadKnowledgePack(path);
        const results = searchKnowledgePacks([pack], "frontend governance", { limit: 2 });
        expect(results[0]).toMatchObject({
            pack_id: "osstack-web-quality",
            chunk_id: "chunk-frontend-governance",
            title: "Frontend governance checks",
        });
        expect(assembleKnowledgeSnippet(results)).toContain("pack=osstack-web-quality@2026.06.22");
    });
    it("uses cloud search when a cloud endpoint returns osstack-native results", async () => {
        const fetchImpl = async () => new Response(JSON.stringify({
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
                }],
        }), { status: 200 });
        const evidence = await resolveKnowledgeSearch({
            mode: "cloud",
            query: "ui guidance",
            cloudUrl: "https://knowledge.osstack.ai",
            fetchImpl,
        });
        expect(evidence).toMatchObject({
            mode: "cloud",
            status: "recorded",
            packs: [expect.objectContaining({ id: "osstack-cloud-web", source_kind: "osstack_native" })],
            results: [expect.objectContaining({ chunk_id: "chunk-cloud-ui" })],
        });
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
});
function samplePack() {
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
    };
}
//# sourceMappingURL=pack.test.js.map