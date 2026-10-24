import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { handleFollowUpCommand } from "./follow-up-command.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function io() { return { rpc: vi.fn(async (_method: string, _params: unknown): Promise<unknown> => { throw new Error("PRIVATE_DB_PATH"); }), stdout: vi.fn(), stderr: vi.fn() }; }
const scope = ["--repo", "/repo", "--default-tenant"];
it("shows local-only usage without touching the daemon", async () => {
  const output = io(); expect(await handleFollowUpCommand(["--help"], output)).toBe(0);
  expect(output.rpc).not.toHaveBeenCalled(); expect(output.stdout.mock.calls[0]![0]).toContain("external delivery is unsupported");
});
it.each([["list"], ["list", "--repo", "/repo"], ["send", ...scope], ["list", ...scope, "--limit", "51"], ["list", ...scope, "--limit", "2x"], ["list", ...scope, "--json", "--json"], ["resolve", "id", ...scope, "--mode", "delivered"], ["list", ...scope, "--db", "other"]])("rejects invalid command before RPC: %j", async (...args) => {
  const output = io(); expect(await handleFollowUpCommand(args, output)).toBe(1); expect(output.rpc).not.toHaveBeenCalled();
});
it("loads a bounded create file and requires scope at the command boundary", async () => {
  const root = realpathSync(createScratchDirSync("tests", "follow-up-command")); roots.push(root); const path = join(root, "create.json");
  const body = { source_session_id: "session", expected_source_version: 1, idempotency_key: "key", actor: "operator", promise: "Check local condition", destination_ref: "local_operator", resolution_condition: "session_completed" };
  writeFileSync(path, JSON.stringify(body)); const output = io();
  await handleFollowUpCommand(["create", ...scope, "--input", path], output);
  expect(output.rpc).toHaveBeenCalledWith("follow-up.create", { repo_path: "/repo", default_tenant: true, ...body, due_at: null });
  output.rpc.mockClear(); writeFileSync(path, JSON.stringify({ ...body, repo_path: "/other" }));
  await handleFollowUpCommand(["create", ...scope, "--input", path], output); expect(output.rpc).not.toHaveBeenCalled();
  writeFileSync(path, " ".repeat(17000)); await handleFollowUpCommand(["create", ...scope, "--input", path], output); expect(output.rpc).not.toHaveBeenCalled();
});
it("forwards explicit revision and does not turn local resolution into delivery", async () => {
  const output = io(); const id = "c063e75f-8f3b-4b54-9eb8-e464b7f17bb7";
  await handleFollowUpCommand(["resolve", id, ...scope, "--revision", "4", "--actor", "operator", "--mode", "waive", "--reason", "Obsolete"], output);
  expect(output.rpc).toHaveBeenCalledWith("follow-up.resolve", { repo_path: "/repo", default_tenant: true, obligation_id: id, expected_revision: 4, actor: "operator", mode: "waive", reason: "Obsolete" });
});
it("escapes terminal controls and rejects unvalidated daemon payloads", async () => {
  const output = io(); const payload = { schema_version: 1, scope: { repo_path: "/repo\u001b]52;bad\u009b\u202e", default_tenant: true }, sampled_at_ms: 1, obligations: [], next_cursor: null, overdue_count: 0, external_delivery: "unsupported" };
  output.rpc.mockResolvedValue(payload);
  for (const extra of [[], ["--json"]]) {
    expect(await handleFollowUpCommand(["list", ...scope, ...extra], output)).toBe(0);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: regression rejects unsafe terminal control bytes.
    expect(output.stdout.mock.calls.at(-1)![0]).not.toMatch(/[\u001b\u009b\p{Cf}]/u);
  }
  output.rpc.mockResolvedValue({ private: "PRIVATE" }); expect(await handleFollowUpCommand(["list", ...scope], output)).toBe(1);
  expect(output.stderr).toHaveBeenLastCalledWith("invalid_follow_up_response\n");
});
