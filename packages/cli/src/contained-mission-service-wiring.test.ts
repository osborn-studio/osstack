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
  const deps = { attention, owner, access: new EngineeringAccess(authFile), home, draining: () => false, env };
  const create = () => createContainedMissionService(deps);
  const portsOf = (service: unknown) => (service as { options: { host: { options: { ports: Record<string, unknown> } } } }).options.host.options.ports;
  return { root, home, create, portsOf, deps };
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
});
