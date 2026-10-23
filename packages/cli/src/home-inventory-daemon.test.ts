import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import {
  DeploymentIdentitySchema,
  readHomeIdentity,
} from "./home-inventory.js";
import { main } from "./bin.js";
let daemon: DaemonHandles | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("reports the serving home identity through the actual CLI and preserves ID across daemon generations", async () => {
  const home = await mkdtemp(join(tmpdir(), "homes-daemon-"));
  vi.stubEnv("OSSTACK_HOME", home);
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  const socket = join(home, "d.sock");
  daemon = await startDaemon({ socketPath: socket, adapters: [] });
  const first = DeploymentIdentitySchema.parse(await readHomeIdentity(socket));
  expect(first.database_schema).toBe(42);
  const saved = JSON.parse(
    await readFile(join(home, "deployment-identity.json"), "utf8"),
  );
  expect(first.home_id).toBe(saved.home_id);
  const manifest = join(home, "homes.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schema_version: 1,
      homes: [
        {
          home_id: first.home_id,
          socket,
          enabled: true,
          desired: {
            version: first.version,
            protocol_version: first.protocol_version,
          },
        },
      ],
    }),
  );
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(
    await main(["homes", "inspect", "--manifest", manifest, "--json"]),
  ).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
    mode: "readonly_inventory",
    homes: [{ status: "matched", observed: { generation: first.generation } }],
  });
  await daemon.close();
  daemon = await startDaemon({ socketPath: socket, adapters: [] });
  const second = DeploymentIdentitySchema.parse(await readHomeIdentity(socket));
  expect(second.home_id).toBe(first.home_id);
  expect(second.generation).not.toBe(first.generation);
});
