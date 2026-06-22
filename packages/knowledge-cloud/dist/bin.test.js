import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";
let logs;
let errors;
let originalOnce;
beforeEach(() => {
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
afterEach(() => {
    vi.restoreAllMocks();
    if (originalOnce === undefined) {
        delete process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"];
    }
    else {
        process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] = originalOnce;
    }
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
});
//# sourceMappingURL=bin.test.js.map