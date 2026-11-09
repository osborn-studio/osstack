import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AttentionStore, createScratchDirSync, openDb } from "@osstack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineeringAccess } from "./engineering-access.js";
import { ContainedMissionService, HOST_PROCESS_RECHECK_MS, createContainedMissionService } from "./contained-mission-rpc.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function setup() {
  const root = realpathSync(createScratchDirSync("tests", "contained-wiring"));
  const path = join(root, "state.db"); const db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const authDir = join(root, "auth"); mkdirSync(authDir, { mode: 0o700 });
  const authFile = join(authDir, "authority.json");
  writeFileSync(authFile, JSON.stringify({ version: 1, principals: [{ credential_sha256: createHash("sha256").update("c".repeat(48)).digest("hex"), principal_id: "owner",
    client_session_id: "console", read_scopes: [], write_scopes: [], stop_scopes: [], operator_scopes: [] }] }), { mode: 0o600 });
  const home = join(root, "home"); mkdirSync(join(home, "bridge"), { recursive: true });
  const env = { OSSTACK_CONTAINED_CODEX_BIN: "/bin/true", OSSTACK_CONTAINED_CODEX_HOME: root, OSSTACK_CONTAINED_DOCKER_SOCKET: join(root, "d.sock"),
    OSSTACK_CONTAINED_DOCKER_DAEMON_ID: "d", OSSTACK_CONTAINED_BASE_IMAGE_ID: "sha256:" + "0".repeat(64) };
  const logs: string[] = [];
  const deps = { attention, owner, access: new EngineeringAccess(authFile), home, draining: () => false, env, log: (line: string) => { logs.push(line); } };
  const create = (extra: Record<string, string> = {}) => createContainedMissionService({ ...deps, env: { ...env, ...extra } });
  const portsOf = (service: unknown) => (service as { options: { host: { options: { ports: Record<string, unknown> } } } }).options.host.options.ports;
  return { root, home, create, portsOf, deps, logs };
}

describe("createContainedMissionService host process re-check", () => {
  const recheckOf = (service: unknown) => (service as { options: { host: { recheckMs: number | undefined } } }).options.host.recheckMs;
  it("re-checks unproven host-process records every 60 seconds by default and accepts an injected interval", async () => {
    const f = setup();
    expect(HOST_PROCESS_RECHECK_MS).toBe(60_000);
    const service = await f.create();
    expect(recheckOf(service)).toBe(60_000);
    await service.close();
    const injected = await createContainedMissionService({ ...f.deps, hostProcessRecheckMs: 5 });
    expect(recheckOf(injected)).toBe(5);
    await injected.close();
  });
});

