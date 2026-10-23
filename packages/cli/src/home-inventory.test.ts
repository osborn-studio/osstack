import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeploymentIdentitySchema,
  ensureDeploymentHomeId,
  inspectHomes,
  readHomeIdentity,
} from "./home-inventory.js";

const identity = {
  schema_version: 1,
  home_id: "home_12345678901234567890123456789012",
  generation: "instance_12345678901234567890123456789012",
  version: "1.2.3",
  protocol_version: 2,
  database_schema: 42,
  started_at_ms: 1,
  deployment_kind: "unknown",
  build_digest: null,
  build_evidence: "unavailable",
};
const entry = (socket: string) => ({
  home_id: identity.home_id,
  socket,
  enabled: true,
  desired: { version: "1.2.3", protocol_version: 2 },
});
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function endpoint(reply: unknown, raw = false) {
  const dir = await mkdtemp(join(tmpdir(), "home-inventory-"));
  const socket = join(dir, "d.sock");
  const server = createServer((client) => {
    client.once("data", () => {
      if (raw) {
        client.end(reply as Buffer);
        return;
      }
      const body = Buffer.from(
        JSON.stringify({ id: 1, ok: true, result: reply }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      client.end(Buffer.concat([header, body]));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}
describe("read-only explicit homes inventory", () => {
  it("persists a stable home ID only when initialized by the daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "home-identity-"));
    const first = await ensureDeploymentHomeId(home);
    expect(await ensureDeploymentHomeId(home)).toBe(first);
    expect(
      JSON.parse(
        await readFile(join(home, "deployment-identity.json"), "utf8"),
      ),
    ).toEqual({ schema_version: 1, home_id: first });
    await writeFile(join(home, "deployment-identity.json"), "broken");
    await expect(ensureDeploymentHomeId(home)).rejects.toThrow(
      "identity_unavailable",
    );
    expect(await readFile(join(home, "deployment-identity.json"), "utf8")).toBe(
      "broken",
    );
  });
  it("rejects a symlink identity without modifying its destination", async () => {
    const home = await mkdtemp(join(tmpdir(), "home-identity-"));
    const outside = join(home, "outside");
    await writeFile(outside, "untouched");
    await symlink(outside, join(home, "deployment-identity.json"));
    await expect(ensureDeploymentHomeId(home)).rejects.toThrow(
      "identity_unavailable",
    );
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });
  it("reads the real framed daemon response and matches pinned home and version", async () => {
    const socket = await endpoint(identity);
    const result = await inspectHomes({
      schema_version: 1,
      homes: [entry(socket)],
    });
    expect(result.homes[0]).toMatchObject({
      status: "matched",
      observed: identity,
    });
  });
  it("never accepts the right version from the wrong home", async () => {
    const socket = await endpoint({
      ...identity,
      home_id: "home_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const result = await inspectHomes({
      schema_version: 1,
      homes: [entry(socket)],
    });
    expect(result.homes[0]).toMatchObject({
      status: "identity_mismatch",
      observed: null,
    });
  });
  it("compares desired build and deployment evidence without manufacturing it", async () => {
    const socket = await endpoint(identity);
    const result = await inspectHomes({
      schema_version: 1,
      homes: [
        {
          ...entry(socket),
          desired: {
            version: "1.2.3",
            build_digest: "a".repeat(64),
            deployment_kind: "npm",
          },
        },
      ],
    });
    expect(result.homes[0]?.status).toBe("unknown");
  });
  it("reports actual version drift and keeps unreachable homes in the denominator", async () => {
    const socket = await endpoint({ ...identity, version: "1.2.4" });
    const result = await inspectHomes({
      schema_version: 1,
      homes: [
        entry(socket),
        {
          ...entry(socket + "-missing"),
          home_id: "home_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    });
    expect(result.homes.map((row) => row.status)).toEqual([
      "drift",
      "unreachable",
    ]);
    expect(result.complete).toBe(false);
  });
  it("rejects malformed, duplicate and oversized manifests before reading endpoints", async () => {
    await expect(
      inspectHomes({
        schema_version: 1,
        homes: [entry("/tmp/a"), entry("/tmp/b")],
      }),
    ).rejects.toThrow("invalid_manifest");
    await expect(
      inspectHomes({
        schema_version: 1,
        homes: [{ ...entry("/tmp/a"), shell: "x" }],
      }),
    ).rejects.toThrow("invalid_manifest");
    await expect(
      inspectHomes({
        schema_version: 1,
        homes: Array.from({ length: 33 }, () => entry("/tmp/a")),
      }),
    ).rejects.toThrow("invalid_manifest");
  });
  it("rejects oversized frame headers before buffering a body and malformed identity", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(65537);
    const socket = await endpoint(header, true);
    await expect(readHomeIdentity(socket, 100)).rejects.toThrow(
      "invalid_response",
    );
    const old = await endpoint({ version: "1.2.3" });
    expect(
      (await inspectHomes({ schema_version: 1, homes: [entry(old)] })).homes[0]
        ?.status,
    ).toBe("unknown");
    expect(
      DeploymentIdentitySchema.safeParse({ ...identity, started_at_ms: NaN })
        .success,
    ).toBe(false);
  });
  it("disabled entries never contact a socket and cannot count as a match", async () => {
    const result = await inspectHomes({
      schema_version: 1,
      homes: [{ ...entry("/tmp/missing-home"), enabled: false }],
    });
    expect(result.homes[0]).toMatchObject({
      status: "disabled",
      observed: null,
    });
  });
  it("rejects non-socket endpoints and duplicate aliases but accepts a pinned short socket alias", async () => {
    const home = await mkdtemp(join(tmpdir(), "home-endpoint-"));
    await mkdir(join(home, "directory"));
    expect(
      (
        await inspectHomes({
          schema_version: 1,
          homes: [entry(join(home, "directory"))],
        })
      ).homes[0]?.status,
    ).toBe("unsafe_endpoint");
    const socket = await endpoint(identity);
    const alias = join(home, "alias");
    await symlink(socket, alias);
    expect(
      (await inspectHomes({ schema_version: 1, homes: [entry(alias)] }))
        .homes[0]?.status,
    ).toBe("matched");
    await expect(
      inspectHomes({
        schema_version: 1,
        homes: [
          entry(socket),
          { ...entry(alias), home_id: "home_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        ],
      }),
    ).rejects.toThrow("duplicate_socket");
  });
});

it("times out an unresponsive local endpoint and closes the connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "home-hung-"));
  const socket = join(dir, "d.sock");
  let closed = false;
  const server = createServer((client) => {
    client.on("data", () => {});
    client.on("close", () => {
      closed = true;
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await expect(readHomeIdentity(socket, 20)).rejects.toThrow("unreachable");
  await vi.waitFor(() => expect(closed).toBe(true));
});
