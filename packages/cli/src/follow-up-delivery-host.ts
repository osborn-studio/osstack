import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { FollowUpDeliveryTarget } from "@osstack/protocol";
import type { FollowUpDeliveryOptions, FollowUpDeliveryTrust } from "@osstack/core";
import { deliveryCanonical } from "@osstack/core";
import { createGithubDeliveryTransport } from "./follow-up-github-transport.js";
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const baseName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
  .refine((value) => value !== "." && value !== "..");
export const HostDeliveryConfig = z
  .object({
    schema_version: z.literal(1),
    enabled: z.boolean(),
    qualification: z.enum(["sandbox_qualified", "production_qualified"]),
    qualification_note: z.string().min(10).max(1024),
    targets: z.array(FollowUpDeliveryTarget).min(1).max(32),
    accounts: z
      .array(z.object({ account_id: ref, token_file: baseName }).strict())
      .min(1)
      .max(8),
    keys: z
      .array(
        z
          .object({
            key_id: ref,
            public_key_pem: z.string().min(1).max(4096),
            repo_path: z.string().max(4096),
            destination_refs: z.array(ref).min(1).max(32),
            max_validity_ms: z.number().int().min(1000).max(300000),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type HostDeliveryConfig = z.infer<typeof HostDeliveryConfig>;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
/** Ancestors cannot let another uid replace the private home. Sticky root-owned tmp is allowed. */
function privateAncestors(path: string): void {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw Error("delivery_host_config_invalid");
  for (let current = dirname(path); ; current = dirname(current)) {
    const entry = lstatSync(current);
    const privateParent = current === dirname(path);
    const stickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (entry.uid !== 0 && entry.uid !== uid) ||
      (privateParent
        ? entry.uid !== uid || (entry.mode & 0o077) !== 0
        : (entry.mode & 0o022) !== 0 && !stickyRoot)
    )
      throw Error("delivery_host_config_invalid");
    if (dirname(current) === current) break;
  }
}
/** Bounded synchronous fence needed immediately before a grant is persisted or consumed. */
function assertRegistryFingerprint(path: string, fingerprint: string): void {
  privateAncestors(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd),
      bytes = Buffer.alloc(131073);
    let length = 0;
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      before.size > 131072
    )
      throw Error("delivery_host_config_invalid");
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd),
      current = lstatSync(path);
    if (
      length > 131072 ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.ctimeMs !== before.ctimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      hash(bytes.subarray(0, length)) !== fingerprint
    )
      throw Error("delivery_host_config_changed");
    privateAncestors(path);
  } finally {
    closeSync(fd);
  }
}
/** Host private files: canonical directory, same uid, no symlinks, strict modes, finite reads and identity checks. */
export async function readPrivateDeliveryFile(path: string, maximum = 131072): Promise<Buffer> {
  privateAncestors(path);
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(dirname(path))) !== dirname(path))
    throw Error("delivery_host_config_invalid");
  const directory = await lstat(dirname(path));
  if (
    !directory.isDirectory() ||
    typeof process.getuid !== "function" ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o077) !== 0
  )
    throw Error("delivery_host_config_invalid");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      before.size > maximum
    )
      throw Error("delivery_host_config_invalid");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat(),
      current = await lstat(path);
    if (
      length > maximum ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.ctimeMs !== current.ctimeMs ||
      before.mtimeMs !== current.mtimeMs ||
      before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      (await realpath(dirname(path))) !== dirname(path)
    )
      throw Error("delivery_host_config_changed");
    privateAncestors(path);
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}
export async function readHostDeliveryConfig(configPath: string): Promise<{
  config: HostDeliveryConfig;
  fingerprint: string;
  keys: Map<string, KeyObject>;
}> {
  const raw = await readPrivateDeliveryFile(configPath);
  const config = HostDeliveryConfig.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  for (const array of [
    config.targets.map((t) => t.destination_ref),
    config.accounts.map((a) => a.account_id),
    config.keys.map((k) => k.key_id),
  ])
    if (new Set(array).size !== array.length) throw Error("delivery_host_config_invalid");
  const keys = new Map<string, KeyObject>();
  for (const target of config.targets) {
    if (
      (await realpath(target.repo_path)) !== target.repo_path ||
      inside(target.repo_path, configPath) ||
      !config.accounts.some((a) => a.account_id === target.account_id)
    )
      throw Error("delivery_host_config_invalid");
  }
  for (const key of config.keys) {
    if (
      (await realpath(key.repo_path)) !== key.repo_path ||
      key.destination_refs.some(
        (ref) => !config.targets.some((t) => t.destination_ref === ref && t.repo_path === key.repo_path),
      )
    )
      throw Error("delivery_host_config_invalid");
    if (!key.public_key_pem.startsWith("-----BEGIN PUBLIC KEY-----"))
      throw Error("delivery_host_config_invalid");
    const publicKey = createPublicKey(key.public_key_pem);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
      throw Error("delivery_host_config_invalid");
    keys.set(key.key_id, publicKey);
  }
  return { config, fingerprint: hash(raw), keys };
}
export type HostFollowUpDelivery =
  | { state: "ready"; options: FollowUpDeliveryOptions; fingerprint: string }
  | { state: "disabled" | "invalid"; options: FollowUpDeliveryOptions };
