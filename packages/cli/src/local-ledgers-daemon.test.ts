import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { createScratchDir, openDb, insertRun, insertTask } from "@osstack/core";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { afterEach, expect, it, vi } from "vitest";
import {
  startDaemon,
  type DaemonHandles,
  type StartDaemonOptions,
} from "./daemon.js";
import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";
import { main } from "./bin.js";
let daemon: DaemonHandles | undefined;
let root: string | undefined;
let socket: string;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
function rpc(
  method: string,
  params: unknown,
): Promise<{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string };
}> {
  return new Promise((resolve, reject) => {
    const sock = connect(socket);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Error("timeout"));
    }, 5000);
    sock.on("connect", () =>
      sock.write(encodeFrame({ id: 1, method, params })),
    );
    sock.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    sock.on("data", (chunk) => {
      const values = decoder.push(chunk);
      if (values.length) {
        clearTimeout(timer);
        sock.end();
        resolve(values[0] as Awaited<ReturnType<typeof rpc>>);
      }
    });
  });
}
async function start(options: StartDaemonOptions = {}) {
  daemon = await startDaemon({
    socketPath: socket,
    adapters: [],
    autonomyHealth: async () => healthyAutonomyHealth(),
    ...options,
  });
  return daemon;
}
async function fixture(
  attention: boolean,
  triage: boolean,
  options: StartDaemonOptions = {},
) {
  root = await createScratchDir("tests", "ledgers-daemon");
  socket = join(root, "d.sock");
  vi.stubEnv("OSSTACK_HOME", root);
  vi.stubEnv("OSSTACK_SOCKET", socket);
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  vi.stubEnv("OSSTACK_ATTENTION", attention ? "1" : "0");
  vi.stubEnv("OSSTACK_ATTENTION_TRIAGE_ENABLED", triage ? "1" : "0");
  vi.stubEnv("OSSTACK_ATTENTION_TRIAGE_MODEL", "exact-model");
  vi.stubEnv("OSSTACK_ATTENTION_TRIAGE_CALLS_PER_HOUR", "1");
  vi.stubEnv("OSSTACK_ATTENTION_TRIAGE_TIMEOUT_MS", "1000");
  await start(options);
  const repo = join(realpathSync(root), "repo");
  await mkdir(repo);
  const db = openDb({ path: daemon!.dbPath });
  insertTask(db, daemon!.dbPath, {
    task_id: "task",
    title: "private prompt",
    created_at: 1,
  });
  insertRun(db, daemon!.dbPath, {
    run_id: "run",
    task_id: "task",
    session_id: "session",
    agent_id: "fake",
    capability_id: "code",
    phase: "execute",
    started_at: 1,
  });
  db.prepare(
    "INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES('session','task','run','fake',?,'PRIVATE_NATIVE_ID',?,'awaiting_decision',0,1,1)",
  ).run("a".repeat(64), repo);
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','session',1,'awaiting_decision',?,1,1)",
  ).run(
    JSON.stringify({
      decision_id: "decision",
      question: "Inspect result?",
      choices: [],
    }),
  );
  db.close();
  return { repo, scope: { repo_path: repo, default_tenant: true } };
}
async function watched(repo: string) {
  expect(
    await rpc("attention.watch", {
      task_id: "task",
      repo_path: repo,
      default_tenant: true,
    }),
  ).toMatchObject({ ok: true });
  const db = openDb({ path: daemon!.dbPath });
  try {
    return {
      ...(db
        .prepare(
          "SELECT scope_id,item_id FROM attention_items WHERE state='open' ORDER BY updated_at DESC LIMIT 1",
        )
        .get() as { scope_id: string; item_id: string }),
      model_id: "exact-model",
    };
  } finally {
    db.close();
  }
}
const receipt = {
  text: JSON.stringify({ category: "system_wait", explanation: "advice only" }),
  requested_model: "exact-model",
  reported_model: "exact-model",
  usage: { input_tokens: 1, output_tokens: 1 },
};
const provider = (invoke = async () => receipt) => ({
  policy: async () => ({
    profile: "claude-triage-no-tools-v1" as const,
    model_id: "exact-model",
    fingerprint: "a".repeat(64),
  }),
  invoke,
});
it("keeps local follow-up available with Attention disabled and rejects public delivery claims", async () => {
  const f = await fixture(false, false);
  expect(
    await rpc("attention.triage-status", { scope_id: "a".repeat(64) }),
  ).toMatchObject({ ok: false, error: { code: "attention_disabled" } });
  const input = {
    ...f.scope,
    source_session_id: "session",
    expected_source_version: 1,
    idempotency_key: "once",
    actor: "operator",
    promise: "Review",
    destination_ref: "local_operator",
    resolution_condition: "manual",
    due_at: null,
  };
  expect(
    await rpc("follow-up.create", {
      ...input,
      provider_receipt: "https://fake.example",
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid_follow_up_request" } });
  expect(await rpc("follow-up.create", input)).toMatchObject({
    ok: true,
    result: { obligation: { state: "open", external_delivery: "unsupported" } },
  });
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(
    await main([
      "follow-up",
      "list",
      "--repo",
      f.repo,
      "--default-tenant",
      "--json",
    ]),
  ).toBe(0);
  expect(
    output.mock.calls.map((call) => String(call[0])).join(""),
  ).not.toContain("PRIVATE_NATIVE_ID");
});
it("does not initialize the triage provider when disabled, including the real command", async () => {
  const factory = vi.fn(async () => provider());
  const f = await fixture(true, false, {
    attentionTriageProviderFactory: factory,
  });
  const request = await watched(f.repo);
  expect(await rpc("attention.triage", request)).toMatchObject({
    ok: true,
    result: { state: "fallback", reason: "triage_disabled", applied: false },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(
    await main([
      "attention",
      "triage",
      "--scope",
      request.scope_id,
      "--item",
      request.item_id,
      "--model",
      "exact-model",
      "--json",
    ]),
  ).toBe(1);
  expect(factory).not.toHaveBeenCalled();
});
it("persists advisory cache and quota across daemon restart without answering or marking items seen", async () => {
  const invoke = vi.fn(async () => receipt);
  const factory = vi.fn(async () => provider(invoke));
  const f = await fixture(true, true, {
    attentionTriageProviderFactory: factory,
  });
  const request = await watched(f.repo);
  expect(
    await rpc("attention.triage", { ...request, tools: ["Bash"] }),
  ).toMatchObject({ ok: false, error: { code: "invalid_triage_request" } });
  expect(await rpc("attention.triage", request)).toMatchObject({
    ok: true,
    result: { state: "advisory", applied: false, cached: false },
  });
  await daemon!.close();
  await start({ attentionTriageProviderFactory: factory });
  expect(await rpc("attention.triage", request)).toMatchObject({
    ok: true,
    result: { state: "advisory", applied: false, cached: true },
  });
  const db = openDb({ path: daemon!.dbPath });
  try {
    for (const table of [
      "attention_actions",
      "attention_seen",
      "session_messages",
    ])
      expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({
        n: 0,
      });
    db.prepare("UPDATE agent_sessions SET version=2").run();
    db.prepare(
      "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn2','session',2,'awaiting_decision',?,2,2)",
    ).run(
      JSON.stringify({
        decision_id: "decision2",
        question: "New question?",
        choices: [],
      }),
    );
  } finally {
    db.close();
  }
  const changed = await watched(f.repo);
  expect(await rpc("attention.triage", changed)).toMatchObject({
    ok: true,
    result: { state: "fallback", reason: "budget_exhausted" },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("keeps unknown invocation quarantined after stop and restart, with no late success", async () => {
  let settle!: (value: typeof receipt) => void;
  const pending = new Promise<typeof receipt>((resolve) => {
    settle = resolve;
  });
  const factory = vi.fn(async () => provider(async () => pending));
  const f = await fixture(true, true, {
    attentionTriageProviderFactory: factory,
  });
  const request = await watched(f.repo);
  const answer = rpc("attention.triage", request);
  await vi.waitFor(() => {
    const db = openDb({ path: daemon!.dbPath });
    try {
      expect(
        db.prepare("SELECT status FROM attention_triage_attempts").get(),
      ).toEqual({ status: "running" });
    } finally {
      db.close();
    }
  });
  await daemon!.close();
  await answer.catch(() => undefined);
  settle(receipt);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await start({ attentionTriageProviderFactory: async () => provider() });
  expect(
    await rpc("attention.triage-status", { scope_id: request.scope_id }),
  ).toMatchObject({ ok: true, result: { state: "quarantined" } });
  expect(await rpc("attention.triage", request)).toMatchObject({
    ok: true,
    result: { state: "fallback", reason: "triage_quarantined" },
  });
  const db = openDb({ path: daemon!.dbPath });
  try {
    expect(
      db
        .prepare(
          "SELECT status,active_slot,result_json FROM attention_triage_attempts",
        )
        .get(),
    ).toEqual({ status: "unknown", active_slot: 1, result_json: null });
  } finally {
    db.close();
  }
});
