import type { FollowUpDeliveryEnvelope } from "@osstack/protocol";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { FollowUpObligationService } from "./follow-up-obligations.js";
import { FollowUpDeliveryService, deliveryCanonical, type FollowUpTransport } from "./follow-up-delivery.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "follow-delivery"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const dbPath = join(root, "state.db"),
    db = openDb({ path: dbPath });
  cleanup.push(() => db.close());
  db.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','task','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)",
  );
  db.prepare(
    "INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','codex-cli',?,?,'idle',1,1,1)",
  ).run("a".repeat(64), repo);
  const scope = { repo_path: repo, default_tenant: true as const };
  let now = 10000;
  const obligation = new FollowUpObligationService(db, dbPath, { nowMs: () => now }).create({
    ...scope,
    source_session_id: "s",
    expected_source_version: 1,
    idempotency_key: "first",
    actor: "test",
    promise: "Reply publicly",
    destination_ref: "local_operator",
    resolution_condition: "manual",
  }).obligation;
  const target = {
    destination_ref: "project-thread",
    repo_path: repo,
    provider_id: "github_comment" as const,
    account_id: "bot-1",
    host: "github.com" as const,
    owner: "owner",
    repository: "repo",
    issue_number: 123,
    target_node_id: "thread-node",
    actor_node_id: "actor-node",
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKeys = new Map([
    [
      "test-key",
      {
        publicKey,
        purpose: "follow_up_delivery" as const,
        repo_path: repo,
        provider_id: "github_comment" as const,
        destination_refs: [target.destination_ref],
        max_validity_ms: 60000,
      },
    ],
  ]);
  const sends = vi.fn(async (envelope: FollowUpDeliveryEnvelope) => ({
    provider_id: target.provider_id,
    account_id: target.account_id,
    target_node_id: target.target_node_id,
    author_node_id: target.actor_node_id,
    destination_digest: envelope.destination_digest,
    body_sha256: envelope.body_sha256,
    attempt_id: envelope.attempt_id,
    provider_message_id: "message-1",
    provider_request_id: "request-1",
  }));
  const transport: FollowUpTransport = {
    qualification: "test_only",
    automatic_retries: false,
    lookup_receipt: true,
    sendOnce: sends,
    lookup: async () => null,
  };
  const options = {
    targets: new Map([[target.destination_ref, target]]),
    trustedKeys,
    transports: new Map([[target.provider_id, transport]]),
    allowTestTransports: true,
    nowMs: () => now,
    timeoutMs: 30,
  };
  const service = new FollowUpDeliveryService(db, dbPath, options);
  const prepare = () =>
    service.prepare({
      ...scope,
      obligation_id: obligation.obligation_id,
      expected_obligation_revision: 1,
      destination_ref: target.destination_ref,
      body: "Exact public reply",
      idempotency_key: "attempt-one",
    });
  const grantFor = (attempt: ReturnType<typeof prepare>["attempt"], patch: Record<string, unknown> = {}) => {
    const body = {
      ...attempt.authorization_subject,
      grant_id: "11111111-1111-4111-8111-111111111111",
      issued_at_ms: now,
      expires_at_ms: now + 60000,
      max_calls: 1 as const,
      ...patch,
    };
    return {
      body,
      key_id: "test-key",
      signature: sign(null, Buffer.from(deliveryCanonical(body)), privateKey).toString("base64"),
    };
  };
  const authorize = (attempt: ReturnType<typeof prepare>["attempt"]) =>
    service.authorize({
      ...scope,
      attempt_id: attempt.attempt_id,
      expected_revision: attempt.revision,
      grant: grantFor(attempt),
    });
  return {
    root,
    repo,
    db,
    dbPath,
    scope,
    obligation,
    target,
    transport,
    options,
    service,
    sends,
    prepare,
    authorize,
    grantFor,
    privateKey,
    now: (value: number) => {
      now = value;
    },
  };
}
it("prepares exact reviewable data but a caller cannot grant authority by actor or receipt fields", async () => {
  const f = fixture();
  const a = f.prepare().attempt;
  expect(a.envelope.body).toBe("Exact public reply");
  expect(a.state).toBe("prepared");
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_authorization_required");
  expect(f.sends).not.toHaveBeenCalled();
  expect(() =>
    f.service.authorize({
      ...f.scope,
      attempt_id: a.attempt_id,
      expected_revision: a.revision,
      approved: true,
      actor: "human",
    }),
  ).toThrow("invalid_delivery_request");
});
it("signed single-attempt dispatch does not fulfill the local obligation and cannot send twice", async () => {
  const f = fixture();
  const a = f.authorize(f.prepare().attempt).attempt;
  const result = await f.service.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
  });
  expect(result.attempt).toMatchObject({ state: "delivered", qualification: "test_only" });
  expect(f.sends).toHaveBeenCalledTimes(1);
  await f.service.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: result.attempt.revision,
  });
  expect(f.sends).toHaveBeenCalledTimes(1);
  expect(f.db.prepare("SELECT state FROM follow_up_obligations").get()).toEqual({ state: "open" });
});
it("unregistered provider leaves authorization unconsumed and never records started", async () => {
  const f = fixture();
  const a = f.authorize(f.prepare().attempt).attempt;
  f.options.transports.clear();
  const result = await f.service.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
  });
  expect(result).toMatchObject({
    outcome: "qualification_pending",
    attempt: { state: "prepared", authorization_status: "active" },
  });
  expect(f.sends).not.toHaveBeenCalled();
});

