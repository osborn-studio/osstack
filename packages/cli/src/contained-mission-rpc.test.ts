import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { EngineeringAccess } from "./engineering-access.js";
import type { ContainedMissionHost } from "./contained-mission-host.js";
import type { ContainedMissionSpec } from "./contained-mission-runner.js";
import { ContainedMissionService } from "./contained-mission-rpc.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const credential = "c".repeat(48);
const scope = "a".repeat(64); const other = "b".repeat(64);
const MID = "cm_00000000-0000-4000-8000-000000000000";

function setup(draining = false, decideDelay = 0) {
  const root = realpathSync(createScratchDirSync("tests", "contained-rpc"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const authDir = join(root, "auth"); mkdirSync(authDir, { mode: 0o700 });
  const path = join(authDir, "authority.json");
  writeFileSync(path, JSON.stringify({ version: 1, principals: [{ credential_sha256: createHash("sha256").update(credential).digest("hex"), principal_id: "owner", client_session_id: "console",
    read_scopes: [scope], write_scopes: [scope], stop_scopes: [scope], operator_scopes: [] }] }), { mode: 0o600 });
  const repo = join(root, "repo"); mkdirSync(repo);
  const calls: Array<[string, unknown]> = []; let ticks = 0; let release: (() => void) | undefined;
  const mission = { mission_id: MID, state: "authorized", spec_json: "{\"goal\":\"secret-free\"}", revision: 1 };
  const host = {
    store: { get: () => mission, record: () => 1 },
    start: (_principal: unknown, input: unknown) => { calls.push(["start", input]); return mission; },
    status: (_principal: unknown, id: string) => { calls.push(["status", id]); return { mission, events: [] }; },
    cancel: async (_principal: unknown, id: string) => { calls.push(["cancel", id]); return mission; },
    decide: async (_principal: unknown, _id: string, d: unknown) => { calls.push(["decide", d]); if (decideDelay) await new Promise(r => setTimeout(r, decideDelay)); return mission; },
    tick: () => { ticks++; return new Promise<void>(resolve => { release = resolve; }); },
    recover: async () => { calls.push(["recover", null]); },
    close: async () => { calls.push(["close", null]); },
  } as unknown as ContainedMissionHost;
  const resolveStart = async (request: Omit<ContainedMissionSpec, "start_commit" | "branch" | "worktree_path">): Promise<ContainedMissionSpec> =>
    ({ ...request, start_commit: "d".repeat(40), branch: "osstack/mission/abc123", worktree_path: join(root, "wt") });
  const service = new ContainedMissionService({ host, access: new EngineeringAccess(path), draining: () => draining, resolveStart, tickMs: 60_000, ackMs: 50 });
  cleanup.push(() => { void service.close(); });
  const start = (over: Record<string, unknown> = {}) => service.handle("mission.start", { credential, scope_id: scope,
    request: { goal: "fix it", repo_path: repo, base_ref: "main", allowed_paths: ["src/**"], verify: { argv: ["pnpm", "test"] } }, ...over });
  return { service, calls, start, repo, root, ticks: () => ticks, release: () => release?.() };
}

describe("ContainedMissionService", () => {
  it("authenticates, resolves the start and returns the Mission without its stored spec", async () => {
    const f = setup();
    const result = await f.start() as Record<string, unknown>;
    expect(result).toMatchObject({ mission_id: MID, state: "authorized" });
    expect(result).not.toHaveProperty("spec_json");
    expect(f.calls[0]).toEqual(["start", { scope_id: scope, spec: expect.objectContaining({ start_commit: "d".repeat(40), verify: { argv: ["pnpm", "test"] } }) }]);
  });

  it("rejects unknown methods, malformed input, bad credentials and scopes it cannot write", async () => {
    const f = setup();
    await expect(f.service.handle("mission.merge", {})).rejects.toThrow("unknown_method");
    await expect(f.service.handle("mission.status", { credential, mission_id: "nope" })).rejects.toThrow("bad_request");
    await expect(f.service.handle("mission.status", { credential: "x".repeat(40), mission_id: MID })).rejects.toThrow();
    await expect(f.start({ scope_id: other })).rejects.toThrow("permission_denied");
    await expect(f.start({ request: { goal: "g", repo_path: f.repo, base_ref: "main", allowed_paths: ["**"], verify: { argv: ["pnpm"] }, extra: 1 } })).rejects.toThrow("bad_request");
    expect(f.calls.filter(c => c[0] === "start")).toEqual([]);
  });

  it("refuses a repository that contains the authority file", async () => {
    const f = setup();
    await expect(f.start({ request: { goal: "g", repo_path: f.root, base_ref: "main", allowed_paths: ["**"], verify: { argv: ["pnpm"] } } })).rejects.toThrow("engineering_auth_inside_repository");
  });

  it("does not start new Missions while draining, but still answers status", async () => {
    const f = setup(true);
    await expect(f.start()).rejects.toThrow("draining");
    await expect(f.service.handle("mission.status", { credential, mission_id: MID })).resolves.toMatchObject({ mission: { mission_id: MID } });
  });

  it("routes cancel and decide to the host and accepts only listed decisions", async () => {
    const f = setup();
    await f.service.handle("mission.cancel", { credential, mission_id: MID });
    await f.service.handle("mission.decide", { credential, mission_id: MID, decision: "approve_publication" });
    await expect(f.service.handle("mission.decide", { credential, mission_id: MID, decision: "merge" })).rejects.toThrow("bad_request");
    expect(f.calls).toEqual([["cancel", MID], ["decide", { kind: "approve_publication" }]]);
  });

  it("refuses work-producing decisions while draining but still allows abandon and cancel", async () => {
    const f = setup(true);
    for (const decision of ["extra_repair", "discard_changes", "adopt_worktree"]) await expect(f.service.handle("mission.decide", { credential, mission_id: MID, decision })).rejects.toThrow("draining");
    await f.service.handle("mission.decide", { credential, mission_id: MID, decision: "abandon" });
    await f.service.handle("mission.cancel", { credential, mission_id: MID });
    expect(f.calls.map(c => c[0])).toEqual(["decide", "cancel"]);
  });

  it("acknowledges a long work-producing decision and finishes it before close", async () => {
    const f = setup(false, 300);
    const started = Date.now();
    const ack = await f.service.handle("mission.decide", { credential, mission_id: MID, decision: "extra_repair" }) as Record<string, unknown>;
    expect(Date.now() - started).toBeLessThan(250);
    expect(ack).toMatchObject({ accepted: true, decision: "extra_repair", mission: { mission_id: MID } });
    await f.service.close();
    expect(f.calls).toContainEqual(["decide", { kind: "extra_repair" }]);
  });

  it("recovers before ticking and never overlaps two ticks", async () => {
    const f = setup();
    await f.service.start();
    expect(f.calls[0]).toEqual(["recover", null]);
    const a = f.service.tick(); const b = f.service.tick();
    expect(f.ticks()).toBe(1);
    f.release(); await Promise.all([a, b]);
    void f.service.tick(); expect(f.ticks()).toBe(2); f.release();
    await f.service.close();
    expect(f.calls.at(-1)).toEqual(["close", null]);
    await expect(f.service.handle("mission.status", { credential, mission_id: MID })).rejects.toThrow("mission_unavailable");
  });
});
