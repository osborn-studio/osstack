import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deliveryCanonical } from "@osstack/core";
import {
  RemoteChannel,
  type RemoteHomeEntry,
  RemoteClientRegistry,
  assertPrivateRemoteFile,
  readPinnedRemoteRegistry,
} from "./remote-home-protocol.js";
import { buildRemoteSshArgs } from "./remote-home-reader.js";
import { readPrivateDeliveryFile } from "./follow-up-delivery-host.js";
import {
  SignedRemoteCancelGrant,
  RemoteCancelHandshake,
  RemoteCancelReceipt,
  remoteCancelDigest,
  initializeRemoteJournal,
  writeRemoteJournal,
  readRemoteJournal,
} from "./remote-cancel-protocol.js";
export function buildRemoteControlSshArgs(entry: RemoteHomeEntry, known: string): string[] {
  const args = buildRemoteSshArgs(entry, known);
  args[args.length - 1] = "osstack remote-control --stdio";
  return args;
}
export interface RemoteCancelClientDependencies {
  home: string;
  spawn?: typeof spawn;
  timeoutMs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
export const REMOTE_CANCEL_HELP = `remote-home cancel|query --registry FILE --sha256 HASH --alias NAME --grant FILE\nSigned exact Graph cancellation only. Local durable attempt precedes transport; repeat cancel becomes query, never resend.\nRemote stop_requested is not physical stopped proof. Missing/offline receipts remain unknown.\nnot_sent reports only a new local invocation that failed before reserve/transport; it does not attest remote state.\n`;
export async function handleRemoteCancelCommand(
  args: string[],
  deps: RemoteCancelClientDependencies,
): Promise<number> {
  const out =
      deps.stdout ??
      ((text) => {
        process.stdout.write(text);
      }),
    err =
      deps.stderr ??
      ((text) => {
        process.stderr.write(text);
      });
  if (
    (args.length === 1 && args[0] === "--help") ||
    (args.length === 2 && ["cancel", "query"].includes(args[0]!) && args[1] === "--help")
  ) {
    out(REMOTE_CANCEL_HELP);
    return 0;
  }
  let child: ChildProcessWithoutNullStreams | undefined,
    channel: RemoteChannel | undefined,
    dir: string | undefined,
    timer: NodeJS.Timeout | undefined;
  let unknown: Record<string, unknown> | undefined;
  try {
    if (
      !["cancel", "query"].includes(args[0]!) ||
      args.length !== 9 ||
      args.some((a) => Buffer.byteLength(a) > 4096)
    )
      throw Error();
    const flags = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!,
        value = args[i + 1];
      if (!["--registry", "--sha256", "--alias", "--grant"].includes(key) || flags.has(key) || !value)
        throw Error();
      flags.set(key, value);
    }
    const registry = RemoteClientRegistry.parse(
      await readPinnedRemoteRegistry(flags.get("--registry") ?? "", flags.get("--sha256") ?? ""),
    );
    const entry = registry.homes.find((e) => e.alias === flags.get("--alias"));
    if (!entry) throw Error();
    const grant = SignedRemoteCancelGrant.parse(
        JSON.parse((await readPrivateDeliveryFile(flags.get("--grant") ?? "", 32768)).toString("utf8")),
      ),
      b = grant.body,
      digest = remoteCancelDigest(grant);
    if (
      b.home_id !== entry.home_id ||
      b.server_registry_sha256 !== entry.registry_sha256 ||
      b.scope_alias !== entry.scope
    )
      throw Error();
    const journal = await initializeRemoteJournal(deps.home),
      recordPath = join(journal, `${b.request_id}.local.json`);
    const record = {
      alias: entry.alias,
      endpoint_sha256: remoteCancelDigest(entry),
      request_sha256: digest,
      grant,
    };
    const previous = await readRemoteJournal(recordPath);
    if (previous && deliveryCanonical(previous) !== deliveryCanonical(record)) throw Error();
    let action = args[0] as "cancel" | "query";
    unknown = {
      schema_version: 1,
      mode: "remote_graph_cancel",
      alias: entry.alias,
      request_id: b.request_id,
      request_sha256: digest,
      outcome: previous || action === "query" ? "delivery_unknown" : "not_sent",
      physical_stop: "not_attested",
      qualification: "remote_host_pending",
    };
    await assertPrivateRemoteFile(entry.identity_file);
    const { createScratchDir } = await import("@osstack/core");
    dir = await createScratchDir("runtime", "remote-cancel");
    const known = join(dir, "known_hosts");
    await writeFile(
      known,
      `${entry.port === 22 ? entry.host : `[${entry.host}]:${entry.port}`} ${entry.host_key}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const sshArgs = buildRemoteControlSshArgs(entry, known);
    // Local preparation cannot consume a one-shot request. From reserve onward,
    // every failure remains unknown, including an uncertain journal write or spawn.
    unknown.outcome = "delivery_unknown";
    if (action === "cancel") {
      if (previous) action = "query";
      else if (!(await writeRemoteJournal(recordPath, record))) {
        if (deliveryCanonical(await readRemoteJournal(recordPath)) !== deliveryCanonical(record))
          throw Error();
        action = "query";
      }
    }
    child = (deps.spawn ?? spawn)("/usr/bin/ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }) as ChildProcessWithoutNullStreams;
    channel = new RemoteChannel(child.stdout, child.stdin);
    let stderrBytes = 0;
    child.stderr.on("error", () => {
      child?.stdin.destroy();
      child?.stdout.destroy();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 8192) child?.kill("SIGKILL");
    });
    child.on("error", () => {
      child?.stdin.destroy();
      child?.stdout.destroy();
    });
    const active = channel,
      nonce = randomBytes(32).toString("hex"),
      timeout = Math.max(1, Math.min(10000, deps.timeoutMs ?? 10000));
    const exchange = async () => {
      await active.send({
        type: "control_hello",
        protocol: 1,
        nonce,
        home_id: entry.home_id,
        registry_sha256: entry.registry_sha256,
      });
      const handshake = RemoteCancelHandshake.parse(await active.receive(timeout));
      if (
        handshake.nonce !== nonce ||
        handshake.home_id !== entry.home_id ||
        handshake.registry_sha256 !== entry.registry_sha256
      )
        throw Error();
      await active.send({ type: action, token: handshake.token, grant });
      const receipt = RemoteCancelReceipt.parse(await active.receive(timeout));
      if (
        receipt.nonce !== nonce ||
        receipt.home_id !== b.home_id ||
        receipt.request_id !== b.request_id ||
        receipt.request_sha256 !== digest ||
        receipt.daemon_generation !== b.daemon_generation ||
        receipt.graph_generation !== b.graph_generation ||
        receipt.graph_run_id !== b.graph_run_id ||
        (receipt.outcome === "stop_requested" &&
          (receipt.observed_revision === null || receipt.observed_revision <= b.expected_revision))
      )
        throw Error();
      await writeRemoteJournal(
        join(journal, `${b.request_id}.observed-${remoteCancelDigest({ ...receipt, nonce: "" })}.json`),
        receipt,
      );
      return receipt;
    };
    const receipt = await Promise.race([
      exchange(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("remote_cancel_timeout")), timeout);
      }),
    ]);
    out(`${JSON.stringify({ ...unknown, outcome: receipt.outcome, receipt })}\n`);
    return receipt.outcome === "stop_requested" ? 0 : 1;
  } catch {
    if (unknown) out(`${JSON.stringify(unknown)}\n`);
    else err("invalid_remote_cancel_request\n");
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
    channel?.close();
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