it.each([
  { domain: "osstack.session-continuation.v1" },
  { attempt_id: "22222222-2222-4222-8222-222222222222" },
  { body_sha256: "c".repeat(64) },
  { destination_digest: "c".repeat(64) },
  { account_id: "other" },
  { provider_id: "email" },
  { max_calls: 2 },
  { repo_path: "/other" },
  { default_tenant: false },
])("rejects a signed grant with a changed binding %j", (patch) => {
  const f = fixture(),
    a = f.prepare().attempt;
  expect(() =>
    f.service.authorize({
      ...f.scope,
      attempt_id: a.attempt_id,
      expected_revision: a.revision,
      grant: f.grantFor(a, patch),
    }),
  ).toThrow();
  expect(f.sends).not.toHaveBeenCalled();
  expect(f.service.inspect({ ...f.scope, attempt_id: a.attempt_id }).attempt.authorization_status).toBe(
    "missing",
  );
});
it("rechecks expiration, key scope and revocation immediately before consumption", async () => {
  const f = fixture();
  let a = f.authorize(f.prepare().attempt).attempt;
  f.now(70000);
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_authorization_expired");
  f.now(70000);
  f.options.trustedKeys.clear();
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_invalid_authorization");
  a = f.service.revoke({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
    reason: "Operator revoked exact message",
  }).attempt;
  expect(a).toMatchObject({ state: "definitely_not_sent", authorization_status: "revoked" });
  expect(
    (await f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }))
      .attempt.state,
  ).toBe("definitely_not_sent");
  expect(f.sends).not.toHaveBeenCalled();
});
it("rejects a future grant and a signature made by an untrusted key", () => {
  const f = fixture(),
    a = f.prepare().attempt;
  expect(() =>
    f.service.authorize({
      ...f.scope,
      attempt_id: a.attempt_id,
      expected_revision: a.revision,
      grant: f.grantFor(a, { issued_at_ms: 11000, expires_at_ms: 12000 }),
    }),
  ).toThrow("delivery_authorization_expired");
  const grant = f.grantFor(a),
    other = generateKeyPairSync("ed25519");
  grant.signature = sign(null, Buffer.from(deliveryCanonical(grant.body)), other.privateKey).toString(
    "base64",
  );
  expect(() =>
    f.service.authorize({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision, grant }),
  ).toThrow("delivery_invalid_authorization");
});
it("two SQLite connections cannot dispatch the same attempt twice", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  const otherDb = openDb({ path: f.dbPath });
  cleanup.push(() => otherDb.close());
  const other = new FollowUpDeliveryService(otherDb, f.dbPath, f.options);
  const calls = await Promise.allSettled([
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
    other.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ]);
  expect(calls.filter((c) => c.status === "fulfilled")).toHaveLength(1);
  expect(calls.filter((c) => c.status === "rejected")).toHaveLength(1);
  expect(f.sends).toHaveBeenCalledTimes(1);
});
it("lost response is unknown and blocks re-sending or replacement with a new idempotency key", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  f.sends.mockRejectedValueOnce(new Error("provider accepted; response lost; PRIVATE_TOKEN"));
  const result = await f.service.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
  });
  expect(result.attempt).toMatchObject({
    state: "delivery_unknown",
    authorization_status: "consumed",
    delivery_uncertain: true,
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN");
  const restarted = new FollowUpDeliveryService(f.db, f.dbPath, f.options);
  await restarted.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: result.attempt.revision,
  });
  expect(() =>
    restarted.prepare({
      ...f.scope,
      obligation_id: f.obligation.obligation_id,
      expected_obligation_revision: 1,
      destination_ref: f.target.destination_ref,
      body: "Different text still cannot bypass uncertainty",
      idempotency_key: "different",
    }),
  ).toThrow("delivery_unresolved_attempt");
  expect(f.sends).toHaveBeenCalledTimes(1);
});
it("timeout persists unknown; late response cannot silently overwrite it", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  let release: (value: unknown) => void = () => {};
  f.transport.sendOnce = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const result = await f.service.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
  });
  expect(result.attempt.state).toBe("delivery_unknown");
  release({
    provider_id: f.target.provider_id,
    account_id: f.target.account_id,
    target_node_id: f.target.target_node_id,
    author_node_id: f.target.actor_node_id,
    destination_digest: a.envelope.destination_digest,
    body_sha256: a.envelope.body_sha256,
    attempt_id: a.attempt_id,
    provider_message_id: "m",
    provider_request_id: "r",
  });
  await new Promise((r) => setImmediate(r));
  expect(f.service.inspect({ ...f.scope, attempt_id: a.attempt_id }).attempt).toMatchObject({
    state: "delivery_unknown",
    revision: result.attempt.revision,
  });
});
it.each([
  "target_node_id",
  "author_node_id",
  "account_id",
  "destination_digest",
  "body_sha256",
  "attempt_id",
])("rejects a provider receipt with wrong %s", async (field) => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  const good = f.sends.getMockImplementation()!;
  f.sends.mockImplementation(async (e) => ({
    ...(await good(e)),
    [field]:
      field.endsWith("digest") || field === "body_sha256"
        ? "c".repeat(64)
        : field === "attempt_id"
          ? "22222222-2222-4222-8222-222222222222"
          : "other",
  }));
  expect(
    (await f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }))
      .attempt.state,
  ).toBe("delivery_unknown");
});
it("reconciliation uses only the trusted lookup port; user receipt assertions and not-found never prove delivery", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  const receipt = await f.sends.getMockImplementation()!(a.envelope);
  f.sends.mockRejectedValueOnce(Error("lost"));
  let current = (
    await f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision })
  ).attempt;
  await expect(
    f.service.reconcile({
      ...f.scope,
      attempt_id: a.attempt_id,
      expected_revision: current.revision,
      delivered: true,
      receipt,
    }),
  ).rejects.toThrow("invalid_delivery_request");
  current = (
    await f.service.reconcile({ ...f.scope, attempt_id: a.attempt_id, expected_revision: current.revision })
  ).attempt;
  expect(current.state).toBe("delivery_unknown");
  f.transport.lookup = async () => receipt;
  current = (
    await f.service.reconcile({ ...f.scope, attempt_id: a.attempt_id, expected_revision: current.revision })
  ).attempt;
  expect(current).toMatchObject({ state: "delivered", qualification: "test_only" });
  expect(f.sends).toHaveBeenCalledTimes(1);
});
it("automatic-retry or unqualified fake transports cannot consume an authorization", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  f.transport.automatic_retries = true;
  expect(
    (await f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }))
      .outcome,
  ).toBe("qualification_pending");
  f.transport.automatic_retries = false;
  const production = new FollowUpDeliveryService(f.db, f.dbPath, {
    ...f.options,
    allowTestTransports: false,
  });
  expect(
    (await production.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }))
      .outcome,
  ).toBe("qualification_pending");
  expect(f.sends).not.toHaveBeenCalled();
});
it("target or obligation changes after approval fail before send", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  f.options.targets.set(f.target.destination_ref, { ...f.target, issue_number: 456 });
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_destination_unavailable");
  f.options.targets.set(f.target.destination_ref, f.target);
  new FollowUpObligationService(f.db, f.dbPath, { nowMs: () => 10000 }).draft({
    ...f.scope,
    obligation_id: f.obligation.obligation_id,
    expected_revision: 1,
    actor: "test",
  });
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_obligation_changed");
  expect(f.sends).not.toHaveBeenCalled();
});
it("scope, idempotency and append-only history remain durable", () => {
  const f = fixture(),
    a = f.prepare().attempt;
  expect(f.prepare()).toMatchObject({ duplicate: true, attempt: { attempt_id: a.attempt_id } });
  expect(() =>
    f.service.prepare({
      ...f.scope,
      obligation_id: f.obligation.obligation_id,
      expected_obligation_revision: 1,
      destination_ref: f.target.destination_ref,
      body: "changed",
      idempotency_key: "attempt-one",
    }),
  ).toThrow("delivery_idempotency_conflict");
  expect(() =>
    f.service.inspect({ repo_path: f.root, default_tenant: true, attempt_id: a.attempt_id }),
  ).toThrow("delivery_not_found");
  expect(() => f.db.prepare("UPDATE follow_up_delivery_attempts SET envelope_json='{}'").run()).toThrow(
    /identity immutable/,
  );
  expect(() => f.db.prepare("DELETE FROM follow_up_delivery_events").run()).toThrow(/history immutable/);
  const before = Buffer.from(f.db.serialize());
  f.service.list(f.scope);
  expect(f.db.serialize().equals(before)).toBe(true);
});
it("survives SIGKILL after durable consumption with no resend on restart", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  const config = join(f.root, "child-input.json"),
    entry = join(f.root, "child.mjs"),
    marker = join(f.root, "called");
  writeFileSync(
    config,
    JSON.stringify({
      dbPath: f.dbPath,
      repo: f.repo,
      target: f.target,
      publicKey: f.options.trustedKeys.get("test-key")!.publicKey.export({ format: "pem", type: "spki" }),
      action: { ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision },
      marker,
    }),
  );
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(f.root, "node_modules"),
    "dir",
  );
  buildSync({
    stdin: {
      contents: `import {readFileSync,writeFileSync} from 'node:fs';import {createPublicKey} from 'node:crypto';import {openDb} from ${JSON.stringify(fileURLToPath(new URL("./db.ts", import.meta.url)))};import {FollowUpDeliveryService} from ${JSON.stringify(fileURLToPath(new URL("./follow-up-delivery.ts", import.meta.url)))};
 const c=JSON.parse(readFileSync(process.argv[2],'utf8'));const db=openDb({path:c.dbPath});const service=new FollowUpDeliveryService(db,c.dbPath,{targets:new Map([[c.target.destination_ref,c.target]]),trustedKeys:new Map([['test-key',{publicKey:createPublicKey(c.publicKey),purpose:'follow_up_delivery',repo_path:c.repo,provider_id:'github_comment',destination_refs:[c.target.destination_ref],max_validity_ms:60000}]]),transports:new Map([['github_comment',{qualification:'test_only',automatic_retries:false,lookup_receipt:true,sendOnce:async()=>{writeFileSync(c.marker,'once');process.kill(process.pid,'SIGKILL');},lookup:async()=>null}]]),allowTestTransports:true,nowMs:()=>10000});await service.dispatch(c.action);`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: entry,
    logLevel: "silent",
  });
  const child = spawnSync(process.execPath, [entry, config], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, OSSTACK_HOME: join(f.root, "child-home") },
  });
  expect(child.stderr).toBe("");
  expect(child.signal).toBe("SIGKILL");
  expect(readFileSync(marker, "utf8")).toBe("once");
  const restarted = new FollowUpDeliveryService(f.db, f.dbPath, f.options);
  let current = restarted.inspect({ ...f.scope, attempt_id: a.attempt_id }).attempt;
  expect(current).toMatchObject({
    state: "started",
    authorization_status: "consumed",
    delivery_uncertain: true,
  });
  expect(
    (await restarted.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: current.revision }))
      .outcome,
  ).toBe("in_flight");
  expect(f.sends).not.toHaveBeenCalled();
  current = (
    await restarted.reconcile({ ...f.scope, attempt_id: a.attempt_id, expected_revision: current.revision })
  ).attempt;
  expect(current.state).toBe("delivery_unknown");
  expect(f.sends).not.toHaveBeenCalled();
});
it("upgrades a real schema 44 database, preserving source rows and immutable 44 lineage", () => {
  const f = fixture(),
    path = join(f.root, "old.db"),
    old = new Database(path);
  for (const migration of MIGRATIONS.filter((m) => m.id <= 44)) old.exec(migration.sql);
  old.pragma("user_version=44");
  old.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('old','preserved','running',1,1)",
  );
  old.close();
  const upgraded = openDb({ path });
  cleanup.push(() => upgraded.close());
  expect(upgraded.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  expect(upgraded.prepare("SELECT title FROM tasks WHERE task_id='old'").get()).toEqual({
    title: "preserved",
  });
  expect(upgraded.prepare("SELECT count(*) AS n FROM follow_up_delivery_attempts").get()).toEqual({ n: 0 });
  expect(
    createHash("sha256")
      .update(MIGRATIONS.find((m) => m.id === 44)!.sql)
      .digest("hex"),
  ).toBe("4c40310b23a7f7348985d4aecf2042e69843e06361d74a0c5b8792de39897aa6");
});
it("rejects oversized escaped content before preparing and preserves exact accepted body", async () => {
  const f = fixture();
  const input = {
    ...f.scope,
    obligation_id: f.obligation.obligation_id,
    expected_obligation_revision: 1,
    destination_ref: f.target.destination_ref,
    idempotency_key: "big",
    body: "body" + "\0".repeat(15900),
  };
  expect(() => f.service.prepare(input)).toThrow("delivery_response_too_large");
  expect(f.db.prepare("SELECT count(*) AS n FROM follow_up_delivery_attempts").get()).toEqual({ n: 0 });
  expect(f.sends).not.toHaveBeenCalled();
  const body = "body" + "\0".repeat(7000);
  let a = f.service.prepare({ ...input, body }).attempt;
  a = f.authorize(a).attempt;
  f.transport.sendOnce = async (envelope) => ({
    provider_id: f.target.provider_id,
    account_id: f.target.account_id,
    target_node_id: f.target.target_node_id,
    author_node_id: f.target.actor_node_id,
    destination_digest: envelope.destination_digest,
    body_sha256: envelope.body_sha256,
    attempt_id: envelope.attempt_id,
    provider_message_id: "m" + "\0".repeat(255),
    provider_request_id: "r" + "\0".repeat(255),
  });
  const result = await f.service.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
  });
  expect(result.attempt.state).toBe("delivered");
  expect(result.attempt.envelope.body).toBe(body);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
});

