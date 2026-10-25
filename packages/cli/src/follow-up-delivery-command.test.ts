import { expect, it, vi } from "vitest";
import { handleFollowUpDeliveryCommand } from "./follow-up-delivery-command.js";
const id = "11111111-1111-4111-8111-111111111111";
it.each(
  [[], ["help"], ["--help"]].map((args) => ({ args })),
)("documents explicit scope and qualification %j", async ({ args }) => {
  const out = vi.fn(),
    rpc = vi.fn();
  expect(await handleFollowUpDeliveryCommand(args, { rpc, stdout: out })).toBe(0);
  expect(out.mock.calls[0]![0]).toContain("qualification_pending");
  expect(rpc).not.toHaveBeenCalled();
});
it.each(
  [
    ["dispatch", id, "--repo", "/repo", "--revision", "1"],
    ["dispatch", id, "--repo", "/repo", "--default-tenant", "--revision", "1", "--approved"],
    ["authorize", id, "--repo", "/repo", "--default-tenant", "--revision", "1", "--actor", "human"],
    ["list", "--repo", "/repo", "--default-tenant", "--limit", "51"],
    ["list", "--repo", "/repo", "--default-tenant", "--repo", "/another"],
    ["inspect", id, "--repo", "/repo", "--default-tenant", "--receipt", "fake"],
  ].map((args) => ({ args })),
)("rejects invalid or invented authority arguments %j", async ({ args }) => {
  const rpc = vi.fn(),
    stderr = vi.fn();
  expect(await handleFollowUpDeliveryCommand(args, { rpc, stderr })).toBe(1);
  expect(rpc).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith("invalid_delivery_request\n");
});
it("sends strict scope to the RPC and suppresses internal errors", async () => {
  const rpc = vi.fn().mockRejectedValue(Error("SECRET_TOKEN")),
    stderr = vi.fn();
  expect(
    await handleFollowUpDeliveryCommand(["inspect", id, "--repo", "/repo", "--default-tenant"], {
      rpc,
      stderr,
    }),
  ).toBe(1);
  expect(rpc).toHaveBeenCalledWith("follow-up-delivery.inspect", {
    repo_path: "/repo",
    default_tenant: true,
    attempt_id: id,
  });
  expect(stderr).toHaveBeenCalledWith("delivery_request_failed\n");
});
it("rejects invalid and oversized RPC replies", async () => {
  for (const raw of [{ ok: true, delivered: true }, "x".repeat(65536)]) {
    const stderr = vi.fn();
    expect(
      await handleFollowUpDeliveryCommand(["list", "--repo", "/repo", "--default-tenant"], {
        rpc: async () => raw,
        stderr,
      }),
    ).toBe(1);
    expect(stderr).toHaveBeenCalledWith("invalid_delivery_response\n");
  }
});
it("lists bounded JSON with explicit keyset continuation", async () => {
  const stdout = vi.fn();
  const raw = {
    schema_version: 1,
    scope: { repo_path: "/repo", default_tenant: true },
    attempts: [],
    next_after_id: null,
  };
  expect(
    await handleFollowUpDeliveryCommand(["list", "--repo", "/repo", "--default-tenant", "--json"], {
      rpc: async () => raw,
      stdout,
    }),
  ).toBe(0);
  expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual(raw);
});

