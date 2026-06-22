import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
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
});
//# sourceMappingURL=bin.test.js.map