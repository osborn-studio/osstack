import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateContractManifest, validateWorkspaceContracts } from "./validator.js";

describe("contract validation", () => {
  it("validates a manifest shape", () => {
    expect(validateContractManifest({
      schema_version: 1,
      kind: "osstack.contract_manifest",
      service: "demo",
      endpoints: [{ id: "get-users", method: "GET", path: "/api/users" }],
    })).toMatchObject({
      service: "demo",
      endpoints: [{ id: "get-users", method: "GET", path: "/api/users" }],
    });
  });

  it("reports missing backend routes for frontend calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "osstack-contracts-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "osstack.contracts.json"), JSON.stringify({
      schema_version: 1,
      kind: "osstack.contract_manifest",
      service: "demo",
      endpoints: [
        { id: "get-users", method: "GET", path: "/api/users" },
        { id: "create-users", method: "POST", path: "/api/users" },
      ],
    }, null, 2));
    await writeFile(join(workspace, "src", "client.ts"), `
      await fetch("/api/users");
      await fetch("/api/users", { method: "POST" });
    `);
    await writeFile(join(workspace, "src", "server.ts"), `
      app.get("/api/users", handler);
    `);

    const report = await validateWorkspaceContracts({ workspacePath: workspace });

    expect(report.status).toBe("fail");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule_id: "contract.missing_backend",
        severity: "error",
        endpoint_id: "create-users",
        method: "POST",
        path: "/api/users",
      }),
    ]));
  });

  it("passes when frontend calls and backend routes satisfy the manifest", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "osstack-contracts-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "osstack.contracts.json"), JSON.stringify({
      schema_version: 1,
      kind: "osstack.contract_manifest",
      service: "demo",
      endpoints: [
        { id: "get-health", method: "GET", path: "/api/health" },
      ],
    }, null, 2));
    await writeFile(join(workspace, "src", "client.ts"), "await fetch('/api/health');\n");
    await writeFile(join(workspace, "src", "server.ts"), "router.get('/api/health', handler);\n");

    const report = await validateWorkspaceContracts({ workspacePath: workspace, now: "2026-06-23T00:00:00.000Z" });

    expect(report).toMatchObject({
      schema_version: 1,
      kind: "osstack.contract_validation",
      status: "pass",
      service: "demo",
      endpoints: 1,
      checked_at: "2026-06-23T00:00:00.000Z",
      findings: [],
    });
  });
});
