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
it("exercises the default exported provider without credentials and fails as not_authenticated", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  const f = await fixture(true, true);
  const request = await watched(f.repo);
  expect(await rpc("attention.triage", request)).toMatchObject({
    ok: true,
    result: { state: "fallback", reason: "not_authenticated", applied: false },
  });
});

it("reads scoped recovery through actual daemon and CLI without retry or private prompt disclosure", async () => {
  const f = await fixture(true, false);
  const request = await watched(f.repo);
  const snapshot = await rpc("attention.recovery", {
    scope_id: request.scope_id,
    limit: 1,
  });
  expect(snapshot).toMatchObject({ ok: true });
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_NATIVE_ID");
  expect(JSON.stringify(snapshot)).not.toContain("private prompt");
  expect(
    await rpc("attention.recovery", {
      scope_id: request.scope_id,
      retry: true,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await rpc("attention.recovery", { scope_id: "a".repeat(64) }),
  ).toMatchObject({ ok: false });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(
    await main([
      "attention",
      "recovery",
      "--scope",
      request.scope_id,
      "--limit",
      "1",
      "--json",
    ]),
  ).toBe(0);
  const result = JSON.parse(output.mock.calls.at(-1)![0] as string);
  expect(JSON.stringify(result)).toContain('"canAutoRetry":false');
  const db = openDb({ path: daemon!.dbPath });
  try {
    expect(
      db.prepare("SELECT COUNT(*) n FROM attention_actions").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

it("measures bounded recovery over the actual socket alongside mixed session and run observations", async () => {
  const f = await fixture(true, false);
  const request = await watched(f.repo);
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    expect(
      await rpc("attention.recovery", {
        scope_id: request.scope_id,
        limit: 20,
      }),
    ).toMatchObject({ ok: true });
    samples.push(performance.now() - start);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const report = {
    fixture: "real_daemon_one_session_one_run",
    samples: 100,
    p50_ms: ordered[49],
    p95_ms: ordered[94],
    max_ms: ordered[99],
    capacity_qualification: false,
    model_calls: 0,
  };
  if (process.env["OSSTACK_RECOVERY_BENCH_OUTPUT"]) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      process.env["OSSTACK_RECOVERY_BENCH_OUTPUT"]!,
      JSON.stringify({ ...report, samples_ms: samples }, null, 2) + "\n",
    );
  }
  expect(Number.isFinite(report.p95_ms)).toBe(true);
});

it("watches actual daemon snapshots through the main CLI and leaves worker execution unchanged", async () => {
  const f = await fixture(false, false);
  const page = await rpc("worker.list", f.scope);
  const views = page.result!["views"] as { view_id: string }[];
  expect(views.length).toBeGreaterThan(0);
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    ...args: unknown[]
  ) => {
    chunks.push(String(chunk));
    const callback = args.find((arg) => typeof arg === "function") as
      | (() => void)
      | undefined;
    queueMicrotask(() => callback?.());
    return true;
  }) as typeof process.stdout.write);
  expect(
    await main([
      "worker",
      "watch",
      views[0]!.view_id,
      "--repo",
      f.repo,
      "--default-tenant",
      "--interval-ms",
      "1000",
      "--duration-ms",
      "1000",
    ]),
  ).toBe(0);
  expect(chunks.join("")).toContain("snapshot");
  expect(chunks.join("")).not.toContain("PRIVATE_NATIVE_ID");
  const db = openDb({ path: daemon!.dbPath });
  try {
    expect(
      db
        .prepare("SELECT state FROM agent_sessions WHERE session_id='session'")
        .get(),
    ).toEqual({ state: "awaiting_decision" });
    expect(db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual(
      { n: 0 },
    );
  } finally {
    db.close();
  }
});

it("serves local sources as explicitly disabled without a host registry and rejects request-selected paths", async () => {
  const f = await fixture(false, false);
  expect(
    await rpc("source.inspect", { ...f.scope, source_id: "local" }),
  ).toMatchObject({ ok: true, result: { state: "disabled", entries: [] } });
  expect(
    await rpc("source.inspect", {
      ...f.scope,
      source_id: "local",
      path: "/etc/passwd",
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root!, "source-registry.json"), "{}", { mode: 0o600 });
  expect(
    await rpc("source.inspect", { ...f.scope, source_id: "local" }),
  ).toMatchObject({ ok: true, result: { state: "unknown", entries: [] } });
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    ...args: unknown[]
  ) => {
    output.push(String(chunk));
    const callback = args.find((arg) => typeof arg === "function") as
      | (() => void)
      | undefined;
    queueMicrotask(() => callback?.());
    return true;
  }) as typeof process.stdout.write);
  expect(
    await main([
      "sources",
      "inspect",
      "local",
      "--repo",
      f.repo,
      "--default-tenant",
      "--json",
    ]),
  ).toBe(1);
  expect(JSON.parse(output.join(""))).toMatchObject({
    state: "unknown",
    entries: [],
  });
});

