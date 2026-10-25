import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { FollowUpDeliveryResult, SignedFollowUpDeliveryGrant } from "@osstack/protocol";
import { deliveryCanonical, serializeFollowUpDelivery } from "@osstack/core";
import { githubDeliveryBody } from "./follow-up-github-transport.js";
import { readHostDeliveryConfig, readPrivateDeliveryFile } from "./follow-up-delivery-host.js";

export const FOLLOW_UP_DELIVERY_ISSUER_HELP = `follow-up-delivery issue-grant ID --repo PATH --default-tenant --revision N --key KEY --output FILE
Local operator only: requires interactive stdin/stderr, displays the exact public wire body and fixed target,
and requires typing APPROVE plus the entire preview digest. There is no --yes or RPC signer.
The host private config pins trust; issuer-KEY.pem must match its Ed25519 public key.
Creates a new private grant file; does not authorize or send. Same-uid hostile processes are outside this authority boundary.\n`;
export interface DeliveryIssuerDependencies {
  home: string;
  rpc(method: string, params: unknown): Promise<unknown>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Host test seam only, never CLI/RPC input. The real implementation requires a local interactive terminal. */
  confirm?: (preview: string, phrase: string) => Promise<boolean>;
}
async function terminalConfirm(preview: string, phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw Error("delivery_issuer_terminal_required");
  process.stderr.write(preview);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    return (
      (await terminal.question(`Type exactly ${phrase}\n> `, {
        signal: AbortSignal.timeout(60000),
      })) === phrase
    );
  } finally {
    terminal.close();
  }
}
export async function handleFollowUpDeliveryIssuerCommand(
  args: string[],
  deps: DeliveryIssuerDependencies,
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
  if ((args.length === 1 && args[0] === "--help") || (args.length === 2 && args[0] === "issue-grant" && args[1] === "--help")) {
    out(FOLLOW_UP_DELIVERY_ISSUER_HELP);
    return 0;
  }
  try {
    if (args[0] !== "issue-grant" || args.length > 14 || args.some((v) => Buffer.byteLength(v) > 4096))
      throw Error();
    const flags = new Map<string, string | true>();
    for (let i = 2; i < args.length; i++) {
      const flag = args[i]!;
      if (
        !["--repo", "--default-tenant", "--revision", "--key", "--output"].includes(flag) ||
        flags.has(flag)
      )
        throw Error();
      if (flag === "--default-tenant") flags.set(flag, true);
      else {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw Error();
        flags.set(flag, value);
      }
    }
    const repo = flags.get("--repo"),
      keyId = flags.get("--key"),
      output = flags.get("--output"),
      revision = flags.get("--revision");
    if (
      typeof repo !== "string" ||
      !isAbsolute(repo) ||
      typeof keyId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(keyId) ||
      typeof output !== "string" ||
      !isAbsolute(output) ||
      typeof revision !== "string" ||
      !/^[1-9][0-9]*$/.test(revision) ||
      flags.get("--default-tenant") !== true
    )
      throw Error();
    const canonicalRepo = await realpath(repo),
      configPath = join(deps.home, "follow-up-delivery.json"),
      loaded = await readHostDeliveryConfig(configPath);
    if (!loaded.config.enabled) throw Error();
    const params = {
      repo_path: canonicalRepo,
      default_tenant: true,
      attempt_id: args[1],
    };
    const inspect = async () =>
      FollowUpDeliveryResult.parse(await deps.rpc("follow-up-delivery.inspect", params)).attempt;
    const attempt = await inspect(),
      key = loaded.config.keys.find((k) => k.key_id === keyId);
    if (
      attempt.repo_path !== canonicalRepo ||
      attempt.attempt_id !== args[1] ||
      attempt.revision !== Number(revision) ||
      attempt.state !== "prepared" ||
      attempt.authorization_status !== "missing" ||
      !key ||
      key.repo_path !== canonicalRepo ||
      !key.destination_refs.includes(attempt.envelope.destination.destination_ref) ||
      deliveryCanonical(
        loaded.config.targets.find((t) => t.destination_ref === attempt.envelope.destination.destination_ref),
      ) !== deliveryCanonical(attempt.envelope.destination)
    )
      throw Error();
    const { envelope_digest: envelopeDigest, ...envelopePayload } = attempt.envelope;
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const subject = {
      domain: "osstack.follow-up-delivery.v1",
      repo_path: canonicalRepo,
      default_tenant: true,
      attempt_id: attempt.attempt_id,
      provider_id: attempt.envelope.destination.provider_id,
      account_id: attempt.envelope.destination.account_id,
      destination_digest: attempt.envelope.destination_digest,
      body_sha256: attempt.envelope.body_sha256,
      envelope_digest: envelopeDigest,
    };
    if (
      attempt.envelope.attempt_id !== attempt.attempt_id ||
      attempt.envelope.repo_path !== canonicalRepo ||
      hash(attempt.envelope.body) !== attempt.envelope.body_sha256 ||
      hash(deliveryCanonical(attempt.envelope.destination)) !== attempt.envelope.destination_digest ||
      hash(deliveryCanonical(envelopePayload)) !== envelopeDigest ||
      deliveryCanonical(subject) !== deliveryCanonical(attempt.authorization_subject)
    )
      throw Error();
    const preview = serializeFollowUpDelivery({
      action: "approve_one_public_github_comment",
      key_id: keyId,
      attempt_id: attempt.attempt_id,
      revision: attempt.revision,
      repo_path: canonicalRepo,
      target: attempt.envelope.destination,
      wire_body: githubDeliveryBody(attempt.envelope),
      authorization_subject: attempt.authorization_subject,
      max_calls: 1,
      valid_for_ms: key.max_validity_ms,
    });
    const digest = createHash("sha256").update(preview).digest("hex");
    if (!(await (deps.confirm ?? terminalConfirm)(`${preview}\n`, `APPROVE ${digest}`))) throw Error();
    const fresh = await inspect(),
      current = await readHostDeliveryConfig(configPath);
    if (current.fingerprint !== loaded.fingerprint || deliveryCanonical(fresh) !== deliveryCanonical(attempt))
      throw Error();
    const privateKey = createPrivateKey(
      await readPrivateDeliveryFile(join(deps.home, `issuer-${keyId}.pem`), 8192),
    );
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .compare(loaded.keys.get(keyId)!.export({ type: "spki", format: "der" })) !== 0
    )
      throw Error();
    if ((await readHostDeliveryConfig(configPath)).fingerprint !== loaded.fingerprint) throw Error();
    const now = Date.now();
    const body = {
      ...attempt.authorization_subject,
      grant_id: randomUUID(),
      issued_at_ms: now,
      expires_at_ms: now + key.max_validity_ms,
      max_calls: 1 as const,
    };
    const grant = SignedFollowUpDeliveryGrant.parse({
      body,
      key_id: keyId,
      signature: sign(null, Buffer.from(deliveryCanonical(body)), privateKey).toString("base64"),
    });
    const directory = await lstat(dirname(output));
    if (
      (await realpath(dirname(output))) !== dirname(output) ||
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw Error();
    const file = await open(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(`${JSON.stringify(grant)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await open(dirname(output), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    out(
      `${serializeFollowUpDelivery({ outcome: "grant_created_not_authorized", attempt_id: attempt.attempt_id, preview_sha256: digest, expires_at_ms: body.expires_at_ms, output })}\n`,
    );
    return 0;
  } catch {
    err("delivery_issuer_refused\n");
    return 1;
  }
}
