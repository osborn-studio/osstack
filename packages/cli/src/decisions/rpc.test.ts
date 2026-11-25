import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "../daemon.js";
import { openDb, appendEvent, createScratchDirSync } from "@osstack/core";
import { DecisionsListResult, DecisionsTryResult } from "@osstack/protocol";
import { healthyAutonomyHealth } from "../test-healthy-autonomy.js";

let daemon: DaemonHandles | undefined;
let root: string | undefined;
afterEach(async () => { await daemon?.close(); daemon = undefined; vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function rpc(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemon!.socketPath); const decoder = new FrameDecoder();
    const timer = setTimeout(() => { socket.destroy(); reject(Error("timeout")); }, 5000);
    socket.on("connect", () => socket.write(encodeFrame({ id: 1, method, params })));
    socket.on("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
    socket.on("data", chunk => { const frames = decoder.push(chunk); if (frames.length) { clearTimeout(timer); socket.end(); resolve(frames[0] as Awaited<ReturnType<typeof rpc>>); } });
  });
}
it("serves decisions.list through the daemon socket and rejects invalid parameters", async () => {
  root = mkdtempSync(join(tmpdir(), "decisions-rpc-"));
  vi.stubEnv("OSSTACK_HOME", root);
  vi.stubEnv("OSSTACK_ATTENTION", "0"); vi.stubEnv("OSSTACK_ENGINEERING", "0"); vi.stubEnv("OSSTACK_CONTAINED_MISSIONS", "0");
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  daemon = await startDaemon({ socketPath: join(root, "d.sock"), adapters: [], autonomyHealth: async () => healthyAutonomyHealth() });
  const response = await rpc("decisions.list", {});
  expect(response).toMatchObject({ ok: true, result: { items: [], next_cursor: null, failures: [
    { source: "contained_mission", code: "source_unavailable" },
    { source: "ci_repair", code: "source_unavailable" },
    { source: "revision_chain", code: "source_unavailable" },
  ] } });
  expect(await rpc("decisions.list", { limit: 101 })).toMatchObject({ ok: false, error: { code: "bad_request" } });
});

it("answers a listed Hermes decision over the daemon socket and replays a lost response", async () => {
  root = mkdtempSync(join(tmpdir(), "decisions-answer-rpc-"));
  vi.stubEnv("OSSTACK_HOME", root); vi.stubEnv("OSSTACK_ATTENTION", "1");
  vi.stubEnv("OSSTACK_ENGINEERING", "1"); vi.stubEnv("OSSTACK_CONTAINED_MISSIONS", "0"); vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  const credential = "c".repeat(32); const authority = join(root, "authority.json");
  writeFileSync(authority, JSON.stringify({ version: 1, principals: [{ credential_sha256: createHash("sha256").update(credential).digest("hex"), principal_id: "human", client_session_id: "chat", read_scopes: [], write_scopes: [], stop_scopes: [], operator_scopes: [] }] }), { mode: 0o600 });
  vi.stubEnv("OSSTACK_ENGINEERING_AUTH_FILE", authority);
  daemon = await startDaemon({ socketPath: join(root, "a.sock"), adapters: [], autonomyHealth: async () => healthyAutonomyHealth() });
  const db = openDb({ path: daemon.dbPath });
  try {
    db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','hermes','code','execute',1); INSERT INTO approvals(approval_id,run_id,status,action_summary,risk,requested_at) VALUES('a','r','pending','Approve?','low',1)");
    appendEvent(db, daemon.dbPath, { event_id: "request", run_id: "r", session_id: "s", seq: 0, type: "approval.requested", created_at: 1, terminal: false, payload: { approval_id: "a", action_summary: "Approve?", risk: "low" } });
    const page = DecisionsListResult.parse((await rpc("decisions.list", { credential })).result);
    const item = page.items.find(i => i.source === "hermes")!;
    const params = { credential, source: item.source, source_id: item.source_id, source_revision: item.source_revision, answer: "choice", params: { choice: "yes" }, answer_id: "chat:1" };
    const before = db.prepare("SELECT COUNT(*) n FROM events").get();
    expect(await rpc("decisions.answer", { ...params, credential: "x".repeat(32) })).toMatchObject({ ok: true, result: { accepted: false, code: "permission_denied" } });
    expect(db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual(before);
    expect(await rpc("decisions.answer", params)).toMatchObject({ ok: true, result: { accepted: true, replay: false, outcome: "applied", current: { state: "accepted", item: null } } });
    expect(await rpc("decisions.answer", params)).toMatchObject({ ok: true, result: { accepted: true, replay: true } });
    expect(DecisionsListResult.parse((await rpc("decisions.list", { credential })).result).items).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE json_extract(payload_json,'$.decisions_answer') IS NOT NULL").get()).toEqual({ n: 1 });
    const receipt = db.prepare("SELECT payload_json FROM events WHERE json_extract(payload_json,'$.decisions_answer') IS NOT NULL").get() as { payload_json: string };
    expect(JSON.parse(receipt.payload_json).decisions_answer).toMatchObject({ actor: "human", client_session_id: "chat" });
  } finally { db.close(); }
});

it("serves a credentialed, unscoped probe and keeps status readable during drain", async () => {
  root = createScratchDirSync("tests", "probe-rpc");
  vi.stubEnv("OSSTACK_HOME", root);
  vi.stubEnv("OSSTACK_ATTENTION", "1");
  vi.stubEnv("OSSTACK_ENGINEERING", "1");
  vi.stubEnv("OSSTACK_CONTAINED_MISSIONS", "0");
  vi.stubEnv("OSSTACK_ATTENTION_NOTIFY", "local");
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  const credential = "p".repeat(32);
  const authority = join(root, "authority.json");
  writeFileSync(authority, JSON.stringify({ version: 1, principals: [{
    credential_sha256: createHash("sha256").update(credential).digest("hex"), principal_id: "owner", client_session_id: "local",
    read_scopes: [], write_scopes: [], stop_scopes: [], operator_scopes: [],
  }] }), { mode: 0o600 });
  vi.stubEnv("OSSTACK_ENGINEERING_AUTH_FILE", authority);
  daemon = await startDaemon({ socketPath: join(root, "p.sock"), adapters: [], autonomyHealth: async () => healthyAutonomyHealth() });
  expect(await rpc("decisions.try_create", {})).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  const card = DecisionsTryResult.parse((await rpc("decisions.try_create", { credential })).result);
  const params = { credential, probe_id: card.probe_id };
  expect(await rpc("decisions.answer", { credential, source: "probe", source_id: card.probe_id,
    answer: "green", source_revision: "1", answer_id: "socket:1" })).toMatchObject({ result: { accepted: true } });
  expect(await rpc("decisions.try_continue", params)).toMatchObject({ result: { state: "continued", answer: "green" } });
  expect(await rpc("daemon.drain", { timeout_ms: 0 })).toMatchObject({ ok: true });
  expect(await rpc("decisions.try_status", params)).toMatchObject({ result: { state: "continued" } });
  expect(await rpc("decisions.try_create", { credential })).toMatchObject({ error: { code: "draining" } });
  expect(await rpc("decisions.try_continue", params)).toMatchObject({ error: { code: "draining" } });
});