it("revocation racing an in-flight send preserves unknown until explicit lookup", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  let release: (value: unknown) => void = () => {};
  let entered: () => void = () => {};
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const receipt = await f.sends.getMockImplementation()!(a.envelope);
  f.transport.sendOnce = () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision });
  await called;
  const started = f.service.inspect({ ...f.scope, attempt_id: a.attempt_id }).attempt;
  const revoked = f.service.revoke({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: started.revision,
    reason: "Stop future authority",
  }).attempt;
  release(receipt);
  expect((await pending).attempt).toMatchObject({
    state: "delivery_unknown",
    revision: revoked.revision,
    authorization_status: "consumed",
    receipt: null,
  });
  expect(() => f.db.prepare("UPDATE follow_up_delivery_grants SET state='active'").run()).toThrow(
    /cannot rearm/,
  );
  expect(() => f.db.prepare("UPDATE follow_up_delivery_attempts SET state='prepared'").run()).toThrow(
    /cannot rewind/,
  );
  f.transport.lookup = async () => receipt;
  expect(
    (await f.service.reconcile({ ...f.scope, attempt_id: a.attempt_id, expected_revision: revoked.revision }))
      .attempt,
  ).toMatchObject({ state: "delivered", authorization_status: "consumed" });
});
it("service construction is read-only and bare provider booleans cannot prove sending", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  const before = f.db.serialize();
  new FollowUpDeliveryService(f.db, f.dbPath, f.options);
  expect(f.db.serialize().equals(before)).toBe(true);
  f.transport.sendOnce = async () => true;
  expect(
    (await f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }))
      .attempt.state,
  ).toBe("delivery_unknown");
});
it.each([
  9999,
  NaN,
  Infinity,
])("allows authority removal despite clock regression or invalid clock %s", (now) => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  f.now(now);
  const revoked = f.service.revoke({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
    reason: "Remove authority regardless of time",
  }).attempt;
  expect(revoked).toMatchObject({
    state: "definitely_not_sent",
    authorization_status: "revoked",
    updated_at_ms: 10000,
  });
  expect(f.sends).not.toHaveBeenCalled();
});
it("a delivered obligation needs a fresh explicit attempt and signed grant for any additional message", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  await f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision });
  const second = f.service.prepare({
    ...f.scope,
    obligation_id: f.obligation.obligation_id,
    expected_obligation_revision: 1,
    destination_ref: f.target.destination_ref,
    idempotency_key: "explicit-new-message",
    body: "Separately reviewed update",
  }).attempt;
  expect(second.attempt_id).not.toBe(a.attempt_id);
  expect(second.authorization_status).toBe("missing");
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: second.attempt_id, expected_revision: second.revision }),
  ).rejects.toThrow("delivery_authorization_required");
  expect(f.sends).toHaveBeenCalledTimes(1);
});

