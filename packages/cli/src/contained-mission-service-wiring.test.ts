import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AttentionStore, createScratchDirSync, openDb } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { EngineeringAccess } from "./engineering-access.js";
import { HOST_PROCESS_RECHECK_MS, createContainedMissionService } from "./contained-mission-rpc.js";

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
