import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { GraphScope } from "@osstack/protocol";
import { deliveryCanonical } from "@osstack/core";
import { readPrivateDeliveryFile } from "./follow-up-delivery-host.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.string().uuid(),
  ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const RemoteCancelGrantBody = z
  .object({
    domain: z.literal("osstack.remote-graph-cancel.v1"),
    grant_id: id,
    request_id: id,
    actor_id: ref,
    home_id: z.string().regex(/^home_[a-f0-9]{32}$/),
    daemon_generation: z.string().regex(/^instance_[a-f0-9]{32}$/),
    server_registry_sha256: digest,
    scope_alias: ref,
    repo_path: z.string().min(1).max(4096),
    graph_scope: GraphScope,
    action: z.literal("graph.cancel"),
    graph_run_id: ref,
    graph_generation: z.number().int().safe().nonnegative(),
    expected_revision: z.number().int().safe().nonnegative(),
    nonce: digest,
    issued_at_ms: z.number().int().safe().nonnegative(),
    expires_at_ms: z.number().int().safe().nonnegative(),
    max_calls: z.literal(1),
  })
  .strict()
  .refine((v) => v.expires_at_ms > v.issued_at_ms && v.expires_at_ms - v.issued_at_ms <= 300000);
export const SignedRemoteCancelGrant = z
  .object({
    body: RemoteCancelGrantBody,
    key_id: ref,
    signature: z.string().regex(/^[A-Za-z0-9+/]{85}[AQgw]==$/),
  })
  .strict();
export type SignedRemoteCancelGrant = z.infer<typeof SignedRemoteCancelGrant>;
export const RemoteCancelServerRegistry = z
  .object({
    version: z.literal(1),
    home_id: z.string().regex(/^home_[a-f0-9]{32}$/),
    daemon_protocol: z.number().int().positive(),
    socket: z.string().max(4096),
    journal_dir: z.string().max(4096),
    scopes: z
      .array(z.object({ alias: ref, repo_path: z.string().max(4096), graph_scope: GraphScope }).strict())
      .min(1)
      .max(16),
    keys: z
      .array(
        z
          .object({
            key_id: ref,
            public_key_pem: z.string().max(4096),
            actor_id: ref,
            scope_aliases: z.array(ref).min(1).max(16),
            max_validity_ms: z.number().int().min(1000).max(300000),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.scopes.map((s) => s.alias)).size === v.scopes.length &&
      new Set(v.keys.map((k) => k.key_id)).size === v.keys.length,
  );
export type RemoteCancelServerRegistry = z.infer<typeof RemoteCancelServerRegistry>;
export const RemoteCancelHello = z
  .object({
    type: z.literal("control_hello"),
    protocol: z.literal(1),
    nonce: digest,
    home_id: z.string(),
    registry_sha256: digest,
  })
  .strict();
export const RemoteCancelHandshake = z
  .object({
    type: z.literal("control_grant"),
    protocol: z.literal(1),
    nonce: digest,
    home_id: z.string(),
    daemon_generation: z.string(),
    registry_sha256: digest,
    token: digest,
    methods: z.tuple([z.literal("cancel"), z.literal("query")]),
  })
  .strict();
export const RemoteCancelRequest = z
  .object({ type: z.enum(["cancel", "query"]), token: digest, grant: SignedRemoteCancelGrant })
  .strict();
export const RemoteCancelReceipt = z
  .object({
    type: z.literal("control_receipt"),
    protocol: z.literal(1),
    nonce: digest,
    home_id: z.string(),
    request_id: id,
    request_sha256: digest,
    daemon_generation: z.string(),
    graph_generation: z.number().int().safe().nonnegative(),
    graph_run_id: ref,
    outcome: z.enum(["not_found", "delivery_unknown", "stop_requested"]),
    physical_stop: z.literal("not_attested"),
    observed_revision: z.number().int().safe().nonnegative().nullable(),
  })
  .strict()
  .refine((v) => (v.outcome === "stop_requested") === (v.observed_revision !== null));
export type RemoteCancelReceipt = z.infer<typeof RemoteCancelReceipt>;
export const remoteCancelDigest = (value: unknown) =>
  createHash("sha256").update(deliveryCanonical(value)).digest("hex");
export function verifyRemoteCancelGrant(
  grant: SignedRemoteCancelGrant,
  registry: RemoteCancelServerRegistry,
  registryDigest: string,
  forWrite: boolean,
  now = Date.now(),
): void {
  const b = grant.body,
    key = registry.keys.find((k) => k.key_id === grant.key_id),
    scope = registry.scopes.find((s) => s.alias === b.scope_alias);
  if (
    !key ||
    !scope ||
    b.home_id !== registry.home_id ||
    b.server_registry_sha256 !== registryDigest ||
    b.actor_id !== key.actor_id ||
    !key.scope_aliases.includes(b.scope_alias) ||
    scope.repo_path !== b.repo_path ||
    deliveryCanonical(scope.graph_scope) !== deliveryCanonical(b.graph_scope) ||
    b.expires_at_ms - b.issued_at_ms > key.max_validity_ms ||
    !key.public_key_pem.startsWith("-----BEGIN PUBLIC KEY-----")
  )
    throw Error("remote_cancel_authorization_refused");
  const publicKey = createPublicKey(key.public_key_pem);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(deliveryCanonical(b)), publicKey, Buffer.from(grant.signature, "base64"))
  )
    throw Error("remote_cancel_authorization_refused");
  // Exact historical receipt query remains possible after expiry; it never replays an effect.
  if (forWrite && (!Number.isSafeInteger(now) || now < b.issued_at_ms || now >= b.expires_at_ms))
    throw Error("remote_cancel_grant_expired");
}
export async function assertRemoteJournal(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    throw Error("remote_cancel_journal_unavailable");
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw Error("remote_cancel_journal_unavailable");
  for (let p = dirname(path); ; p = dirname(p)) {
    const st = await lstat(p);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (st.uid !== 0 && st.uid !== process.getuid?.()) ||
      ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))
    )
      throw Error("remote_cancel_journal_unavailable");
    if (dirname(p) === p) break;
  }
}
export async function initializeRemoteJournal(home: string): Promise<string> {
  const dir = join(home, "remote-actions");
  await mkdir(dir, { mode: 0o700 }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  });
  await assertRemoteJournal(dir);
  return dir;
}
/** Create-only, file + directory fsync; a partial/crashed record is never overwritten or rearmed. */
export async function writeRemoteJournal(path: string, value: unknown): Promise<boolean> {
  await assertRemoteJournal(dirname(path));
  const entries = await opendir(dirname(path));
  let count = 0;
  try {
    for await (const _ of entries) {
      if (++count > 2048) throw Error("remote_cancel_journal_full");
    }
  } finally {
    await entries.close().catch(() => {});
  }
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 32768) throw Error("remote_cancel_journal_too_large");
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return true;
}
export async function readRemoteJournal(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateDeliveryFile(path, 32768)),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw Error("remote_cancel_journal_unavailable");
  }
}
