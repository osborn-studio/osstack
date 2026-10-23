import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeploymentIdentitySchema,
  ensureDeploymentHomeId,
  inspectHomes,
  handleHomesCommand,
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
      status: "matched_requested",
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
    expect(result.complete).toBe(false);
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
    ).toBe("matched_requested");
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

it("concurrent initialization and a canonical home alias converge on one complete pin", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-concurrent-"));
  const alias = home + "-alias";
  await symlink(home, alias);
  const values = await Promise.all(
    Array.from({ length: 16 }, (_, n) =>
      ensureDeploymentHomeId(n % 2 ? alias : home),
    ),
  );
  expect(new Set(values).size).toBe(1);
  expect(await readdir(home)).toEqual(["deployment-identity.json"]);
});
it("file sync failure never publishes a partial pin and permits retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-fault-"));
  const probe = await open(join(home, "probe"), "w");
  const sync = vi
    .spyOn(Object.getPrototypeOf(probe), "sync")
    .mockRejectedValueOnce(
      Object.assign(new Error("injected IO failure"), { code: "EIO" }),
    );
  try {
    await expect(ensureDeploymentHomeId(home)).rejects.toThrow(
      "identity_unavailable",
    );
    expect(await readdir(home)).toEqual(["probe"]);
  } finally {
    sync.mockRestore();
    await probe.close();
  }
  expect(await ensureDeploymentHomeId(home)).toMatch(/^home_[a-f0-9]{32}$/);
});
it("normalizes missing and malformed manifest errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-manifest-"));
  await expect(
    handleHomesCommand(["inspect", "--manifest", join(home, "missing")]),
  ).rejects.toThrow("invalid_manifest");
  await writeFile(join(home, "bad"), "{private invalid contents");
  await expect(
    handleHomesCommand(["inspect", "--manifest", join(home, "bad")]),
  ).rejects.toThrow("invalid_manifest");
});
it("classifies an endpoint closing without a response as unreachable", async () => {
  const socket = await endpoint(Buffer.alloc(0), true);
  expect(
    (await inspectHomes({ schema_version: 1, homes: [entry(socket)] })).homes[0]
      ?.status,
  ).toBe("unreachable");
});

it("directory sync failure never changes the published pin on retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-dir-fault-"));
  const probe = await open(join(home, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.sync;
  let calls = 0;
  const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (
    this: typeof probe,
  ) {
    if (++calls === 2)
      throw Object.assign(new Error("sync failed"), { code: "EIO" });
    await original.call(this);
  });
  try {
    await expect(ensureDeploymentHomeId(home)).rejects.toThrow(
      "identity_unavailable",
    );
  } finally {
    sync.mockRestore();
    await probe.close();
  }
  const pinned = JSON.parse(
    await readFile(join(home, "deployment-identity.json"), "utf8"),
  ).home_id;
  expect(await ensureDeploymentHomeId(home)).toBe(pinned);
});
it("does not repair an empty identity record", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-empty-"));
  await writeFile(join(home, "deployment-identity.json"), "");
  await expect(ensureDeploymentHomeId(home)).rejects.toThrow(
    "identity_unavailable",
  );
  expect(await readFile(join(home, "deployment-identity.json"), "utf8")).toBe(
    "",
  );
});
it("rejects trailing bytes following a valid identity frame", async () => {
  const body = Buffer.from(
    JSON.stringify({ id: 1, ok: true, result: identity }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const socket = await endpoint(
    Buffer.concat([header, body, Buffer.from("extra")]),
    true,
  );
  await expect(readHomeIdentity(socket)).rejects.toThrow("invalid_response");
});

it("does not misclassify a Node programming error as unavailable filesystem identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-programming-error-"));
  const probe = await open(join(home,"probe"), "w");
  const failure = Object.assign(new TypeError("bad argument"), {code:"ERR_INVALID_ARG_TYPE"});
  const sync = vi.spyOn(Object.getPrototypeOf(probe), "sync").mockRejectedValueOnce(failure);
  try { await expect(ensureDeploymentHomeId(home)).rejects.toBe(failure); }
  finally {sync.mockRestore();await probe.close();}
});