it("inspects a pinned snapshot through the real daemon and main CLI and honors live revocation", async () => {
  const { repo, scope } = await fixture(false, false);
  const { writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { localSourceManifestDigest } = await import(
    "./local-data-source-registry.js"
  );
  const data = join(root!, "data");
  await mkdir(data);
  const now = Date.now();
  const content = JSON.stringify({
    schema_version: 1,
    source_id: "notes",
    version: "1",
    revision: 1,
    entries: [{ id: "one", text: "read-only external context" }],
  });
  await writeFile(join(data, "notes.json"), content);
  const manifest = {
    schema_version: 1,
    id: "notes",
    version: "1",
    protocol: "local_json_snapshot_v1",
    repo_path: repo,
    default_tenant: true,
    capabilities: ["snapshot.read"],
    file: "notes.json",
    max_bytes: 65536,
    max_items: 20,
    read_timeout_ms: 1000,
    verified_at_ms: now,
    expires_at_ms: now + 60000,
    fresh_for_ms: 60000,
  };
  const config = join(root!, "source-registry.json");
  await writeFile(
    config,
    JSON.stringify({
      schema_version: 1,
      registrations: [
        {
          source_root: data,
          manifest,
          manifest_digest: localSourceManifestDigest(manifest),
          content_digest: createHash("sha256").update(content).digest("hex"),
        },
      ],
    }),
    { mode: 0o600 },
  );
  expect(
    await rpc("source.inspect", { source_id: "notes", ...scope }),
  ).toMatchObject({
    ok: true,
    result: {
      state: "ready",
      actions: "unsupported",
      entries: [{ id: "one", text: "read-only external context" }],
    },
  });
  expect(
    await rpc("source.inspect", {
      source_id: "notes",
      ...scope,
      repo_path: root,
    }),
  ).toMatchObject({
    ok: true,
    result: { state: "not_registered", entries: [] },
  });
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((
    text: string,
    cb?: () => void,
  ) => {
    output.push(String(text));
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stdout.write);
  expect(
    await main([
      "sources",
      "inspect",
      "notes",
      "--repo",
      repo,
      "--default-tenant",
      "--json",
    ]),
  ).toBe(0);
  expect(JSON.parse(output.join(""))).toMatchObject({
    state: "ready",
    scope: { repo_path: repo, tenant: "default" },
  });
  await writeFile(
    config,
    JSON.stringify({ schema_version: 1, registrations: [] }),
  );
  expect(
    await rpc("source.inspect", { source_id: "notes", ...scope }),
  ).toMatchObject({
    ok: true,
    result: { state: "not_registered", entries: [] },
  });
});

it("keeps public delivery unavailable without trusted host targets even through the real CLI", async () => {
  const { repo, scope } = await fixture(false, false);
  const { writeFile } = await import("node:fs/promises");
  const created=await rpc("follow-up.create",{...scope,source_session_id:"session",expected_source_version:1,idempotency_key:"default-ob",actor:"test",promise:"reply",destination_ref:"local_operator",resolution_condition:"manual"});
  expect(created.ok).toBe(true);
  const obligationId=(created.result!["obligation"] as {obligation_id:string}).obligation_id;
  const file = join(root!, "prepare.json");
  await writeFile(
    file,
    JSON.stringify({
      obligation_id: obligationId,
      expected_obligation_revision: 1,
      destination_ref: "arbitrary",
      body: "body",
      idempotency_key: "key",
    }),
  );
  const errors = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  expect(
    await main([
      "follow-up-delivery",
      "prepare",
      "--repo",
      repo,
      "--default-tenant",
      "--input",
      file,
    ]),
  ).toBe(1);
  expect(errors.mock.calls.map(call=>String(call[0])).join("")).toContain("delivery_destination_unavailable");
  expect(
    await rpc("follow-up-delivery.prepare", {
      ...scope,
      obligation_id: obligationId,
      expected_obligation_revision: 1,
      destination_ref: "arbitrary",
      body: "body",
      idempotency_key: "key",
      transport: "injected",
    }),
  ).toMatchObject({ ok: false });
  const db = openDb({ path: daemon!.dbPath });
  try {
    expect(
      db.prepare("SELECT count(*) n FROM follow_up_delivery_attempts").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

async function deliveryFixture(hang = false) {
  const { repo, scope } = await fixture(false, false);
  await daemon!.close();
  const { generateKeyPairSync, randomUUID, sign } = await import("node:crypto");
  const { deliveryCanonical } = await import("@osstack/core");
  const { FollowUpDeliveryResult } = await import("@osstack/protocol");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let release!: () => void;
  let sends = 0;
  const options: NonNullable<StartDaemonOptions["followUpDeliveryOptions"]> = {
    nowMs: () => 10000,
    timeoutMs: 100,
    allowTestTransports: true,
    targets: new Map([
      [
        "thread",
        {
          destination_ref: "thread",
          repo_path: repo,
          provider_id: "github_comment",
          account_id: "bot",
          host: "github.com",
          owner: "owner",
          repository: "repo",
          issue_number: 1,
          target_node_id: "node",
          actor_node_id: "actor",
        },
      ],
    ]),
    trustedKeys: new Map([
      [
        "key",
        {
          publicKey,
          purpose: "follow_up_delivery",
          repo_path: repo,
          provider_id: "github_comment",
          destination_refs: ["thread"],
          max_validity_ms: 60000,
        },
      ],
    ]),
    transports: new Map([
      [
        "github_comment",
        {
          qualification: "test_only",
          automatic_retries: false,
          lookup_receipt: true,
          sendOnce: async (e) => {
            sends++;
            if (hang)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return {
              provider_id: e.destination.provider_id,
              account_id: e.destination.account_id,
              target_node_id: e.destination.target_node_id,
              author_node_id: e.destination.actor_node_id,
              destination_digest: e.destination_digest,
              body_sha256: e.body_sha256,
              attempt_id: e.attempt_id,
              provider_message_id: "message",
              provider_request_id: "request",
            };
          },
          lookup: async () => null,
        },
      ],
    ]),
  };
  await start({ followUpDeliveryOptions: options });
  const created = await rpc("follow-up.create", {
    ...scope,
    source_session_id: "session",
    expected_source_version: 1,
    idempotency_key: "ob",
    actor: "local_test",
    promise: "reply",
    destination_ref: "local_operator",
    resolution_condition: "manual",
  });
  expect(created.ok).toBe(true);
  const obligation = created.result!["obligation"] as { obligation_id: string };
  const prepared = await rpc("follow-up-delivery.prepare", {
    ...scope,
    obligation_id: obligation.obligation_id,
    expected_obligation_revision: 1,
    destination_ref: "thread",
    body: "literal body",
    idempotency_key: "send",
  });
  expect(prepared.ok).toBe(true);
  const attempt = FollowUpDeliveryResult.parse(prepared.result).attempt;
  const body = {
    ...attempt.authorization_subject,
    grant_id: randomUUID(),
    issued_at_ms: 10000,
    expires_at_ms: 20000,
    max_calls: 1,
  };
  const authorized = await rpc("follow-up-delivery.authorize", {
    ...scope,
    attempt_id: attempt.attempt_id,
    expected_revision: attempt.revision,
    grant: {
      body,
      key_id: "key",
      signature: sign(
        null,
        Buffer.from(deliveryCanonical(body)),
        privateKey,
      ).toString("base64"),
    },
  });
  expect(authorized.ok).toBe(true);
  const ready = FollowUpDeliveryResult.parse(authorized.result).attempt;
  return {
    repo,
    scope,
    attempt: ready,
    sends: () => sends,
    release: () => release(),
  };
}
it("runs one signed fake delivery through main CLI without declaring a production send or resolving the promise", async () => {
  const f = await deliveryFixture();
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(
    await main([
      "follow-up-delivery",
      "dispatch",
      f.attempt.attempt_id,
      "--repo",
      f.repo,
      "--default-tenant",
      "--revision",
      String(f.attempt.revision),
    ]),
  ).toBe(1);
  expect(JSON.parse(out.mock.calls.at(-1)![0] as string)).toMatchObject({
    attempt: { state: "delivered", qualification: "test_only" },
  });
  expect(f.sends()).toBe(1);
  expect(
    await rpc("follow-up-delivery.dispatch", {
      ...f.scope,
      attempt_id: f.attempt.attempt_id,
      expected_revision: f.attempt.revision,
    }),
  ).toMatchObject({ ok: false });
  expect(f.sends()).toBe(1);
  const db = openDb({ path: daemon!.dbPath });
  try {
    expect(db.prepare("SELECT state FROM follow_up_obligations").get()).toEqual(
      { state: "open" },
    );
  } finally {
    db.close();
  }
});
it("waits for bounded delivery finalization before closing the DB and never accepts a late success", async () => {
  const f = await deliveryFixture(true);
  const dbPath = daemon!.dbPath;
  const pending = rpc("follow-up-delivery.dispatch", {
    ...f.scope,
    attempt_id: f.attempt.attempt_id,
    expected_revision: f.attempt.revision,
  });
  await vi.waitFor(() => expect(f.sends()).toBe(1));
  await daemon!.close();
  daemon = undefined;
  await pending;
  f.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const db = openDb({ path: dbPath });
  try {
    expect(
      db.prepare("SELECT state FROM follow_up_delivery_attempts").get(),
    ).toEqual({ state: "delivery_unknown" });
    expect(db.prepare("SELECT state FROM follow_up_obligations").get()).toEqual(
      { state: "open" },
    );
  } finally {
    db.close();
  }
});

it("reads separately authorized output through the real CLI/socket and rejects live revocation", async()=>{
  const f=await fixture(false,false); const {writeFile,chmod}=await import("node:fs/promises");
  const {createHash}=await import("node:crypto"); const home=realpathSync(root!); await chmod(home,0o700);
  const token="x".repeat(43);const now=Date.now(); const file=join(home,"worker-log-grants.json");
  await writeFile(file,JSON.stringify({schema_version:1,grants:[{repo_path:f.repo,session_id:"session",capability_sha256:createHash("sha256").update(token).digest("hex"),issued_at_ms:now,expires_at_ms:now+60000,content:"persisted_assistant_text"}]}),{mode:0o600});
  const grant=join(home,"log-reader.json");await writeFile(grant,JSON.stringify({...f.scope,capability:token}),{mode:0o600});
  const db=openDb({path:daemon!.dbPath});db.prepare("UPDATE session_turns SET assistant_text='visible authorized transcript'").run();db.close();
  const out=vi.spyOn(console,"log").mockImplementation(()=>{});
  expect(await main(["worker","logs","--grant-file",grant])).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({content:"persisted_assistant_text",entries:[{text:"visible authorized transcript"}]});
  await writeFile(file,JSON.stringify({schema_version:1,grants:[]}));
  expect(await main(["worker","logs","--grant-file",grant])).toBe(1);
  expect(String(out.mock.calls.at(-1)?.[0])).not.toContain("visible authorized transcript");
});

it("routes pinned viewer launch to the real inspection service and consumes its handoff once",async()=>{
  const f=await fixture(false,false);const {writeFile,readFile,readdir,chmod}=await import("node:fs/promises");const {createHash}=await import("node:crypto");
  const home=realpathSync(root!);await chmod(home,0o700);const backend=join(home,"backend.cjs");
  const source=`#!${process.execPath}\nif(process.argv[2]==='-V')console.log('fixture-backend');else console.log('%3');\n`;
  await writeFile(backend,source,{mode:0o700});const pin={path:backend,sha256:createHash("sha256").update(source).digest("hex")};
  await writeFile(join(home,"viewer-backends.json"),JSON.stringify({schema_version:1,home,node:pin,cli:pin,backends:[{kind:"tmux",executable:pin,version_output:"fixture-backend",socket:realpathSync(socket),target:"$1",shell:"posix"}]}),{mode:0o600});
  const page=await rpc("worker.list",f.scope);const view=(page.result!["views"] as {view_id:string}[])[0]!.view_id;
  const out=vi.spyOn(console,"log").mockImplementation(()=>{});
  expect(await main(["worker","open",view,"--backend","tmux","--repo",f.repo,"--default-tenant","--duration-ms","1000"])).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({state:"launch_requested",qualification:"backend_runtime_pending"});
  const handoff=join(home,(await readdir(home)).find(n=>n.startsWith("viewer-handoff-"))!);
  expect(JSON.parse(await readFile(handoff,"utf8")).reference.view_id).toBe(view);
  vi.spyOn(process.stdout,"write").mockImplementation(((...args:unknown[])=>{const callback=args.find(a=>typeof a==="function") as (()=>void)|undefined;queueMicrotask(()=>callback?.());return true;}) as typeof process.stdout.write);
  expect(await main(["worker","watch-handoff",handoff])).toBe(0);
  vi.spyOn(console,"error").mockImplementation(()=>{});
  expect(await main(["worker","watch-handoff",handoff])).toBe(1);
});
