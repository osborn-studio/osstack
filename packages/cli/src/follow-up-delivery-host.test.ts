import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createScratchDirSync,
  openDb,
  FollowUpDeliveryService,
  FollowUpObligationService,
  deliveryCanonical,
} from "@osstack/core";
import {
  loadHostFollowUpDelivery,
  readHostDeliveryConfig,
  readPrivateDeliveryFile,
} from "./follow-up-delivery-host.js";
import { handleFollowUpDeliveryIssuerCommand } from "./follow-up-delivery-issuer.js";
import { handleFollowUpDeliveryCommand } from "./follow-up-delivery-command.js";
const clean: (() => void)[] = [];
afterEach(() => {
  for (const f of clean.splice(0).reverse()) f();
});
function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "delivery-host"));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    repo = join(root, "repo");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(repo);
  const pair = generateKeyPairSync("ed25519");
  const target = {
    destination_ref: "issue",
    repo_path: repo,
    provider_id: "github_comment" as const,
    account_id: "account",
    host: "github.com" as const,
    owner: "owner",
    repository: "repo",
    issue_number: 1,
    target_node_id: "ISSUE",
    actor_node_id: "ACTOR",
  };
  const config = {
    schema_version: 1,
    enabled: true,
    qualification: "sandbox_qualified",
    qualification_note: "Fixture configuration, no live qualification",
    targets: [target],
    accounts: [{ account_id: "account", token_file: "github-token" }],
    keys: [
      {
        key_id: "operator",
        public_key_pem: pair.publicKey.export({ type: "spki", format: "pem" }),
        repo_path: repo,
        destination_refs: ["issue"],
        max_validity_ms: 60000,
      },
    ],
  };
  const configPath = join(home, "follow-up-delivery.json");
  const save = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  save();
  writeFileSync(join(home, "github-token"), "fixture-token", { mode: 0o600 });
  writeFileSync(join(home, "issuer-operator.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  return { root, home, repo, pair, target, config, configPath, save };
}
async function prepared() {
  const f = fixture();
  const path = join(f.home, "state.db"),
    db = openDb({ path });
  clean.push(() => db.close());
  db.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','test','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)",
  );
  db.prepare(
    "INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','codex-cli',?,?,'idle',1,1,1)",
  ).run("a".repeat(64), f.repo);
  const scope = { repo_path: f.repo, default_tenant: true };
  const obligation = new FollowUpObligationService(db, path).create({
    ...scope,
    source_session_id: "s",
    expected_source_version: 1,
    idempotency_key: "ob",
    actor: "operator",
    promise: "Reply",
    destination_ref: "local_operator",
    resolution_condition: "manual",
  }).obligation;
  const host = await loadHostFollowUpDelivery(f.configPath);
  expect(host.state).toBe("ready");
  const service = new FollowUpDeliveryService(db, path, host.options);
  const attempt = service.prepare({
    ...scope,
    obligation_id: obligation.obligation_id,
    expected_obligation_revision: 1,
    destination_ref: "issue",
    body: "Exact operator approved message",
    idempotency_key: "attempt",
  }).attempt;
  const output = join(f.home, "grant.json");
  const args = [
    "issue-grant",
    attempt.attempt_id,
    "--repo",
    f.repo,
    "--default-tenant",
    "--revision",
    "1",
    "--key",
    "operator",
    "--output",
    output,
  ];
  const rpc = (method: string, params: unknown) => service.handle(method, params);
  return { ...f, db, scope, service, attempt, args, output, rpc, host };
}
it("missing, disabled and invalid private config fail closed without authority", async () => {
  const f = fixture();
  expect((await loadHostFollowUpDelivery(join(f.home, "missing.json"))).state).toBe("disabled");
  f.config.enabled = false;
  f.save();
  expect((await loadHostFollowUpDelivery(f.configPath)).options).toEqual({});
  chmodSync(f.configPath, 0o644);
  expect((await loadHostFollowUpDelivery(f.configPath)).state).toBe("invalid");
});
it.each([
  "directory",
  "file",
  "symlink",
  "private-key",
  "unknown-account",
  "duplicate-target",
  "repo-config",
])("rejects invalid host registration: %s", async (mode) => {
  const f = fixture();
  let path = f.configPath;
  if (mode === "directory") chmodSync(f.home, 0o755);
  if (mode === "file") chmodSync(f.configPath, 0o644);
  if (mode === "symlink") {
    path = join(f.home, "link.json");
    symlinkSync(f.configPath, path);
  }
  if (mode === "private-key") {
    f.config.keys[0]!.public_key_pem = f.pair.privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    f.save();
  }
  if (mode === "unknown-account") {
    f.config.targets[0]!.account_id = "other";
    f.save();
  }
  if (mode === "duplicate-target") {
    f.config.targets.push(f.target);
    f.save();
  }
  if (mode === "repo-config") {
    chmodSync(f.repo, 0o700);
    path = join(f.repo, "config.json");
    writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 });
  }
  expect((await loadHostFollowUpDelivery(path)).state).toBe("invalid");
});
it("bounds credential reads and refuses a token symlink", async () => {
  const f = fixture();
  writeFileSync(join(f.home, "large"), "x".repeat(5000), { mode: 0o600 });
  await expect(readPrivateDeliveryFile(join(f.home, "large"), 4096)).rejects.toThrow();
  symlinkSync(join(f.home, "github-token"), join(f.home, "link"));
  await expect(readPrivateDeliveryFile(join(f.home, "link"))).rejects.toThrow();
});
it("operator previews exact wire body, creates one signed grant and actual authorize handler accepts it", async () => {
  const f = await prepared();
  const confirm = vi.fn(async (preview: string, phrase: string) => {
    expect(preview).toContain("Exact operator approved message");
    expect(preview).toContain(`osstack-delivery:${f.attempt.attempt_id}`);
    expect(phrase).toBe(`APPROVE ${createHash("sha256").update(preview.trimEnd()).digest("hex")}`);
    return true;
  });
  const stdout = vi.fn(),
    stderr = vi.fn();
  expect(
    await handleFollowUpDeliveryIssuerCommand(f.args, {
      home: f.home,
      rpc: f.rpc,
      confirm,
      stdout,
      stderr,
    }),
  ).toBe(0);
  expect(confirm).toHaveBeenCalledTimes(1);
  const grant = JSON.parse(readFileSync(f.output, "utf8"));
  expect(
    verify(
      null,
      Buffer.from(deliveryCanonical(grant.body)),
      f.pair.publicKey,
      Buffer.from(grant.signature, "base64"),
    ),
  ).toBe(true);
  expect(
    f.service.inspect({ ...f.scope, attempt_id: f.attempt.attempt_id }).attempt.authorization_status,
  ).toBe("missing");
  expect(
    await handleFollowUpDeliveryCommand(
      [
        "authorize",
        f.attempt.attempt_id,
        "--repo",
        f.repo,
        "--default-tenant",
        "--revision",
        "1",
        "--grant",
        f.output,
      ],
      { rpc: f.rpc, stdout, stderr },
    ),
  ).toBe(0);
  expect(
    f.service.inspect({ ...f.scope, attempt_id: f.attempt.attempt_id }).attempt.authorization_status,
  ).toBe("active");
});
it.each([
  "decline",
  "noninteractive",
  "changed-config",
  "changed-attempt",
  "wrong-private-key",
  "existing-output",
  "forged-subject",
  "forged-body",
])("issuer refuses %s without overwriting grants", async (mode) => {
  const f = await prepared();
  let rpc = f.rpc;
  if (mode === "existing-output") writeFileSync(f.output, "sentinel", { mode: 0o600 });
  if (mode === "wrong-private-key")
    writeFileSync(
      join(f.home, "issuer-operator.pem"),
      generateKeyPairSync("ed25519").privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      { mode: 0o600 },
    );
  if (mode === "forged-subject" || mode === "forged-body")
    rpc = async (method, params) => {
      const raw = JSON.parse(JSON.stringify(await f.rpc(method, params)));
      if (mode === "forged-subject") raw.attempt.authorization_subject.body_sha256 = "a".repeat(64);
      else raw.attempt.envelope.body = "hidden mutation";
      return raw;
    };
  const confirm = async () => {
    if (mode === "changed-config") {
      f.config.enabled = false;
      f.save();
    }
    if (mode === "changed-attempt")
      f.service.revoke({
        ...f.scope,
        attempt_id: f.attempt.attempt_id,
        expected_revision: 1,
        reason: "operator cancelled",
      });
    return mode !== "decline";
  };
  expect(
    await handleFollowUpDeliveryIssuerCommand(f.args, {
      home: f.home,
      rpc,
      ...(mode === "noninteractive" ? {} : { confirm }),
      stdout: vi.fn(),
      stderr: vi.fn(),
    }),
  ).toBe(1);
  if (mode === "existing-output") expect(readFileSync(f.output, "utf8")).toBe("sentinel");
  else expect(() => readFileSync(f.output)).toThrow();
});
it("live host config revocation prevents transport preflight before any network request", async () => {
  const f = await prepared();
  f.config.enabled = false;
  f.save();
  await expect(
    f.host.options.transports!.get("github_comment")!.preflight!(f.attempt.envelope, AbortSignal.timeout(1000)),
  ).rejects.toThrow("config_changed");
});
it("rejects unknown flags rather than offering unattended signing", async () => {
  const f = await prepared();
  const confirm = vi.fn(async () => true);
  expect(
    await handleFollowUpDeliveryIssuerCommand([...f.args, "--yes"], {
      home: f.home,
      rpc: f.rpc,
      confirm,
      stdout: vi.fn(),
      stderr: vi.fn(),
    }),
  ).toBe(1);
  expect(confirm).not.toHaveBeenCalled();
});
it("config reader pins canonical key scope", async () => {
  const f = fixture();
  const c = await readHostDeliveryConfig(f.configPath);
  expect(c.keys.get("operator")!.asymmetricKeyType).toBe("ed25519");
});
it.each(["authorize", "consume"])("revocation before %s leaves the grant unconsumed", async (phase) => {
  const f = await prepared();
  expect(
    await handleFollowUpDeliveryIssuerCommand(f.args, {
      home: f.home,
      rpc: f.rpc,
      confirm: async () => true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    }),
  ).toBe(0);
  const grant = JSON.parse(readFileSync(f.output, "utf8"));
  const input = { ...f.scope, attempt_id: f.attempt.attempt_id, expected_revision: 1, grant };
  let revision = 1;
  if (phase === "consume") revision = f.service.authorize(input).attempt.revision;
  f.config.enabled = false;
  f.save();
  if (phase === "authorize") expect(() => f.service.authorize(input)).toThrow();
  else
    await expect(
      f.service.dispatch({ ...f.scope, attempt_id: f.attempt.attempt_id, expected_revision: revision }),
    ).rejects.toThrow();
  const current = f.service.inspect({ ...f.scope, attempt_id: f.attempt.attempt_id }).attempt;
  expect(current.state).toBe("prepared");
  expect(current.revision).toBe(revision);
  expect(current.authorization_status).toBe(phase === "authorize" ? "missing" : "active");
});
it("rejects a writable non-sticky ancestor even when home and file modes are private", async () => {
  const f = fixture();
  chmodSync(f.root, 0o777);
  expect((await loadHostFollowUpDelivery(f.configPath)).state).toBe("invalid");
  chmodSync(f.root, 0o700);
});
