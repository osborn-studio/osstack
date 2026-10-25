import { createServer, type Socket, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { encodeFrame } from "@osstack/hermes-adapter";
import { inspectWorkerForViewer } from "./worker-viewer-rpc.js";
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function host(action: (socket: Socket) => void) {
  const path = join(tmpdir(), `wv-${randomUUID().slice(0, 8)}.sock`);
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    action(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}
const params = { repo_path: "/repo", default_tenant: true, view_id: "token" };
it("closes an in-flight socket when only the local viewer is aborted", async () => {
  let connected!: () => void;
  const established = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let closed!: () => void;
  const gone = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const path = await host((socket) => {
    socket.on("data", () => connected());
    socket.on("close", () => closed());
  });
  const controller = new AbortController();
  const pending = inspectWorkerForViewer(path, params, controller.signal);
  const rejected = expect(pending).rejects.toThrow("viewer_closed");
  await established;
  controller.abort();
  await rejected;
  await gone;
});
it.each([
  "early_close",
  "wrong_id",
  "extra_frames",
  "oversized",
  "malformed",
])("rejects %s without unhandled socket errors", async (kind) => {
  const path = await host((socket) =>
    socket.once("data", () => {
      if (kind === "early_close") socket.end();
      else if (kind === "wrong_id")
        socket.end(encodeFrame({ id: 2, ok: true, result: {} }));
      else if (kind === "extra_frames")
        socket.end(
          Buffer.concat([
            encodeFrame({ id: 1, ok: true, result: {} }),
            encodeFrame({ id: 1, ok: true, result: {} }),
          ]),
        );
      else if (kind === "oversized") socket.end(Buffer.alloc(70000));
      else socket.end(Buffer.from([0, 0, 0, 1, 255]));
    }),
  );
  await expect(
    inspectWorkerForViewer(path, params, new AbortController().signal),
  ).rejects.toThrow();
});
