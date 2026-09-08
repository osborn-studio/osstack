import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlledSessionAdapter, type ControlledSessionQuery } from "@osstack/agents";
import { canonicalContinuationGrantBody, continuationGrantDigest } from "@osstack/autonomy";
import { openDb, SessionContinuationRepository } from "@osstack/core";
import { ContinuationGrantBody } from "@osstack/protocol";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles, type StartDaemonOptions } from "./daemon.js";
import type { AutonomyHealthReport } from "./autonomy-health.js";

type Response = { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
const owner = generateKeyPairSync("ed25519");
const publicKey = owner.publicKey.export({ type: "spki", format: "pem" }).toString();
let home: string;
let handle: DaemonHandles | undefined;
let socket: string;
let resumed: string[];
const nativeStates = new Map<string, string>();
const decision = (phase: string, kind = "phase_continue") => ({
  decision_id: `decision_${phase}`, question: "Continue?", choices: [],
  continuation: { version: 1, gate_kind: kind, phase, next_action: "MUTABLE MODEL INSTRUCTION MUST NOT RUN", evidence_refs: [] },
});
const query: ControlledSessionQuery = ({ prompt, options }) => (async function* () {
  const nativeId = options.resume ?? `private_${randomUUID()}`;
  const scenario = options.resume ? nativeStates.get(nativeId)! : prompt;
  nativeStates.set(nativeId, scenario);
  yield { type: "system", subtype: "init", session_id: nativeId, cwd: options.cwd, model: options.model,
    permissionMode: "dontAsk", tools: [], mcp_servers: [], plugins: [], skills: [] };
  if (options.resume) resumed.push(prompt);
  if (options.resume && scenario === "late") {
    const wallClock = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => wallClock() + 10_000);
  }
  if (options.resume && scenario === "hold") {
    await new Promise<void>((resolve) => {
      if (options.abortController?.signal.aborted) resolve();
      else options.abortController?.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return;
  }
  const phase = options.resume && prompt !== "repair frozen" ? "review" : "plan";
  const ready = scenario !== "retry" || options.resume !== undefined;
  const done = prompt === "final frozen";
  yield { type: "result", subtype: "success", is_error: false, result: JSON.stringify({
    result: { ready }, decision: done ? null : decision(phase, scenario === "risk" ? "risk_approval" : "phase_continue"),
  }) };
})();
async function boot(keys = new Map([["owner", publicKey]]), options: Partial<StartDaemonOptions> = {}) {
  handle = await startDaemon({ socketPath: socket, continuationTrustedPublicKeys: keys,
    adapters: [createControlledSessionAdapter({ state_directory: join(home, "runtime"), environment: { ANTHROPIC_API_KEY: "fixture" }, query })], ...options });
}
function rpc(method: string, params?: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { connection.destroy(); reject(new Error("RPC timed out")); }, 10_000);
    connection.on("connect", () => connection.write(encodeFrame({ id: 1, method, params })));
    connection.on("data", (bytes) => {
      const frames = decoder.push(bytes);
      if (frames.length > 0) { clearTimeout(timer); connection.end(); resolve(frames[0] as Response); }
    });
    connection.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
async function grant(scenario = "normal", overrides: Partial<ContinuationGrantBody> = {}) {
  const started = await rpc("session.start", { request_id: randomUUID(), agent_id: "claude-controlled-session", repo_path: home, title: "Controlled fixture", prompt: scenario });
  expect(started.ok).toBe(true);
  const inspect = await rpc("collaborator.inspect", { session_id: started.result!["session_id"] });
  expect(inspect.ok).toBe(true);
  const s = inspect.result!;
  const now = Date.now();
  const body = ContinuationGrantBody.parse({
    version: 1, grant_id: `grant_${randomUUID()}`, session_id: s["session_id"], runtime_id: s["runtime_id"],
    repo_path: home, initial_turn_id: s["turn_id"], initial_version: s["version"],
    runtime_policy_sha256: (s["runtime_policy"] as { fingerprint: string }).fingerprint,
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
    max_resumes: 3, max_checks: 3, turn_timeout_ms: 5000,
    steps: [
      { phase: "plan", instruction: "review frozen", checks: [{ kind: "json_value_equals", path: ["ready"], expected: true }], max_retries: 1, retry_instruction: "repair frozen" },
      { phase: "review", instruction: "final frozen", checks: [{ kind: "json_value_equals", path: ["ready"], expected: true }] },
    ], ...overrides,
  });
  return { body, key_id: "owner", signature: sign(null, Buffer.from(canonicalContinuationGrantBody(body)), owner.privateKey).toString("base64") };
}
async function until(id: string, status: string) {
  await vi.waitFor(async () => {
    expect((await rpc("collaborator.status", { grant_id: id })).result).toMatchObject({ status });
  }, { timeout: 10_000, interval: 20 });
  return (await rpc("collaborator.status", { grant_id: id })).result!;
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "osstack-collaborator-"));
  socket = join(home, "daemon.sock");
  resumed = [];
  vi.stubEnv("OSSTACK_HOME", home);
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  vi.stubEnv("OSSTACK_DASHBOARD_PORT", "0");
  await boot();
});
afterEach(async () => { await handle?.close(); handle = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("signed collaborator through daemon RPC", () => {
  it("automatically advances two frozen phases and replay never resets spent budgets", async () => {
    const signed = await grant();
    expect((await rpc("collaborator.install", signed)).ok).toBe(true);
    expect(await until(signed.body.grant_id, "completed")).toMatchObject({ resumes_used: 2, checks_used: 2, step_index: 2 });
    expect(resumed).toEqual(["review frozen", "final frozen"]);
    expect((await rpc("collaborator.install", signed)).ok).toBe(true);
    expect(resumed).toHaveLength(2);
  });
  it("uses only the signed retry instruction within its finite budget", async () => {
    const signed = await grant("retry");
    await rpc("collaborator.install", signed);
    await until(signed.body.grant_id, "completed");
    expect(resumed).toEqual(["repair frozen", "review frozen", "final frozen"]);
  });
  it("cannot use a phase grant as a risk approval", async () => {
    const signed = await grant("risk");
    await rpc("collaborator.install", signed);
    await until(signed.body.grant_id, "blocked");
    expect(resumed).toEqual([]);
  });
  it("rejects signature, runtime-policy and session-cursor changes without any send", async () => {
    const signed = await grant();
    expect((await rpc("collaborator.install", { ...signed, body: { ...signed.body, max_resumes: 32 } })).ok).toBe(false);
    const changed = { ...signed.body, runtime_policy_sha256: "a".repeat(64) };
    expect((await rpc("collaborator.install", { ...signed, body: changed, signature: sign(null, Buffer.from(canonicalContinuationGrantBody(changed)), owner.privateKey).toString("base64") })).ok).toBe(false);
    expect(resumed).toEqual([]);
  });
  it("revokes an in-flight turn and stops before the next instruction", async () => {
    const signed = await grant("hold");
    await rpc("collaborator.install", signed);
    await vi.waitFor(() => expect(resumed).toEqual(["review frozen"]));
    expect((await rpc("collaborator.revoke", { grant_id: signed.body.grant_id })).ok).toBe(true);
    await until(signed.body.grant_id, "revoked");
    await handle!.close(); handle = undefined;
    expect(resumed).toEqual(["review frozen"]);
  });
  it("bounds a stalled turn and blocks further automatic delivery", async () => {
    const signed = await grant("hold", { turn_timeout_ms: 1000 });
    await rpc("collaborator.install", signed);
    await until(signed.body.grant_id, "blocked");
    expect(resumed).toEqual(["review frozen"]);
  });
  it("retains a late real receipt but blocks when the timeout callback has not run yet", async () => {
    const signed = await grant("late", { turn_timeout_ms: 5000 });
    await rpc("collaborator.install", signed);
    expect(await until(signed.body.grant_id, "blocked")).toMatchObject({ reason: "turn_timeout", step_index: 1 });
    expect(resumed).toEqual(["review frozen"]);
    expect((await rpc("session.snapshot", { session_id: signed.body.session_id })).result).toMatchObject({ assistant_text: '{"ready":true}' });
  });
  it("recovers a reserved receipt as uncertain after restart without resending", async () => {
    const signed = await grant();
    const path = handle!.dbPath;
    await handle!.close(); handle = undefined;
    const db = openDb({ path });
    const repo = new SessionContinuationRepository(db, path);
    const now = Date.now() / 1000;
    repo.install(signed.body, continuationGrantDigest(signed.body), signed.key_id, now, signed.signature);
    const check = repo.beginCheck(signed.body.grant_id, now);
    expect(check.outcome).toBe("checking");
    if (check.outcome === "checking") expect(repo.finishCheck(check.attempt.attempt_id, { passed: true, details: {} }, now).outcome).toBe("reserved");
    db.close();
    await boot();
    const state = await until(signed.body.grant_id, "blocked");
    expect(state["reason"]).toBe("delivery_uncertain");
    expect(resumed).toEqual([]);
  });
  it("defers persisted grants and refuses installs until initial health permits work", async () => {
    const signed = await grant();
    const path = handle!.dbPath;
    await handle!.close(); handle = undefined;
    const db = openDb({ path });
    const health: AutonomyHealthReport = {
      ok: true, can_run_local: true, can_merge: true, can_push_deploy: true, drain_required: false,
      disk_free_bytes: 20 * 1024 ** 3, checks: [], active_freezes: [], resumable_runs: [], proof_failures: [],
      notification_outbox: { pending_count: 0, dead_letter_count: 0, oldest_pending_at: null, oldest_dead_letter_at: null, oldest_attention_age_seconds: 0 },
      host_evidence: {
        power_policy: { mode: "none", assertion_active: false, recorded: false },
        clock_monitor: { mode: "none", active: false }, retention: null,
        launchd: { required: false, loaded: false, print_sha256: null },
      },
      external_blockers: [], write_blockers: [], next_actions: [],
    };
    new SessionContinuationRepository(db, path).install(signed.body, continuationGrantDigest(signed.body), signed.key_id, Date.now() / 1000, signed.signature);
    db.close();
    let release!: (value: AutonomyHealthReport) => void;
    const initialHealth = new Promise<AutonomyHealthReport>((resolve) => { release = resolve; });
    await boot(new Map([["owner", publicKey]]), {
      autonomyHealth: async () => await initialHealth,
      guardedAutonomyFactory: () => ({ resume: async () => { throw new Error("no guarded runs expected"); } }),
    });
    try {
      expect((await rpc("collaborator.install", signed)).ok).toBe(false);
      expect(resumed).toEqual([]);
    } finally { release({ ...health, ok: true, can_run_local: true, can_push_deploy: true, drain_required: false }); }
    await until(signed.body.grant_id, "completed");
    expect(resumed).toEqual(["review frozen", "final frozen"]);
  });
});