describe("createContainedMissionService bridge wiring", () => {
  it("builds ports without the bridge when no config files exist", async () => {
    const f = setup(); const service = await f.create();
    expect(f.portsOf(service)["publishVerifyCheck"]).toBeUndefined();
    await service.close();
  });

  it("fails closed on an invalid bridge config", async () => {
    const f = setup();
    writeFileSync(join(f.home, "bridge", "apps.json"), "{nope");
    writeFileSync(join(f.home, "bridge", "rulesets.json"), "{}");
    await expect(f.create()).rejects.toThrow(/^BRIDGE_CONFIG_INVALID:/);
  });

  it("fails closed when only one config file exists", async () => {
    const f = setup();
    writeFileSync(join(f.home, "bridge", "rulesets.json"), JSON.stringify({ version: 1, repository: "a/b", mission_ruleset_ids: [1] }));
    await expect(f.create()).rejects.toThrow("BRIDGE_CONFIG_INVALID:incomplete");
  });

  it("enables the verify-check port when the config is valid", async () => {
    const f = setup();
    const key = join(f.root, "key.pem"); writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const app = { app_id: 1, installation_id: 2, private_key_path: key };
    writeFileSync(join(f.home, "bridge", "apps.json"), JSON.stringify({ version: 1, repository: "a/b", publisher: app, evidence: { ...app, app_id: 3, installation_id: 4 } }));
    writeFileSync(join(f.home, "bridge", "rulesets.json"), JSON.stringify({ version: 1, repository: "a/b", mission_ruleset_ids: [1] }));
    const service = await f.create();
    expect(typeof f.portsOf(service)["publishVerifyCheck"]).toBe("function");
    await service.close();
  });

  it("starts the registered sandbox CI service with no Docker configuration", async () => {
    const f = setup();
    const key = join(f.root, "key.pem"); writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const repository = "osborn-studio/osstack-bridge-sandbox";
    const publisher = { app_id: 5620012, installation_id: 2, private_key_path: key };
    writeFileSync(join(f.home, "bridge", "apps.json"), JSON.stringify({ version: 1, repository, publisher, evidence: { ...publisher, app_id: 3, installation_id: 4 } }));
    writeFileSync(join(f.home, "bridge", "rulesets.json"), JSON.stringify({ version: 1, repository, mission_ruleset_ids: [26577637, 26577639] }));
    const env = { OSSTACK_CONTAINED_CODEX_BIN: "/bin/true", OSSTACK_CONTAINED_CODEX_HOME: f.root, OSSTACK_CONTAINED_SANDBOX_CI_SCOPE: "a".repeat(64) };
    const service = await createContainedMissionService({ ...f.deps, env });
    expect(typeof f.portsOf(service)["admitGithubCiCandidate"]).toBe("function");
    await service.close();
    await expect(createContainedMissionService({ ...f.deps, env: { ...env, OSSTACK_BRIDGE: "1" } })).rejects.toThrow("BRIDGE_LIVE_NOT_IMPLEMENTED");
  });

  describe("OSSTACK_BRIDGE publication switch matrix", () => {
    function configure(f: ReturnType<typeof setup>, repository: string | null) {
      if (repository === null) return;
      const key = join(f.root, "key.pem"); writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
      const app = { app_id: 1, installation_id: 2, private_key_path: key };
      writeFileSync(join(f.home, "bridge", "apps.json"), JSON.stringify({ version: 1, repository, publisher: app, evidence: { ...app, app_id: 3, installation_id: 4 } }));
      writeFileSync(join(f.home, "bridge", "rulesets.json"), JSON.stringify({ version: 1, repository, mission_ruleset_ids: [1] }));
    }
    type Publish = (input: unknown) => Promise<unknown>;
    const attempt = async (f: ReturnType<typeof setup>, service: unknown, repository: string): Promise<string> => {
      const publish = f.portsOf(service)["publish"] as Publish;
      // W13-C2: publish runs inside the host-process guard, which is keyed by the Mission id.
      try { await publish({ mission: { mission_id: "cm_00000000-0000-4000-8000-000000000001" }, spec: { repository, publication: { remote: "origin", repository, base: "main", draft: false } } }); return "ok"; }
      catch (error) { return (error as Error).message; }
    };
    const modes: Array<[string, Record<string, string>]> = [["unset", {}], ["0", { OSSTACK_BRIDGE: "0" }], ["shadow", { OSSTACK_BRIDGE: "shadow" }]];
    for (const [label, extra] of modes) {
      for (const scope of ["configured", "other", "none"] as const) {
        it(`OSSTACK_BRIDGE=${label}, bridge ${scope}`, async () => {
          const f = setup(); configure(f, scope === "none" ? null : "a/b");
          const service = await f.create(extra);
          const ports = f.portsOf(service);
          const outcome = await attempt(f, service, scope === "other" ? "x/y" : "a/b");
          expect(f.logs.some(l => l.includes("disabled by OSSTACK_BRIDGE=0"))).toBe(label === "0" && scope !== "none");
          if (scope === "none") {
            expect(ports["publishVerifyCheck"]).toBeUndefined();
            expect(outcome).not.toMatch(/BRIDGE_DISABLED|CONTAINED_BRIDGE_REPOSITORY/);
          } else if (scope === "other") {
            expect(outcome).toBe("CONTAINED_BRIDGE_REPOSITORY");
          } else if (label === "0") {
            expect(outcome).toBe("BRIDGE_DISABLED");
            expect(ports["publishVerifyCheck"]).toBeUndefined();
          } else {
            expect(outcome).not.toMatch(/BRIDGE_DISABLED|CONTAINED_BRIDGE_REPOSITORY/);
            expect(typeof ports["publishVerifyCheck"]).toBe("function");
          }
          await service.close();
        });
      }
    }
    it("OSSTACK_BRIDGE=1 and an invalid value still fail the start", async () => {
      const f = setup(); configure(f, "a/b");
      await expect(f.create({ OSSTACK_BRIDGE: "1" })).rejects.toThrow("BRIDGE_LIVE_NOT_IMPLEMENTED");
      await expect(f.create({ OSSTACK_BRIDGE: "off" })).rejects.toThrow("BRIDGE_MODE_INVALID");
    });
  });
});


