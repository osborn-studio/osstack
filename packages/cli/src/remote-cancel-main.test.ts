import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { createScratchDir, deliveryCanonical } from "@osstack/core";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { RemoteChannel, remoteHash } from "./remote-home-protocol.js";

const cleanup: Array<() => Promise<unknown>> = [];
let bundleRoot: string, runner: string;
beforeAll(async () => {
  bundleRoot = await realpath(await createScratchDir("tests", "remote-main-bundle"));
  runner = join(bundleRoot, "main.mjs");
  await symlink(resolve("node_modules"), join(bundleRoot, "node_modules"));
  await build({
    stdin: {
      contents: 'import {main} from "./bin.js"; process.exitCode = await main(process.argv.slice(2));',
      resolveDir: resolve("src"),
      sourcefile: "remote-main-runner.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
    outfile: runner,
    logLevel: "silent",
  });
}, 30000);
afterAll(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await realpath(await createScratchDir("tests", "remote-main"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OSSTACK_HOME: home,
    OSSTACK_SOCKET: join(root, "absent.sock"),
    OSSTACK_LANG: "en",
  };
  delete env["OSSTACK_REMOTE_CONTROL_REGISTRY"];
  delete env["OSSTACK_REMOTE_CONTROL_SHA256"];
  delete env["OSSTACK_REMOTE_EXPORT_REGISTRY"];
  delete env["OSSTACK_REMOTE_EXPORT_SHA256"];
  const children: ChildProcessWithoutNullStreams[] = [];
  const start = (args: string[]) => {
    const child = spawn(process.execPath, [runner, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    return child;
  };
  cleanup.push(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  });
  const run = async (args: string[]) => {
    const child = start(args);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
  return { root, home, env, start, run };
}
it("actual main advertises remote/source/native-upgrade/scout/log entrypoints in both languages", async () => {
  const f = await fixture();
  for (const language of ["en", "zh-CN"]) {
    f.env["OSSTACK_LANG"] = language;
    const result = await f.run(["--help"]);
    expect(result.code).toBe(0);
    for (const text of [
      "remote-home inspect|cancel|query|issue-cancel-grant",
      "remote-control --stdio",
      "sources inspect|observe|events|acknowledge",
      "scout inspect|promote",
      "worker logs --grant-file",
      "prepare-managed-installation|apply-upgrade|reconcile-upgrade",
      "paired_holdout",
    ])
      expect(result.stdout).toContain(text);
  }
  await expect(readFile(join(f.home, "state.db"))).rejects.toThrow();
});
it("remote-home aggregate help and every natural subcommand help routes without setup", async () => {
  const f = await fixture();
  for (const args of [
    ["remote-home"],
    ["remote-home", "--help"],
    ...["inspect", "cancel", "query", "issue-cancel-grant"].map((action) => [
      "remote-home",
      action,
      "--help",
    ]),
    ["remote-control", "--help"],
  ]) {
    const result = await f.run(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/remote-home|remote-control/);
    if (args.length <= 2 && args[0] === "remote-home") {
      expect(result.stdout).toContain("issue-cancel-grant");
      expect(result.stdout).toContain("cancel|query");
      expect(result.stdout).toContain("inspect");
    }
  }
  await expect(readFile(join(f.home, "state.db"))).rejects.toThrow();
}, 30000);
it("actual main dispatches invalid write commands to their fail-closed handlers", async () => {
  const f = await fixture();
  for (const action of ["cancel", "query"])
    expect(await f.run(["remote-home", action])).toEqual({
      code: 1,
      stdout: "",
      stderr: "invalid_remote_cancel_request\n",
    });
  expect(await f.run(["remote-home", "issue-cancel-grant", "--yes"])).toEqual({
    code: 1,
    stdout: "",
    stderr: "remote_cancel_issuer_refused\n",
  });
  expect(await f.run(["remote-control", "--stdio"])).toEqual({ code: 1, stdout: "", stderr: "" });
  expect(await f.run(["remote-control", "--stdio", "--socket", "/untrusted"])).toEqual({
    code: 1,
    stdout: "",
    stderr: "",
  });
  await expect(readFile(join(f.home, "state.db"))).rejects.toThrow();
});
it("source main keeps inspect help and exposes persistent observation actions without daemon access", async () => {
  const f = await fixture();
  for (const action of ["inspect", "observe", "events", "acknowledge"]) {
    const result = await f.run(["sources", action, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(action);
    expect(result.stderr).toBe("");
  }
  const help = await f.run(["sources", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("sources inspect");
  expect(help.stdout).toContain("observe|events|acknowledge");
  await expect(readFile(join(f.home, "state.db"))).rejects.toThrow();
});
it("actual main remote-control speaks only bounded stdio and queries signed receipts without opening a DB", async () => {
  const f = await fixture();
  await mkdir(f.home, { mode: 0o700 });
  const repo = join(f.root, "repo"),
    journal = join(f.home, "journal");
  await mkdir(repo, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const homeId = `home_${"a".repeat(32)}`,
    generation = `instance_${"b".repeat(32)}`;
  const graphScope = {
    schemaVersion: 1,
    tenantId: "local",
    principalId: "operator",
    workspaceId: "workspace",
  };
  const registry = {
    version: 1,
    home_id: homeId,
    daemon_protocol: 1,
    socket: join(f.home, "never-connect.sock"),
    journal_dir: journal,
    scopes: [{ alias: "project", repo_path: repo, graph_scope: graphScope }],
    keys: [
      {
        key_id: "operator",
        public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
        actor_id: "operator",
        scope_aliases: ["project"],
        max_validity_ms: 300000,
      },
    ],
  };
  const raw = JSON.stringify(registry),
    path = join(f.home, "control.json");
  await writeFile(path, raw, { mode: 0o600 });
  f.env["OSSTACK_REMOTE_CONTROL_REGISTRY"] = path;
  f.env["OSSTACK_REMOTE_CONTROL_SHA256"] = remoteHash(raw);
  const now = Date.now(),
    body = {
      domain: "osstack.remote-graph-cancel.v1",
      grant_id: randomUUID(),
      request_id: randomUUID(),
      actor_id: "operator",
      home_id: homeId,
      daemon_generation: generation,
      server_registry_sha256: remoteHash(raw),
      scope_alias: "project",
      repo_path: repo,
      graph_scope: graphScope,
      action: "graph.cancel",
      graph_run_id: "graph-one",
      graph_generation: 2,
      expected_revision: 4,
      nonce: "c".repeat(64),
      issued_at_ms: now - 20000,
      expires_at_ms: now - 10000,
      max_calls: 1,
    };
  const grant = {
    body,
    key_id: "operator",
    signature: sign(null, Buffer.from(deliveryCanonical(body)), privateKey).toString("base64"),
  };
  const child = f.start(["remote-control", "--stdio"]),
    channel = new RemoteChannel(child.stdout, child.stdin);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((done) => child.once("close", done));
  try {
    await channel.send({
      type: "control_hello",
      protocol: 1,
      nonce: "d".repeat(64),
      home_id: homeId,
      registry_sha256: remoteHash(raw),
    });
    const handshake = (await channel.receive()) as { token: string };
    expect(handshake).toMatchObject({ type: "control_grant", methods: ["cancel", "query"] });
    await channel.send({ type: "query", token: handshake.token, grant });
    expect(await channel.receive()).toMatchObject({
      type: "control_receipt",
      request_id: body.request_id,
      outcome: "not_found",
      physical_stop: "not_attested",
      nonce: "d".repeat(64),
    });
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
  } finally {
    channel.close();
  }
  await expect(readFile(join(f.home, "state.db"))).rejects.toThrow();
});