/** Call only with the daemon's fixed OSSTACK_HOME/follow-up-delivery.json, never a repository/RPC path. */
export async function loadHostFollowUpDelivery(configPath: string): Promise<HostFollowUpDelivery> {
  try {
    const loaded = await readHostDeliveryConfig(configPath),
      { config, keys } = loaded;
    if (!config.enabled) return { state: "disabled", options: {} };
    const targets = new Map(config.targets.map((t) => [t.destination_ref, t]));
    const trustedKeys = new Map<string, FollowUpDeliveryTrust>(
      config.keys.map((k) => [
        k.key_id,
        {
          publicKey: keys.get(k.key_id)!,
          purpose: "follow_up_delivery",
          repo_path: k.repo_path,
          provider_id: "github_comment",
          destination_refs: k.destination_refs,
          max_validity_ms: k.max_validity_ms,
        },
      ]),
    );
    const credentialFingerprints = new Map<string, { path: string; fingerprint: string; token: string }>();
    const transport = createGithubDeliveryTransport({
      qualification: config.qualification,
      assertCredential: (envelope, token) => {
        assertRegistryFingerprint(configPath, loaded.fingerprint);
        const entry = credentialFingerprints.get(envelope.destination.account_id);
        if (!entry || entry.token !== token) throw Error("delivery_host_account_unavailable");
        assertRegistryFingerprint(entry.path, entry.fingerprint);
      },
      credential: async (envelope) => {
        const current = await readHostDeliveryConfig(configPath);
        if (
          !current.config.enabled ||
          current.fingerprint !== loaded.fingerprint ||
          deliveryCanonical(targets.get(envelope.destination.destination_ref)) !==
            deliveryCanonical(envelope.destination)
        )
          throw Error("delivery_host_config_changed");
        const account = config.accounts.find((a) => a.account_id === envelope.destination.account_id);
        if (!account) throw Error("delivery_host_account_unavailable");
        const raw = await readPrivateDeliveryFile(join(dirname(configPath), account.token_file), 4097);
        const token = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
        if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw Error("delivery_host_account_unavailable");
        credentialFingerprints.set(account.account_id, {
          path: join(dirname(configPath), account.token_file),
          fingerprint: hash(raw),
          token,
        });
        return token;
      },
    });
    return {
      state: "ready",
      fingerprint: loaded.fingerprint,
      options: {
        assertHostConfiguration: () => assertRegistryFingerprint(configPath, loaded.fingerprint),
        targets,
        trustedKeys,
        transports: new Map([["github_comment", transport]]),
      },
    };
  } catch (error) {
    return {
      state: error instanceof Error && "code" in error && error.code === "ENOENT" ? "disabled" : "invalid",
      options: {},
    };
  }
}
