import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { join, relative, isAbsolute, sep, dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { GraphDelegationStatus } from "@osstack/protocol";
import { deliveryCanonical } from "@osstack/core";
import { DeploymentIdentitySchema } from "./home-inventory.js";
import { readPrivateDeliveryFile } from "./follow-up-delivery-host.js";
import { RemoteChannel, remoteHash } from "./remote-home-protocol.js";
import {
  RemoteCancelServerRegistry,
  RemoteCancelHello,
  RemoteCancelRequest,
  RemoteCancelReceipt,
  verifyRemoteCancelGrant,
  remoteCancelDigest,
  assertRemoteJournal,
  writeRemoteJournal,
  readRemoteJournal,
} from "./remote-cancel-protocol.js";

async function registry(path: string, digest: string): Promise<RemoteCancelServerRegistry> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("remote_cancel_registry_invalid");
  const raw = await readPrivateDeliveryFile(path, 32768);
  if (remoteHash(raw) !== digest) throw Error("remote_cancel_registry_changed");
  const value = RemoteCancelServerRegistry.parse(JSON.parse(raw.toString("utf8")));
  await assertRemoteJournal(value.journal_dir);
  for (const scope of value.scopes) {
    for (const protectedPath of [path, value.journal_dir, value.socket]) {
      const rel = relative(scope.repo_path, protectedPath);
      if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
        throw Error("remote_cancel_registry_in_repository");
    }
    if (
      (await realpath(scope.repo_path)) !== scope.repo_path ||
      (await lstat(scope.repo_path)).isDirectory() !== true
    )
      throw Error("remote_cancel_scope_unavailable");
  }
  return value;
}
/** One connected existing daemon: all identity/status/cancel frames stay bound to that same process. */
async function graphConnection(socketPath: string) {
  await assertRemoteJournal(dirname(socketPath));
  if ((await realpath(socketPath)) !== socketPath) throw Error("remote_cancel_endpoint_invalid");
  const before = await lstat(socketPath);
  if (!before.isSocket() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0)
    throw Error("remote_cancel_endpoint_invalid");
  const socket = connect(socketPath),
    channel = new RemoteChannel(socket, socket, 65536 + 1024, 8);
  let id = 0;
  return {
    async call(
      method: "deployment.identity" | "graph.status" | "graph.cancel",
      params?: unknown,
    ): Promise<unknown> {
      const requestId = ++id;
      await channel.send({ id: requestId, method, ...(params === undefined ? {} : { params }) });
      const raw = await channel.receive();
      await assertRemoteJournal(dirname(socketPath));
      const current = await lstat(socketPath);
      if (current.ino !== before.ino || current.dev !== before.dev)
        throw Error("remote_cancel_endpoint_changed");
      return z
        .object({ id: z.literal(requestId), ok: z.literal(true), result: z.unknown() })
        .strict()
        .parse(raw).result;
    },
    close() {
      channel.close();
      socket.destroy();
    },
  };
}
export async function handleRemoteControlExportCommand(
  args: string[],
  deps: { input?: Readable; output?: Writable; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    (deps.output ?? process.stdout).write(
      "remote-control --stdio\nDedicated signed Graph cancellation/receipt exporter. Requires host-private OSSTACK_REMOTE_CONTROL_REGISTRY and SHA256 configuration. No generic RPC or automatic daemon startup.\n",
    );
    return 0;
  }
  if (args.length !== 1 || args[0] !== "--stdio") return 1;
  const env = deps.env ?? process.env,
    input = deps.input ?? process.stdin,
    output = deps.output ?? process.stdout;
  const path = env["OSSTACK_REMOTE_CONTROL_REGISTRY"] ?? "",
    pin = env["OSSTACK_REMOTE_CONTROL_SHA256"] ?? "";
  let rpc: Awaited<ReturnType<typeof graphConnection>> | undefined;
  let channel: RemoteChannel | undefined;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    rpc?.close();
    channel?.close();
    input.pause();
  }, 10000);
  const active = () => {
    if (expired) throw Error("remote_cancel_timeout");
  };
  try {
    const config = await registry(path, pin);
    channel = new RemoteChannel(input, output);
    const hello = RemoteCancelHello.parse(await channel.receive());
    if (hello.home_id !== config.home_id || hello.registry_sha256 !== pin)
      throw Error("remote_cancel_identity_mismatch");
    const token = randomBytes(32).toString("hex");
    await channel.send({
      type: "control_grant",
      protocol: 1,
      nonce: hello.nonce,
      home_id: config.home_id,
      daemon_generation: "unobserved",
      registry_sha256: pin,
      token,
      methods: ["cancel", "query"],
    });
    const request = RemoteCancelRequest.parse(await channel.receive());
    if (request.token !== token) throw Error("remote_cancel_token_invalid");
    const grant = request.grant,
      b = grant.body,
      hash = remoteCancelDigest(grant);
    verifyRemoteCancelGrant(grant, config, pin, false);
    const startedPath = join(config.journal_dir, `${b.request_id}.started.json`),
      resultPath = join(config.journal_dir, `${b.request_id}.result.json`);
    const base = {
      type: "control_receipt" as const,
      protocol: 1 as const,
      nonce: hello.nonce,
      home_id: config.home_id,
      request_id: b.request_id,
      request_sha256: hash,
      daemon_generation: b.daemon_generation,
      graph_generation: b.graph_generation,
      graph_run_id: b.graph_run_id,
      physical_stop: "not_attested" as const,
      observed_revision: null,
    };
    const existing = await readRemoteJournal(startedPath);
    if (existing && deliveryCanonical(existing) !== deliveryCanonical({ request_sha256: hash, grant }))
      throw Error("remote_cancel_idempotency_conflict");
    const prior = await readRemoteJournal(resultPath);
    if (prior) {
      const receipt = RemoteCancelReceipt.parse(prior);
      if (
        !existing ||
        receipt.request_sha256 !== hash ||
        receipt.home_id !== b.home_id ||
        receipt.request_id !== b.request_id ||
        receipt.daemon_generation !== b.daemon_generation ||
        receipt.graph_generation !== b.graph_generation ||
        receipt.graph_run_id !== b.graph_run_id ||
        (receipt.outcome === "stop_requested" &&
          (receipt.observed_revision === null || receipt.observed_revision <= b.expected_revision))
      )
        throw Error("remote_cancel_receipt_invalid");
      await channel.send({ ...receipt, nonce: hello.nonce });
      return 0;
    }
    if (request.type === "query" || existing) {
      await channel.send({ ...base, outcome: existing ? "delivery_unknown" : "not_found" });
      return 0;
    }
    verifyRemoteCancelGrant(grant, config, pin, true);
    active();
    rpc = await graphConnection(config.socket);
    active();
    const identity = DeploymentIdentitySchema.parse(await rpc.call("deployment.identity"));
    if (
      identity.home_id !== b.home_id ||
      identity.generation !== b.daemon_generation ||
      identity.protocol_version !== config.daemon_protocol
    )
      throw Error("remote_cancel_identity_mismatch");
    const status = GraphDelegationStatus.parse(
      await rpc.call("graph.status", { schemaVersion: 1, scope: b.graph_scope, graphRunId: b.graph_run_id }),
    );
    if (
      status.graphRunId !== b.graph_run_id ||
      deliveryCanonical(status.scope) !== deliveryCanonical(b.graph_scope) ||
      status.generation !== b.graph_generation ||
      status.revision !== b.expected_revision
    )
      throw Error("remote_cancel_generation_mismatch");
    // Registry revocation and grant time are rechecked immediately before durable reserve.
    await registry(path, pin);
    verifyRemoteCancelGrant(grant, config, pin, true);
    active();
    if (!(await writeRemoteJournal(startedPath, { request_sha256: hash, grant }))) {
      const other = await readRemoteJournal(startedPath);
      if (deliveryCanonical(other) !== deliveryCanonical({ request_sha256: hash, grant }))
        throw Error("remote_cancel_idempotency_conflict");
      await channel.send({ ...base, outcome: "delivery_unknown" });
      return 0;
    }
    let receipt: RemoteCancelReceipt = { ...base, outcome: "delivery_unknown" };
    try {
      await registry(path, pin);
      verifyRemoteCancelGrant(grant, config, pin, true);
      active();
      const result = GraphDelegationStatus.parse(
        await rpc.call("graph.cancel", {
          schemaVersion: 1,
          kind: "cancel",
          scope: b.graph_scope,
          graphRunId: b.graph_run_id,
          expectedRevision: b.expected_revision,
          idempotencyKey: `remote-cancel:${b.request_id}`,
        }),
      );
      if (
        result.graphRunId !== b.graph_run_id ||
        deliveryCanonical(result.scope) !== deliveryCanonical(b.graph_scope) ||
        result.generation !== b.graph_generation ||
        result.revision <= b.expected_revision ||
        !["cancel_pending", "cancelled"].includes(result.status)
      )
        throw Error("remote_cancel_receipt_invalid");
      receipt = { ...base, outcome: "stop_requested", observed_revision: result.revision };
    } catch {
      /* The durable reserve never re-arms, including a crash or lost daemon response. */
    }
    await writeRemoteJournal(resultPath, receipt);
    await channel.send(receipt);
    return 0;
  } catch {
    return 1;
  } finally {
    clearTimeout(timer);
    rpc?.close();
    channel?.close();
    input.pause();
  }
}