describe("bridge startup recovery ordering", () => {
  function fixture(revisionRecovery: (signal: AbortSignal) => Promise<void>) {
    const calls: string[] = [];
    const host = { recover: vi.fn(async () => { calls.push("host"); }), tick: vi.fn(async () => {}), close: vi.fn(async () => { calls.push("close"); }) };
    const timer = (name: string) => ({ start: vi.fn(() => { calls.push(name); }), stop: vi.fn(async () => {}) });
    const live = timer("live"); const stoppedScan = timer("stopped"); const checkRetry = timer('checks');
    const service = new ContainedMissionService({ host: host as never, access: {} as never, draining: () => false,
      revisionRecovery, live, stoppedScan, checkRetry });
    return { service, calls, host, live, stoppedScan, checkRetry };
  }
  it("runs host recovery, then read-only receipt recovery, then timers, once", async () => {
    const f = fixture(async () => { f.calls.push("receipts"); });
    await Promise.all([f.service.start(), f.service.start()]);
    expect(f.calls).toEqual(["host", "receipts", "live", "stopped", 'checks']);
    await f.service.close();
    expect(f.checkRetry.stop).toHaveBeenCalledOnce();
  });
  it("starts no timers after receipt recovery fails", async () => {
    const f = fixture(async () => { throw Error("receipt_read_failed"); });
    await expect(f.service.start()).rejects.toThrow("receipt_read_failed");
    expect(f.live.start).not.toHaveBeenCalled();
    expect(f.stoppedScan.start).not.toHaveBeenCalled();
    expect(f.checkRetry.start).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("signals shutdown to cooperative receipt readers and still closes the host", async () => {
    let observed: AbortSignal | undefined;
    const f = fixture(signal => new Promise<void>((_resolve, reject) => {
      observed = signal;
      signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
    }));
    const starting = f.service.start();
    const rejection = expect(starting).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(observed).toBeDefined());
    await f.service.close(); await rejection;
    expect(observed?.aborted).toBe(true);
    expect(f.host.close).toHaveBeenCalledOnce();
    expect(f.live.start).not.toHaveBeenCalled();
  });
  it("does not start timers if closed while receipt recovery is pending", async () => {
    let release!: () => void;
    const f = fixture(() => new Promise<void>(resolve => { release = resolve; }));
    const start = f.service.start();
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    const close = f.service.close(); release();
    await Promise.all([start, close]);
    expect(f.live.start).not.toHaveBeenCalled();
    expect(f.host.close).toHaveBeenCalledOnce();
  });
});


describe("live bridge configuration boundary", () => {
  it("rejects absent configuration instead of assembling host-credential fallback ports", async () => {
    const f = setup();
    const { loadLiveBridgeConfiguration } = await import("./contained-mission-bridge-assembly.js");
    await expect(loadLiveBridgeConfiguration(f.home)).rejects.toThrow("BRIDGE_CONFIG_INVALID");
  });
});


function liveConfiguration(f: ReturnType<typeof setup>) {
  chmodSync(f.home, 0o700); chmodSync(join(f.home, "bridge"), 0o700);
  const key = join(f.root, "publisher.pem");
  writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  const app = { app_id: 1, installation_id: 2, private_key_path: key };
  const { publicKey } = generateKeyPairSync("ed25519");
  const values: Record<string, unknown> = {
    "apps.json": { version: 1, repository: "a/b", publisher: app, evidence: { ...app, app_id: 3, installation_id: 4 } },
    "rulesets.json": { version: 1, repository: "a/b", mission_ruleset_ids: [1] },
    "producers.json": { version: 1, repository: "a/b", publisher: [{ actor_id: 5, app_id: 1 }], reviewers: [{ actor_id: 6, app_id: 7 }] },
    "revision-issuer.json": { version: 1, keys: [{ key_id: "k1", public_key_spki_b64: publicKey.export({ format: "der", type: "spki" }).toString("base64"), max_validity_ms: 86_400_000 }] },
  };
  for (const [name, value] of Object.entries(values)) writeFileSync(join(f.home, "bridge", name), JSON.stringify(value), { mode: 0o600 });
}

describe("live assembly configuration validation", () => {
  for (const missing of ["apps.json", "rulesets.json", "producers.json", "revision-issuer.json"]) {
    it(`fails closed when ${missing} is missing`, async () => {
      const f = setup(); liveConfiguration(f); rmSync(join(f.home, "bridge", missing));
      const { loadLiveBridgeConfiguration } = await import("./contained-mission-bridge-assembly.js");
      await expect(loadLiveBridgeConfiguration(f.home)).rejects.toThrow("BRIDGE_CONFIG_INVALID");
    });
  }
  it("validates repository and publisher App bindings", async () => {
    const f = setup(); liveConfiguration(f);
    const { loadLiveBridgeConfiguration } = await import("./contained-mission-bridge-assembly.js");
    expect((await loadLiveBridgeConfiguration(f.home)).registry.repository).toBe("a/b");
    writeFileSync(join(f.home, "bridge", "producers.json"), JSON.stringify({ version: 1, repository: "a/b", publisher: [{ actor_id: 5, app_id: 8 }], reviewers: [{ actor_id: 6, app_id: 7 }] }));
    await expect(loadLiveBridgeConfiguration(f.home)).rejects.toThrow("publisher_mismatch");
  });
  it('constructs the production factory from real host ports and signed configuration without side effects', async () => {
    const f = setup(); liveConfiguration(f);
    const { ContainedMissionStore, RevisionChainStore } = await import('@osstack/core');
    const { createProductionLiveBridge } = await import('./contained-mission-bridge-production.js');
    const service = await f.create();
    const ports = f.portsOf(service) as unknown as import('./contained-mission-ports.js').ContainedMissionHostPorts;
    const host = (service as unknown as { options: { host: import('./contained-mission-host.js').ContainedMissionHost } }).options.host;
    const assembly = await createProductionLiveBridge({ home: f.home,
      chains: new RevisionChainStore(f.deps.attention, f.deps.owner), missions: new ContainedMissionStore(f.deps.attention, f.deps.owner),
      ports, host, access: f.deps.access, enabled: () => true, now: Date.now, log: () => {},
      launchCaps: { executor_seconds: 600, verify_seconds: 120 } });
    expect(ports.revisionPublication).toBe(assembly.publication);
    expect(assembly.grants).toBeDefined();
    const cancelled = new AbortController();
    const recovering = assembly.revisionRecovery(cancelled.signal);
    const rejected = expect(recovering).rejects.toThrow();
    cancelled.abort(); await rejected;
    await expect(assembly.revisionRecovery(new AbortController().signal)).resolves.toBeUndefined();
    assembly.live.start();
    await expect(assembly.live.scan()).resolves.toBeUndefined();
    await expect(assembly.stoppedScan.scan()).resolves.toBeUndefined();
    await assembly.live.stop();
    await expect(assembly.revisionRecovery(new AbortController().signal)).rejects.toThrow();
    await assembly.stoppedScan.stop(); await service.close();
  });
  it("installs launch, publication, grant and scan services without starting work", async () => {
    const f = setup(); liveConfiguration(f);
    const { ContainedMissionStore, RevisionChainStore } = await import("@osstack/core");
    const { assembleLiveBridge } = await import("./contained-mission-bridge-assembly.js");
    const missions = new ContainedMissionStore(f.deps.attention, f.deps.owner);
    const chains = new RevisionChainStore(f.deps.attention, f.deps.owner);
    const service = await f.create();
    const ports = f.portsOf(service) as unknown as import("./contained-mission-ports.js").ContainedMissionHostPorts;
    const read = vi.fn(async () => { throw Error("unexpected_read"); });
    const write = vi.fn(async () => { throw Error("unexpected_write"); });
    const host = { isBusy: () => false, cancel: write, cancelFromBridge: write };
    const assemblyDeps = { home: f.home, chains, missions, ports, host, access: f.deps.access,
      enabled: () => true, now: Date.now, log: () => {}, launchCaps: { executor_seconds: 60, verify_seconds: 60 },
      protectedSetDigest: () => "a".repeat(64), readPr: read, headIsDescendant: read, stoppedRead: read,
      publication: { runner: { run: write }, readPr: read, localGit: read, remoteHead: read, compare: read, preflight: write, checkEnabled: true } };
    await expect(assembleLiveBridge({ ...assemblyDeps, protectedSetDigest: () => "invalid" })).rejects.toThrow("protected_set_digest");
    expect(ports.revision).toBeUndefined(); expect(ports.revisionPublication).toBeUndefined();
    const assembly = await assembleLiveBridge(assemblyDeps);
    expect(typeof ports.revision?.assertActive).toBe("function");
    expect(ports.revisionPublication).toBe(assembly.publication);
    expect(typeof assembly.grants.preview).toBe("function");
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    const options = (value: unknown) => (value as { options: { readLimiter: unknown } }).options;
    expect(options(assembly.live).readLimiter).toBe(assembly.readLimiter);
    expect(options(assembly.stoppedScan).readLimiter).toBe(assembly.readLimiter);
    await assembly.live.stop(); await assembly.stoppedScan.stop(); await service.close();
  });
});


describe("production receipt recovery remains active with publication off", () => {
  for (const mode of [undefined, "0", "shadow"]) {
    it(`starts read-only accounting with bridge mode ${mode ?? "unset"}`, async () => {
      const f = setup();
      const service = await f.create(mode ? { OSSTACK_BRIDGE: mode } : {});
      const options = (service as unknown as { options: { revisionRecovery: unknown; grants: unknown } }).options;
      expect(typeof options.revisionRecovery).toBe("function");
      expect(options.grants).toBeUndefined();
      await service.start(); await service.close();
    });
  }
});
