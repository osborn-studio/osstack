import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { createServer, type Socket } from "node:net";
import { build } from "esbuild";
import { createScratchDir, deliveryCanonical } from "@osstack/core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { RemoteChannel, remoteHash } from "./remote-home-protocol.js";
import { handleRemoteCancelCommand, buildRemoteControlSshArgs } from "./remote-cancel-client.js";
import { handleRemoteCancelIssuerCommand } from "./remote-cancel-issuer.js";
import { handleRemoteControlExportCommand } from "./remote-cancel-exporter.js";
import { graphRpcFixture } from "./graph-test-fixture.js";
import {
  SignedRemoteCancelGrant,
  remoteCancelDigest,
  writeRemoteJournal,
  readRemoteJournal,
} from "./remote-cancel-protocol.js";
const homeId = `home_${"a".repeat(32)}`,
  generation = `instance_${"b".repeat(32)}`;
const scope = {
  schemaVersion: 1 as const,
  tenantId: "local",
  principalId: "owner",
  workspaceId: "workspace",
};
const identity = {
  schema_version: 1,
  home_id: homeId,
  generation,
  version: "0.21.0",
  protocol_version: 1,
  database_schema: 45,
  started_at_ms: 1,
  deployment_kind: "unknown",
  build_digest: null,
  build_evidence: "unavailable",
};
const status = {
  schemaVersion: 1,
  scope,
  graphRunId: "run-one",
  source: { product: "osstack", requestId: "request" },
  status: "running",
  revision: 4,
  generation: 2,
  inputDigest: "a".repeat(64),
  specHash: "b".repeat(64),
  createdAt: 1,
  updatedAt: 1,
  publication: "artifact_only",
  phase: "running",
  budget: {
    limits: {
      maxEpochs: 3,
      maxBranchAttempts: 2,
      maxConcurrentReaders: 2,
      maxConcurrentWritersPerRepo: 1,
      maxActionStarts: 64,
      deadlineSeconds: 3600,
      tokenReservationLimit: 100000,
    },
    actionStarts: 1,
    reservedTokens: "1",
    chargedTokens: "0",
    accountingBlocked: false,
  },
  delivery: "pending",
  evidenceRefs: [],
};
const hostKey = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString("base64");
const cleanup: Array<() => Promise<unknown>> = [];
let bundleRoot: string, compiled: string;
beforeAll(async () => {
  bundleRoot = await realpath(await createScratchDir("tests", "remote-cancel-bundle"));
  compiled = join(bundleRoot, "exporter.mjs");
  await symlink(resolve("node_modules"), join(bundleRoot, "node_modules"));
  await build({
    stdin: {
      contents: `import {handleRemoteControlExportCommand} from './remote-cancel-exporter.js';import {Writable} from 'node:stream';let count=0;const output=process.env.DROP_ACK==='1'?new Writable({write(chunk,_enc,callback){if(++count===2){process.kill(process.pid,'SIGKILL');return;}process.stdout.write(chunk,callback);}}):process.stdout;process.exitCode=await handleRemoteControlExportCommand(['--stdio'],{output});`,
      resolveDir: resolve("src"),
      sourcefile: "cancel-runner.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
    outfile: compiled,
    logLevel: "silent",
  });
});
afterAll(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(graph?: { scope: typeof scope; repo: string }) {
  const root = await realpath(await createScratchDir("tests", "remote-cancel"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const repo = graph?.repo ?? join(root, "repo"),
    boundScope = graph?.scope ?? scope,
    journal = join(root, "remote-journal");
  if (!graph) await mkdir(repo, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"),
    pub = publicKey.export({ format: "pem", type: "spki" }).toString();
  const methods: string[] = [],
    sockets = new Set<Socket>();
  let mutate: (v: unknown, m: string, params: unknown) => unknown | Promise<unknown> = (v) => v;
  const children: ChildProcessWithoutNullStreams[] = [];
  const socketDirectory = join(root, "sockets");
  await mkdir(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "d.sock"),
    server = createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      const c = new RemoteChannel(s, s, 65536 + 1024, 8);
      void (async () => {
        try {
          for (let i = 0; i < 3; i++) {
            const request = (await c.receive()) as { id: number; method: string; params: unknown };
            methods.push(request.method);
            const result =
              request.method === "deployment.identity"
                ? identity
                : request.method === "graph.status"
                  ? status
                  : { ...status, status: "cancel_pending", delivery: "delivery_unknown", revision: 5 };
            await c.send({
              id: request.id,
              ok: true,
              result: await mutate(result, request.method, request.params),
            });
          }
        } catch {
        } finally {
          c.close();
          s.end();
        }
      })();
    });
  await new Promise<void>((r) => server.listen(socket, r));
  await chmod(socket, 0o600);
  cleanup.push(async () => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const config = {
    version: 1,
    home_id: homeId,
    daemon_protocol: 1,
    socket,
    journal_dir: journal,
    scopes: [{ alias: "project", repo_path: repo, graph_scope: boundScope }],
    keys: [
      {
        key_id: "cancel-key",
        public_key_pem: pub,
        actor_id: "operator",
        scope_aliases: ["project"],
        max_validity_ms: 300000,
      },
    ],
  };
  const registry = join(root, "server.json"),
    raw = JSON.stringify(config);
  await writeFile(registry, raw, { mode: 0o600 });
  const pin = remoteHash(raw),
    env = { OSSTACK_REMOTE_CONTROL_REGISTRY: registry, OSSTACK_REMOTE_CONTROL_SHA256: pin };
  const identityFile = join(root, "identity");
  await writeFile(identityFile, "FIXTURE_NOT_REAL_SSH_KEY", { mode: 0o600 });
  const entry = {
    alias: "dev",
    host: "example.test",
    port: 22,
    user: "operator",
    host_key: `ssh-ed25519 ${hostKey}`,
    identity_file: identityFile,
    home_id: homeId,
    daemon_protocol: 1,
    registry_sha256: pin,
    scope: "project",
  };
  const clientFile = join(root, "client.json"),
    clientRaw = JSON.stringify({ version: 1, homes: [entry] });
  await writeFile(clientFile, clientRaw, { mode: 0o600 });
  const grantPath = join(root, "grant.json");
  const grantFor = (patch: Record<string, unknown> = {}) => {
    const now = Date.now(),
      body = {
        domain: "osstack.remote-graph-cancel.v1",
        grant_id: randomUUID(),
        request_id: randomUUID(),
        actor_id: "operator",
        home_id: homeId,
        daemon_generation: generation,
        server_registry_sha256: pin,
        scope_alias: "project",
        repo_path: repo,
        graph_scope: boundScope,
        action: "graph.cancel",
        graph_run_id: "run-one",
        graph_generation: 2,
        expected_revision: 4,
        nonce: "c".repeat(64),
        issued_at_ms: now - 1000,
        expires_at_ms: now + 60000,
        max_calls: 1,
        ...patch,
      };
    return SignedRemoteCancelGrant.parse({
      body,
      key_id: "cancel-key",
      signature: sign(null, Buffer.from(deliveryCanonical(body)), privateKey).toString("base64"),
    });
  };
  let grant = grantFor();
  await writeFile(grantPath, JSON.stringify(grant), { mode: 0o600 });
  const spawnLocal = ((_bin: string, _args: readonly string[], _opts: unknown) => {
    const child = spawn(process.execPath, [compiled], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, OSSTACK_HOME: join(root, "never-open") },
    });
    children.push(child);
    return child;
  }) as typeof spawn;
  const args = (action = "cancel") => [
    action,
    "--registry",
    clientFile,
    "--sha256",
    remoteHash(clientRaw),
    "--alias",
    "dev",
    "--grant",
    grantPath,
  ];
  const invoke = async (action = "cancel", start = spawnLocal) => {
    let output = "",
      error = "";
    const code = await handleRemoteCancelCommand(args(action), {
      home: root,
      spawn: start,
      timeoutMs: 3000,
      stdout: (s) => {
        output += s;
      },
      stderr: (s) => {
        error += s;
      },
    });
    return { code, value: output ? JSON.parse(output) : null, error };
  };
  return {
    root,
    repo,
    journal,
    registry,
    config,
    pin,
    env,
    entry,
    grantPath,
    grantFor,
    get grant() {
      return grant;
    },
    setGrant: async (g: SignedRemoteCancelGrant) => {
      grant = g;
      await writeFile(grantPath, JSON.stringify(g), { mode: 0o600 });
    },
    methods,
    socketDirectory,
    children,
    spawnLocal,
    invoke,
    args,
    privateKey,
    pub,
    mutate: (f: typeof mutate) => {
      mutate = f;
    },
  };
}
it("actual issuer -> client -> child exporter -> existing daemon boundary returns durable receipt without claiming physical stop", async () => {
  const f = await fixture();
  const issuer = {
    version: 1,
    enabled: true,
    actor_id: "operator",
    key_id: "cancel-key",
    public_key_pem: f.pub,
    max_validity_ms: 300000,
    targets: [
      {
        name: "dev",
        home_id: homeId,
        server_registry_sha256: f.pin,
        scope_alias: "project",
        repo_path: f.repo,
        graph_scope: scope,
      },
    ],
  };
  await writeFile(join(f.root, "remote-cancel-issuer.json"), JSON.stringify(issuer), { mode: 0o600 });
  await writeFile(
    join(f.root, "issuer-cancel-key.pem"),
    f.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  const output = join(f.root, "issued.json");
  let preview = "";
  expect(
    await handleRemoteCancelIssuerCommand(
      [
        "issue-cancel-grant",
        "--target",
        "dev",
        "--daemon-generation",
        generation,
        "--graph-run",
        "run-one",
        "--graph-generation",
        "2",
        "--revision",
        "4",
        "--output",
        output,
      ],
      {
        home: f.root,
        stdout: () => {},
        confirm: async (p, phrase) => {
          preview = p;
          expect(phrase).toMatch(/^APPROVE [a-f0-9]{64}$/);
          return true;
        },
      },
    ),
  ).toBe(0);
  expect(preview).toContain("not_attested");
  await f.setGrant(JSON.parse(await readFile(output, "utf8")));
  expect(await f.invoke()).toMatchObject({
    code: 0,
    value: { outcome: "stop_requested", physical_stop: "not_attested", receipt: { observed_revision: 5 } },
  });
  expect(f.methods).toEqual(["deployment.identity", "graph.status", "graph.cancel"]);
  expect(await f.invoke()).toMatchObject({ code: 0, value: { outcome: "stop_requested" } });
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
  await expect(readFile(join(f.root, "never-open", "state.db"))).rejects.toThrow();
});
it("local identity preflight failure does not reserve or burn the cancellation grant", async () => {
  const f = await fixture();
  await chmod(f.entry.identity_file, 0o644);
  const start = vi.fn(() => { throw Error("unexpected spawn before local preflight"); });
  expect(await f.invoke("cancel", start as typeof spawn)).toMatchObject({ code: 1, value: { outcome: "not_sent" } });
  expect(start).not.toHaveBeenCalled();
  expect(f.methods).toEqual([]);
  await chmod(f.entry.identity_file, 0o600);
  expect(await f.invoke()).toMatchObject({ code: 0, value: { outcome: "stop_requested" } });
  expect(f.methods.filter(method => method === "graph.cancel")).toHaveLength(1);
});
it("lost remote ACK after fsync is recovered by query without replay", async () => {
  const f = await fixture();
  f.env["DROP_ACK" as keyof typeof f.env] = "1";
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  delete (f.env as Record<string, string>)["DROP_ACK"];
  expect(await f.invoke()).toMatchObject({ code: 0, value: { outcome: "stop_requested" } });
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
});
it("process killed after reserve and cancellation invocation stays unknown and never replays", async () => {
  const f = await fixture();
  f.mutate((v, m) => {
    if (m === "graph.cancel") f.children.at(-1)!.kill("SIGKILL");
    return v;
  });
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
});
it.each(["daemon", "graph", "revision", "scope"])("stale %s binding denies cancel", async (kind) => {
  const f = await fixture();
  f.mutate((raw, m) => {
    const v = structuredClone(raw) as Record<string, unknown>;
    if (kind === "daemon" && m === "deployment.identity") v.generation = `instance_${"d".repeat(32)}`;
    if (m === "graph.status") {
      if (kind === "graph") v.generation = 3;
      if (kind === "revision") v.revision = 5;
      if (kind === "scope") v.scope = { ...scope, principalId: "other" };
    }
    return v;
  });
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  expect(f.methods).not.toContain("graph.cancel");
});
it("expired write authorization is rejected before daemon access; historical signed query stays available", async () => {
  const f = await fixture();
  await f.setGrant(f.grantFor({ issued_at_ms: Date.now() - 20000, expires_at_ms: Date.now() - 10000 }));
  expect(await f.invoke()).toMatchObject({ code: 1 });
  expect(f.methods).toEqual([]);
  expect(await f.invoke("query")).toMatchObject({ value: { outcome: "not_found" } });
  expect(f.methods).toEqual([]);
});
it("tampered or wrong-scope signed payload never reaches daemon", async () => {
  const f = await fixture();
  await f.setGrant({ ...f.grant, body: { ...f.grant.body, expected_revision: 99 } });
  expect(await f.invoke()).toMatchObject({ code: 1 });
  expect(f.methods).toEqual([]);
});
it("registry revocation during readiness prevents any cancel call", async () => {
  const f = await fixture();
  f.mutate(async (v, m) => {
    if (m === "graph.status")
      await writeFile(f.registry, JSON.stringify({ ...f.config, keys: [] }), { mode: 0o600 });
    return v;
  });
  expect(await f.invoke()).toMatchObject({ code: 1 });
  expect(f.methods).not.toContain("graph.cancel");
});
it("reserved but uninvoked crash journal never arms on a repeated cancel", async () => {
  const f = await fixture();
  await writeRemoteJournal(join(f.journal, `${f.grant.body.request_id}.started.json`), {
    request_sha256: remoteCancelDigest(f.grant),
    grant: f.grant,
  });
  expect(await f.invoke()).toMatchObject({ value: { outcome: "delivery_unknown" } });
  expect(f.methods).toEqual([]);
});
it("corrupted persisted receipt fails closed without RPC or effect replay", async () => {
  const f = await fixture();
  expect((await f.invoke()).code).toBe(0);
  await writeFile(join(f.journal, `${f.grant.body.request_id}.result.json`), '{"outcome":"stop_requested"}', {
    mode: 0o600,
  });
  expect(await f.invoke()).toMatchObject({ value: { outcome: "delivery_unknown" } });
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
});
it("request ID collision with changed exact signed grant cannot reuse an earlier receipt", async () => {
  const f = await fixture();
  expect((await f.invoke()).code).toBe(0);
  await f.setGrant(f.grantFor({ request_id: f.grant.body.request_id, expected_revision: 5 }));
  expect(await f.invoke()).toMatchObject({ code: 1, error: "invalid_remote_cancel_request\n" });
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
});
it("querying absent request has no mutation or local intent reservation", async () => {
  const f = await fixture();
  expect(await f.invoke("query")).toMatchObject({ value: { outcome: "not_found" } });
  expect(f.methods).toEqual([]);
  expect(
    await readRemoteJournal(join(f.root, "remote-actions", `${f.grant.body.request_id}.local.json`)),
  ).toBeNull();
});
it("private journal ancestors and create-only records prevent unsafe replacement", async () => {
  const f = await fixture();
  await chmod(f.root, 0o777);
  await expect(writeRemoteJournal(join(f.journal, "x.json"), {})).rejects.toThrow();
  await chmod(f.root, 0o700);
  expect(await writeRemoteJournal(join(f.journal, "x.json"), { x: 1 })).toBe(true);
  expect(await writeRemoteJournal(join(f.journal, "x.json"), { x: 2 })).toBe(false);
  expect(await readRemoteJournal(join(f.journal, "x.json"))).toEqual({ x: 1 });
});
it("read-only token shape, substituted token and unregistered grant are refused", async () => {
  const f = await fixture();
  for (const kind of ["read", "token", "grant"]) {
    const input = new PassThrough(),
      output = new PassThrough(),
      server = handleRemoteControlExportCommand(["--stdio"], { input, output, env: f.env }),
      c = new RemoteChannel(output, input);
    await c.send({
      type: "control_hello",
      protocol: 1,
      nonce: "e".repeat(64),
      home_id: homeId,
      registry_sha256: f.pin,
    });
    const hello = (await c.receive()) as { token: string };
    await c.send(
      kind === "read"
        ? { type: "snapshot", token: hello.token, sequence: 1, limit: 1 }
        : {
            type: "cancel",
            token: kind === "token" ? "f".repeat(64) : hello.token,
            grant: kind === "grant" ? { ...f.grant, key_id: "unregistered" } : f.grant,
          },
    );
    expect(await server).toBe(1);
    c.close();
    input.destroy();
    output.destroy();
  }
  expect(f.methods).toEqual([]);
});
it("SSH remains pinned, explicit, bounded and uses only the dedicated control command", async () => {
  const f = await fixture();
  const argv = buildRemoteControlSshArgs(f.entry, "/private/known_hosts");
  expect(argv.at(-1)).toBe("osstack remote-control --stdio");
  expect(argv.join(" ")).toContain("StrictHostKeyChecking=yes");
  expect(argv.join(" ")).toContain("IdentitiesOnly=yes");
  expect(argv.join(" ")).toContain("ForwardAgent=no");
});
it("timeout records unknown once and subsequent cancel changes to query", async () => {
  const f = await fixture();
  const start = ((_b: string, _a: readonly string[], _o: unknown) =>
    spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    })) as typeof spawn;
  let output = "";
  expect(
    await handleRemoteCancelCommand(f.args(), {
      home: f.root,
      spawn: start,
      timeoutMs: 20,
      stdout: (s) => {
        output += s;
      },
    }),
  ).toBe(1);
  expect(JSON.parse(output).outcome).toBe("delivery_unknown");
  expect(await f.invoke()).toMatchObject({ value: { outcome: "not_found" } });
  expect(f.methods).toEqual([]);
});
it("missing issuer configuration, noninteractive confirmation, or duplicate output cannot self-authorize", async () => {
  const f = await fixture();
  const confirm = vi.fn();
  expect(
    await handleRemoteCancelIssuerCommand(["issue-cancel-grant", "--yes"], {
      home: f.root,
      confirm,
      stderr: () => {},
    }),
  ).toBe(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(await handleRemoteControlExportCommand(["--stdio"], { env: {} })).toBe(1);
});

it("signed remote cancellation drives the actual GraphRpcService worker abort and retains local stop proof separation", async () => {
  const g = await graphRpcFixture("cancel");
  try {
    const run = await g.start();
    await g.until(run.graphRunId, () => g.writes() === 1);
    const before = await g.status(run.graphRunId);
    const f = await fixture({ scope: g.request.scope, repo: join(g.root, "source") });
    f.mutate((v, m, params) => (m.startsWith("graph.") ? g.service.handle(g.connection, m, params) : v));
    await f.setGrant(
      f.grantFor({
        graph_run_id: run.graphRunId,
        graph_generation: before.generation,
        expected_revision: before.revision,
      }),
    );
    expect(await f.invoke()).toMatchObject({
      code: 0,
      value: { outcome: "stop_requested", physical_stop: "not_attested" },
    });
    await g.until(run.graphRunId, (s) => s.status === "cancelled");
    expect(g.abortObserved()).toBe(true);
    expect(g.db.prepare("SELECT count(*) n FROM graph_requests WHERE kind='cancel'").get()).toEqual({ n: 1 });
    expect(await f.invoke()).toMatchObject({ code: 0 });
    expect(g.db.prepare("SELECT count(*) n FROM graph_requests WHERE kind='cancel'").get()).toEqual({ n: 1 });
  } finally {
    await g.close();
    await rm(g.root, { recursive: true, force: true });
  }
}, 30000);

it("simultaneous clients sharing request UUID invoke at most one Graph cancel", async () => {
  const f = await fixture();
  const results = await Promise.all([f.invoke(), f.invoke()]);
  expect(results.some((r) => r.code === 0)).toBe(true);
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
  expect(await f.invoke("query")).toMatchObject({ code: 0, value: { outcome: "stop_requested" } });
});
it.each([
  "oversize",
  "invalid",
  "stderr",
])("untrusted actual peer %s output is bounded and cannot report a confirmed receipt", async (mode) => {
  const f = await fixture();
  const code =
    mode === "oversize"
      ? "process.stdout.write(Buffer.alloc(70000));"
      : mode === "invalid"
        ? "process.stdout.write(Buffer.from([0,0,0,1,123]));"
        : "process.stderr.write('PRIVATE_SHOULD_NOT_SURFACE'.repeat(1000));";
  const start = ((_b: string, _a: readonly string[], _o: unknown) =>
    spawn(process.execPath, ["-e", code + "process.stdin.resume();setInterval(()=>{},1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    })) as typeof spawn;
  let output = "";
  expect(
    await handleRemoteCancelCommand(f.args(), {
      home: f.root,
      spawn: start,
      timeoutMs: 200,
      stdout: (s) => {
        output += s;
      },
    }),
  ).toBe(1);
  expect(JSON.parse(output).outcome).toBe("delivery_unknown");
  expect(output).not.toContain("PRIVATE_SHOULD");
  expect(f.methods).toEqual([]);
});
it("issuer rechecks trusted configuration after human approval and refuses an altered target", async () => {
  const f = await fixture(),
    configPath = join(f.root, "remote-cancel-issuer.json"),
    output = join(f.root, "new-grant.json");
  const config = {
    version: 1,
    enabled: true,
    actor_id: "operator",
    key_id: "cancel-key",
    public_key_pem: f.pub,
    max_validity_ms: 300000,
    targets: [
      {
        name: "dev",
        home_id: homeId,
        server_registry_sha256: f.pin,
        scope_alias: "project",
        repo_path: f.repo,
        graph_scope: scope,
      },
    ],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(
    join(f.root, "issuer-cancel-key.pem"),
    f.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  const args = [
    "issue-cancel-grant",
    "--target",
    "dev",
    "--daemon-generation",
    generation,
    "--graph-run",
    "run-one",
    "--graph-generation",
    "2",
    "--revision",
    "4",
    "--output",
    output,
  ];
  expect(
    await handleRemoteCancelIssuerCommand(args, {
      home: f.root,
      stderr: () => {},
      confirm: async () => {
        await writeFile(configPath, JSON.stringify({ ...config, enabled: false }), { mode: 0o600 });
        return true;
      },
    }),
  ).toBe(1);
  await expect(readFile(output)).rejects.toThrow();
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  expect(await handleRemoteCancelIssuerCommand(args, { home: f.root, stderr: () => {} })).toBe(1);
  await expect(readFile(output)).rejects.toThrow();
});
it("valid-shape persisted receipt with wrong generation is refused", async () => {
  const f = await fixture();
  expect((await f.invoke()).code).toBe(0);
  const path = join(f.journal, `${f.grant.body.request_id}.result.json`),
    receipt = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...receipt, graph_generation: 999 }), { mode: 0o600 });
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
});

it("natural subcommand help is available without configuration, DB, or child processes", async () => {
  const start = vi.fn();
  for (const action of ["cancel", "query"]) {
    let out = "";
    expect(
      await handleRemoteCancelCommand([action, "--help"], {
        home: "/not-provisioned",
        spawn: start as typeof spawn,
        stdout: (s) => {
          out += s;
        },
      }),
    ).toBe(0);
    expect(out).toContain("--grant");
  }
  let issuer = "";
  expect(
    await handleRemoteCancelIssuerCommand(["issue-cancel-grant", "--help"], {
      home: "/not-provisioned",
      stdout: (s) => {
        issuer += s;
      },
    }),
  ).toBe(0);
  expect(issuer).toContain("interactive");
  const output = new PassThrough();
  let exported = "";
  output.on("data", (chunk) => {
    exported += chunk.toString();
  });
  expect(await handleRemoteControlExportCommand(["--help"], { output, env: {} })).toBe(0);
  expect(exported).toContain("remote-control --stdio");
  output.destroy();
  expect(start).not.toHaveBeenCalled();
});

it("an unrelated running status reply cannot be accepted as cancellation acknowledgement", async () => {
  const f = await fixture();
  f.mutate((v, m) => (m === "graph.cancel" ? { ...status, revision: 5 } : v));
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  expect(f.methods.filter((m) => m === "graph.cancel")).toHaveLength(1);
});

it("unsafe socket ancestors cannot substitute an authenticated private daemon endpoint", async () => {
  const f = await fixture();
  await chmod(f.socketDirectory, 0o777);
  expect(await f.invoke()).toMatchObject({ code: 1, value: { outcome: "delivery_unknown" } });
  expect(f.methods).toEqual([]);
  await chmod(f.socketDirectory, 0o700);
});