it("runs the real CLI→service ledger chain with a registered fake, never claiming production delivery", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto"),
    fs = await import("node:fs"),
    { join } = await import("node:path");
  const {
    createScratchDirSync,
    openDb,
    FollowUpObligationService,
    FollowUpDeliveryService,
    deliveryCanonical,
  } = await import("@osstack/core");
  const root = fs.realpathSync(createScratchDirSync("tests", "delivery-cli")),
    repo = join(root, "repo");
  fs.mkdirSync(repo);
  const path = join(root, "state.db"),
    db = openDb({ path });
  try {
    db.exec(
      "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','test','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)",
    );
    db.prepare(
      "INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','codex-cli',?,?,'idle',1,1,1)",
    ).run("a".repeat(64), repo);
    const scope = { repo_path: repo, default_tenant: true },
      obligation = new FollowUpObligationService(db, path, { nowMs: () => 10000 }).create({
        ...scope,
        source_session_id: "s",
        expected_source_version: 1,
        idempotency_key: "ob",
        actor: "test",
        promise: "Reply",
        destination_ref: "local_operator",
        resolution_condition: "manual",
      }).obligation;
    const target = {
      destination_ref: "thread",
      repo_path: repo,
      provider_id: "github_comment" as const,
      account_id: "bot",
      host: "github.com" as const,
      owner: "owner",
      repository: "repo",
      issue_number: 1,
      target_node_id: "node",
      actor_node_id: "actor-node",
    };
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"),
      sends = vi.fn();
    const service = new FollowUpDeliveryService(db, path, {
      targets: new Map([["thread", target]]),
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
              sends();
              return {
                provider_id: "github_comment",
                account_id: "bot",
                target_node_id: "node",
                author_node_id: "actor-node",
                destination_digest: e.destination_digest,
                body_sha256: e.body_sha256,
                attempt_id: e.attempt_id,
                provider_message_id: "msg",
                provider_request_id: "req",
              };
            },
            lookup: async () => null,
          },
        ],
      ]),
      allowTestTransports: true,
      nowMs: () => 10000,
    });
    const rpc = vi.fn((method: string, params: unknown) => service.handle(method, params)),
      stdout = vi.fn(),
      stderr = vi.fn(),
      flags = ["--repo", repo, "--default-tenant"];
    const file = join(root, "prepare.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        obligation_id: obligation.obligation_id,
        expected_obligation_revision: 1,
        destination_ref: "thread",
        body: "literal body \u009b31m",
        idempotency_key: "send",
      }),
    );
    expect(
      await handleFollowUpDeliveryCommand(["prepare", ...flags, "--input", file], { rpc, stdout, stderr }),
    ).toBe(0);
    let attempt = JSON.parse(stdout.mock.calls.at(-1)![0]).attempt;
    const body = {
      ...attempt.authorization_subject,
      grant_id: id,
      issued_at_ms: 10000,
      expires_at_ms: 20000,
      max_calls: 1,
    };
    const grant = join(root, "grant.json");
    fs.writeFileSync(
      grant,
      JSON.stringify({
        body,
        key_id: "key",
        signature: sign(null, Buffer.from(deliveryCanonical(body)), privateKey).toString("base64"),
      }),
    );
    expect(
      await handleFollowUpDeliveryCommand(
        ["authorize", attempt.attempt_id, ...flags, "--revision", "1", "--grant", grant],
        { rpc, stdout, stderr },
      ),
    ).toBe(0);
    attempt = JSON.parse(stdout.mock.calls.at(-1)![0]).attempt;
    expect(
      await handleFollowUpDeliveryCommand(
        ["dispatch", attempt.attempt_id, ...flags, "--revision", String(attempt.revision)],
        { rpc, stdout, stderr },
      ),
    ).toBe(1);
    attempt = JSON.parse(stdout.mock.calls.at(-1)![0]).attempt;
    expect(attempt).toMatchObject({
      state: "delivered",
      qualification: "test_only",
      promise_fulfillment: "independent_local_obligation",
    });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls.at(-1)![0]).toContain("\\u009b");
    expect(stderr).not.toHaveBeenCalled();
    expect(
      await handleFollowUpDeliveryCommand(
        ["dispatch", attempt.attempt_id, ...flags, "--revision", String(attempt.revision)],
        { rpc, stdout, stderr },
      ),
    ).toBe(1);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT state FROM follow_up_obligations").get()).toEqual({ state: "open" });
    fs.symlinkSync(file, join(root, "link"));
    const calls = rpc.mock.calls.length;
    expect(
      await handleFollowUpDeliveryCommand(["prepare", ...flags, "--input", join(root, "link")], {
        rpc,
        stdout,
        stderr,
      }),
    ).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(calls);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