it("a settled timed-out handle performs no DB work when a transport resolves after database close", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  const other = openDb({ path: f.dbPath });
  const receipt = await f.sends.getMockImplementation()!(a.envelope);
  let release: (value: unknown) => void = () => {};
  f.transport.sendOnce = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const service = new FollowUpDeliveryService(other, f.dbPath, f.options);
  try {
    const settled = await service.handle("follow-up-delivery.dispatch", {
      ...f.scope,
      attempt_id: a.attempt_id,
      expected_revision: a.revision,
    });
    expect(settled).toMatchObject({ attempt: { state: "delivery_unknown" } });
    const prepare = vi.spyOn(other, "prepare");
    other.close();
    release(receipt);
    await new Promise((resolve) => setImmediate(resolve));
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    if (other.open) other.close();
  }
});

it("requires FULL durable consumption and restores the shared connection settings before transport", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  const initial = f.db.pragma("synchronous", { simple: true }),
    fsync = f.db.pragma("fullfsync", { simple: true });
  const original = f.db.prepare.bind(f.db),
    observed: unknown[] = [];
  vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    if (sql.includes("UPDATE follow_up_delivery_grants SET state='consumed'")) {
      observed.push(f.db.pragma("synchronous", { simple: true }));
      if (process.platform === "darwin") expect(f.db.pragma("fullfsync", { simple: true })).toBe(1);
    }
    return original(sql);
  });
  const good = f.transport.sendOnce;
  f.transport.sendOnce = async (e, signal) => {
    expect(f.db.pragma("synchronous", { simple: true })).toBe(initial);
    return good(e, signal);
  };
  expect(
    (await f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }))
      .attempt.state,
  ).toBe("delivered");
  expect(observed).toEqual([2]);
  expect(f.db.pragma("synchronous", { simple: true })).toBe(initial);
  expect(f.db.pragma("fullfsync", { simple: true })).toBe(fsync);
});
it("fails closed before consumption when the database is not in WAL mode", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  f.db.pragma("journal_mode=DELETE");
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_durability_unavailable");
  expect(f.service.inspect({ ...f.scope, attempt_id: a.attempt_id }).attempt.authorization_status).toBe(
    "active",
  );
  expect(f.sends).not.toHaveBeenCalled();
});
it("persists observed expiry even when authorization checks fail, including across service restart", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  f.now(70000);
  await expect(
    f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_authorization_expired");
  f.now(10000);
  const restarted = new FollowUpDeliveryService(f.db, f.dbPath, f.options);
  await expect(
    restarted.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
  ).rejects.toThrow("delivery_invalid_clock");
  expect(f.db.prepare("SELECT observed_at_ms FROM follow_up_delivery_clock").get()).toEqual({
    observed_at_ms: 70000,
  });
  expect(f.sends).not.toHaveBeenCalled();
  expect(
    restarted.revoke({
      ...f.scope,
      attempt_id: a.attempt_id,
      expected_revision: a.revision,
      reason: "Clock regressed",
    }).attempt.state,
  ).toBe("definitely_not_sent");
});
it("records an irreversible result under logical time even if the wall clock regresses during send", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt,
    good = f.transport.sendOnce;
  f.transport.sendOnce = async (e, s) => {
    const receipt = await good(e, s);
    f.now(1);
    return receipt;
  };
  const result = await f.service.dispatch({
    ...f.scope,
    attempt_id: a.attempt_id,
    expected_revision: a.revision,
  });
  expect(result.attempt).toMatchObject({ state: "delivered", updated_at_ms: 10000 });
});
it("retains exact historical scope for inspection and revocation after the repository moves", () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt;
  renameSync(f.repo, join(f.root, "moved-repo"));
  expect(f.service.inspect({ ...f.scope, attempt_id: a.attempt_id }).attempt.attempt_id).toBe(a.attempt_id);
  expect(f.service.list(f.scope).attempts).toHaveLength(1);
  expect(() =>
    f.service.inspect({ ...f.scope, repo_path: join(f.root, "moved-repo"), attempt_id: a.attempt_id }),
  ).toThrow("delivery_not_found");
  expect(
    f.service.revoke({
      ...f.scope,
      attempt_id: a.attempt_id,
      expected_revision: a.revision,
      reason: "Moved repository",
    }).attempt.state,
  ).toBe("definitely_not_sent");
});
it("an existing writer prevents claim before any consuming read or network call", async () => {
  const f = fixture(),
    a = f.authorize(f.prepare().attempt).attempt,
    other = openDb({ path: f.dbPath });
  f.db.pragma("busy_timeout=10");
  other.exec("BEGIN IMMEDIATE");
  const original = f.db.prepare.bind(f.db),
    claimReads: string[] = [];
  vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    if (sql.includes("SELECT * FROM follow_up_delivery_attempts")) claimReads.push(sql);
    return original(sql);
  });
  try {
    await expect(
      f.service.dispatch({ ...f.scope, attempt_id: a.attempt_id, expected_revision: a.revision }),
    ).rejects.toThrow("delivery_database_unavailable");
    expect(claimReads).toEqual([]);
    expect(f.sends).not.toHaveBeenCalled();
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
  expect(f.service.inspect({ ...f.scope, attempt_id: a.attempt_id }).attempt).toMatchObject({
    state: "prepared",
    authorization_status: "active",
  });
});
it("effect-free provider readiness failure leaves a prepared active grant reusable without POST", async () => {
  const f = fixture();
  const prepared = f.prepare().attempt;
  const authorized = f.authorize(prepared).attempt;
  f.transport.preflight = async () => { throw Error("temporary read-only outage"); };
  await expect(f.service.dispatch({...f.scope, attempt_id:prepared.attempt_id, expected_revision:authorized.revision})).rejects.toThrow("delivery_destination_unavailable");
  expect(f.sends).not.toHaveBeenCalled();
  const current=f.service.inspect({...f.scope,attempt_id:prepared.attempt_id}).attempt;
  expect(current.state).toBe("prepared");expect(current.authorization_status).toBe("active");expect(current.revision).toBe(authorized.revision);
  f.transport.preflight = async () => {};
  const sent=await f.service.dispatch({...f.scope, attempt_id:prepared.attempt_id, expected_revision:authorized.revision});
  expect(sent.attempt.state).toBe("delivered");expect(f.sends).toHaveBeenCalledTimes(1);
});
it("revocation while read-only preflight runs prevents later consumption and POST", async () => {
  const f=fixture(),prepared=f.prepare().attempt,authorized=f.authorize(prepared).attempt;
  let release!:()=>void; f.transport.preflight=()=>new Promise<void>(resolve=>{release=resolve;});
  const dispatch=f.service.dispatch({...f.scope,attempt_id:prepared.attempt_id,expected_revision:authorized.revision});
  await Promise.resolve();
  f.service.revoke({...f.scope,attempt_id:prepared.attempt_id,expected_revision:authorized.revision,reason:"cancel during readiness"});release();
  await expect(dispatch).rejects.toThrow("delivery_revision_conflict");expect(f.sends).not.toHaveBeenCalled();
  expect(f.service.inspect({...f.scope,attempt_id:prepared.attempt_id}).attempt.authorization_status).toBe("revoked");
});
it("read-only preflight timeout leaves authority active rather than recording send_started", async () => {
  const f=fixture(),prepared=f.prepare().attempt,authorized=f.authorize(prepared).attempt;
  f.transport.preflight=()=>new Promise<void>(()=>{});
  await expect(f.service.dispatch({...f.scope,attempt_id:prepared.attempt_id,expected_revision:authorized.revision})).rejects.toThrow("delivery_destination_unavailable");
  const current=f.service.inspect({...f.scope,attempt_id:prepared.attempt_id}).attempt;
  expect(current.state).toBe("prepared");expect(current.authorization_status).toBe("active");expect(f.sends).not.toHaveBeenCalled();
});
it("lookup window is anchored to durable send_started, not an old prepared draft",async()=>{
  const f=fixture(),prepared=f.prepare().attempt;f.now(1_000_000);
  const authorized=f.authorize(prepared).attempt;f.transport.sendOnce=async()=>{throw Error("lost response");};
  const failed=await f.service.dispatch({...f.scope,attempt_id:prepared.attempt_id,expected_revision:authorized.revision});
  const lookup=vi.fn(async()=>null);f.transport.lookup=lookup;
  f.now(1_001_000);await f.service.reconcile({...f.scope,attempt_id:prepared.attempt_id,expected_revision:failed.attempt.revision});
  expect(lookup).toHaveBeenCalledWith(expect.anything(),expect.any(AbortSignal),{createdAtMs:1_000_000});
});
