import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { handleEngineeringCommand } from "./engineering-command.js";

const credential = "secret-".repeat(8);
const ref = { kind: "session_decision", scope_id: "scope", item_id: "item", item_revision: 2, session_id: "session", turn_id: "turn", decision_id: "decision", source_version: 3, content_hash: "a".repeat(64) };
const view = { mission: { mission_id: "mission", revision: 4 }, waits: [{ wait_id: "wait", revision: 2, decision_ref: ref, interaction_token: "t".repeat(32) }], source_version: 3, turn_id: "turn", snapshot_digest: "b".repeat(64) };
function setup(result: unknown = { mission: { mission_id: "mission", revision: 1 } }) {
  return { rpc: vi.fn(async (_method: string, _params?: unknown, _timeoutMs?: number) => ({ ok: true, result })), stdout: vi.fn(), stderr: vi.fn(), readCredential: () => credential, readInput: vi.fn(async () => view) };
}
describe("engineering CLI", () => {
  it("shows scope and completion semantics without credentials or daemon access", async () => {
    const io = setup();
    expect(await handleEngineeringCommand(["--help"], io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(expect.stringContaining("observed_turn"));
    expect(io.rpc).not.toHaveBeenCalled();
  });
  it("adopts an exact existing session and authenticates through injected host credential", async () => {
    const io = setup();
    const code = await handleEngineeringCommand(["adopt", "--scope", "scope", "--task", "task", "--run", "run", "--session", "session", "--goal", "Observe the reply.", "--request", "request", "--json"], io);
    expect(code).toBe(0);
    expect(io.rpc).toHaveBeenCalledWith("engineering.adopt", { scope_id: "scope", task_id: "task", run_id: "run", session_id: "session", goal: "Observe the reply.", request_id: "request", completion_level: "observed_turn", credential }, 120000);
    expect(io.stdout.mock.calls.flat().join("")).not.toContain(credential);
  });
  it("uses frozen displayed bindings without silently fetching a new revision", async () => {
    const io = setup();
    expect(await handleEngineeringCommand(["decide", "--observation", "view.json", "--wait", "wait", "--action", "answer", "--choice", "keep"], io)).toBe(0);
    expect(io.rpc).toHaveBeenCalledTimes(1);
    expect(io.rpc).toHaveBeenCalledWith("engineering.decide", { mission_id: "mission", wait_id: "wait", if_revision: 4, decision_ref: ref, action_id: "answer", answer: { kind: "choice", choice_id: "keep" }, interaction_token: "t".repeat(32), credential }, 120000);
  });
  it("does not guess choices and preserves explicit raw text", async () => {
    const io = setup();
    expect(await handleEngineeringCommand(["decide", "--observation", "view.json", "--wait", "wait", "--action", "answer", "--text", "  input  "], io)).toBe(0);
    expect(io.rpc.mock.calls[0]?.[1]).toMatchObject({ answer: { kind: "text", text: "  input  " } });
    io.rpc.mockClear();
    expect(await handleEngineeringCommand(["decide", "--observation", "view.json", "--wait", "wait", "--action", "answer", "--choice", "keep", "--text", "yes"], io)).toBe(1);
    expect(io.rpc).not.toHaveBeenCalled();
  });
  it("sends literal -h text instead of silently returning help", async () => {
    const io = setup();
    expect(await handleEngineeringCommand(["decide", "--observation", "view.json", "--wait", "wait", "--action", "literal-help", "--text", "-h"], io)).toBe(0);
    expect(io.rpc).toHaveBeenCalledWith("engineering.decide", expect.objectContaining({ answer: { kind: "text", text: "-h" } }), 120000);
    expect(io.stdout.mock.calls.flat().join("")).not.toContain("Usage:");
  });
  it("separates cancellation from ending observation", async () => {
    for (const [command, method] of [["cancel", "engineering.cancel"], ["end-observation", "engineering.endObservation"]]) {
      const io = setup();
      expect(await handleEngineeringCommand([command!, "--mission", "mission", "--revision", "4", "--request", "stop"], io)).toBe(0);
      expect(io.rpc).toHaveBeenCalledWith(method, { mission_id: "mission", if_revision: 4, request_id: "stop", credential }, 120000);
    }
  });
  it("defers and disposes against explicit wait and observed source versions", async () => {
    const io = setup();
    expect(await handleEngineeringCommand(["defer", "--observation", "view.json", "--wait", "wait", "--request", "later", "--revisit-at", "2026-10-26T12:00:00Z", "--reason", "Need input."], io)).toBe(0);
    expect(io.rpc.mock.calls[0]?.[1]).toMatchObject({ wait_revision: 2, if_revision: 4 });
    io.rpc.mockClear();
    expect(await handleEngineeringCommand(["reconcile", "--kind", "dispose_wait", "--observation", "view.json", "--wait", "wait", "--request", "dispose", "--disposition", "no_longer_relevant", "--reason", "Observation no longer needed."], io)).toBe(0);
    expect(io.rpc.mock.calls[0]?.[1]).toMatchObject({ observed_snapshot_digest: "b".repeat(64), observed_source_version: 3, observed_turn_id: "turn", wait_revision: 2 });
  });
  it("rejects unknown, duplicated, wrong-command and authority flags before RPC", async () => {
    for (const args of [
      ["observe", "--mission", "mission", "--actor", "admin"],
      ["observe", "--mission", "mission", "--mission", "other"],
      ["observe", "--mission", "mission", "--reason", "wrong-command"],
      ["observe", "--mission", "mission", "--limit", "1000"],
      ["observe", "--mission", "mission", "--json", "--json"],
      ["observe", "--input", "request.json", "--mission", "mission"],
    ]) {
      const io = setup();
      expect(await handleEngineeringCommand(args, io)).toBe(1);
      expect(io.rpc).not.toHaveBeenCalled();
    }
  });
  it("validates JSON input and never accepts a supplied credential or actor", async () => {
    const io = setup();
    io.readInput.mockResolvedValue({ mission_id: "mission", actor: "admin" } as unknown as typeof view);
    expect(await handleEngineeringCommand(["observe", "--input", "request.json"], io)).toBe(1);
    expect(io.rpc).not.toHaveBeenCalled();
    io.readInput.mockResolvedValue({ mission_id: "mission", credential } as unknown as typeof view);
    expect(await handleEngineeringCommand(["observe", "--input", "request.json"], io)).toBe(1);
    expect(io.rpc).not.toHaveBeenCalled();
  });
  it("renders source controls safely and redacts a bearer from failures", async () => {
    const io = setup({ text: "untrusted\u001b[2J\u202e" });
    expect(await handleEngineeringCommand(["observe", "--mission", "mission", "--json"], io)).toBe(0);
    expect(io.stdout.mock.calls[0]?.[0]).toContain("\\u001b");
    expect(io.stdout.mock.calls[0]?.[0]).toContain("\\u202e");
    io.rpc.mockRejectedValue(new Error(`transport failed ${credential}`));
    expect(await handleEngineeringCommand(["observe", "--mission", "mission"], io)).toBe(1);
    expect(io.stderr.mock.calls.flat().join("")).not.toContain(credential);
  });
  it("bounds JSON file input, rejects symlinks and parses regular input", async () => {
    const dir = join(process.env["OSSTACK_HOME"]!, "engineering-input");
    mkdirSync(dir, { recursive: true });
    const valid = join(dir, "request.json");
    writeFileSync(valid, JSON.stringify({ mission_id: "mission" }));
    const io = setup();
    const { readInput: _readInput, ...realFileIo } = io;
    expect(await handleEngineeringCommand(["observe", "--input", valid], realFileIo)).toBe(0);
    io.rpc.mockClear();
    const large = join(dir, "large.json");
    writeFileSync(large, " ".repeat(1024 * 1024 + 1));
    expect(await handleEngineeringCommand(["observe", "--input", large], realFileIo)).toBe(1);
    const link = join(dir, "link.json");
    symlinkSync(valid, link);
    expect(await handleEngineeringCommand(["observe", "--input", link], realFileIo)).toBe(1);
    expect(io.rpc).not.toHaveBeenCalled();
  });
  it("refuses an invalid client credential before transport", async () => {
    const io = setup();
    expect(await handleEngineeringCommand(["observe", "--mission", "mission"], { ...io, readCredential: () => "" })).toBe(1);
    expect(io.rpc).not.toHaveBeenCalled();
  });
  it("returns actionable server failure without pretending success", async () => {
    const io = setup();
    io.rpc.mockResolvedValue({ ok: false, error: { code: "permission_denied" } } as unknown as { ok: boolean; result: unknown });
    expect(await handleEngineeringCommand(["cancel", "--mission", "mission", "--revision", "4", "--request", "stop"], io)).toBe(1);
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining("permission_denied"));
  });
});
