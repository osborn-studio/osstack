import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { join, dirname, isAbsolute, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { GraphScope } from "@osstack/protocol";
import { deliveryCanonical } from "@osstack/core";
import { readPrivateDeliveryFile } from "./follow-up-delivery-host.js";
import {
  RemoteCancelGrantBody,
  SignedRemoteCancelGrant,
  remoteCancelDigest,
  writeRemoteJournal,
  assertRemoteJournal,
} from "./remote-cancel-protocol.js";
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const RemoteCancelIssuerConfig = z
  .object({
    version: z.literal(1),
    enabled: z.literal(true),
    actor_id: ref,
    key_id: ref,
    public_key_pem: z.string().max(4096),
    max_validity_ms: z.number().int().min(1000).max(300000),
    targets: z
      .array(
        z
          .object({
            name: ref,
            home_id: z.string().regex(/^home_[a-f0-9]{32}$/),
            server_registry_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            scope_alias: ref,
            repo_path: z.string().min(1).max(4096),
            graph_scope: GraphScope,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .refine((v) => new Set(v.targets.map((t) => t.name)).size === v.targets.length);
export interface RemoteCancelIssuerDependencies {
  home: string;
  confirm?: (preview: string, phrase: string) => Promise<boolean>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
async function terminalConfirm(preview: string, phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw Error("remote_cancel_terminal_required");
  process.stderr.write(preview);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return (
      (await rl.question(`Type exactly ${phrase}\n> `, { signal: AbortSignal.timeout(60000) })) === phrase
    );
  } finally {
    rl.close();
  }
}
export const REMOTE_CANCEL_ISSUER_HELP = `remote-home issue-cancel-grant --target NAME --daemon-generation INSTANCE --graph-run ID --graph-generation N --revision N --output FILE
Requires host-private remote-cancel-issuer.json, issuer-KEY.pem, local interactive TTY and exact preview digest approval.
Creates only one bounded generation/revision-specific cancellation grant. Does not connect or cancel. No --yes or RPC signer.
`;
export async function handleRemoteCancelIssuerCommand(
  args: string[],
  deps: RemoteCancelIssuerDependencies,
): Promise<number> {
  const out =
      deps.stdout ??
      ((s) => {
        process.stdout.write(s);
      }),
    err =
      deps.stderr ??
      ((s) => {
        process.stderr.write(s);
      });
  if (
    (args.length === 1 && args[0] === "--help") ||
    (args.length === 2 && args[0] === "issue-cancel-grant" && args[1] === "--help")
  ) {
    out(REMOTE_CANCEL_ISSUER_HELP);
    return 0;
  }
  try {
    if (
      args[0] !== "issue-cancel-grant" ||
      args.length !== 13 ||
      args.some((a) => Buffer.byteLength(a) > 4096)
    )
      throw Error();
    const flags = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const k = args[i]!,
        v = args[i + 1];
      if (
        ![
          "--target",
          "--daemon-generation",
          "--graph-run",
          "--graph-generation",
          "--revision",
          "--output",
        ].includes(k) ||
        !v ||
        flags.has(k)
      )
        throw Error();
      flags.set(k, v);
    }
    const configPath = join(deps.home, "remote-cancel-issuer.json"),
      raw = await readPrivateDeliveryFile(configPath, 32768),
      config = RemoteCancelIssuerConfig.parse(JSON.parse(raw.toString("utf8")));
    const target = config.targets.find((t) => t.name === flags.get("--target")),
      output = flags.get("--output");
    if (!target || !output || !isAbsolute(output)) throw Error();
    const rel = relative(target.repo_path, configPath);
    if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
      throw Error("remote_cancel_issuer_in_repository");
    await assertRemoteJournal(dirname(output));
    const numeric = (key: string) => {
      const v = flags.get(key) ?? "";
      if (!/^(0|[1-9][0-9]*)$/.test(v)) throw Error();
      return Number(v);
    };
    const issued = Date.now();
    const body = RemoteCancelGrantBody.parse({
      domain: "osstack.remote-graph-cancel.v1",
      grant_id: randomUUID(),
      request_id: randomUUID(),
      actor_id: config.actor_id,
      home_id: target.home_id,
      daemon_generation: flags.get("--daemon-generation"),
      server_registry_sha256: target.server_registry_sha256,
      scope_alias: target.scope_alias,
      repo_path: target.repo_path,
      graph_scope: target.graph_scope,
      action: "graph.cancel",
      graph_run_id: flags.get("--graph-run"),
      graph_generation: numeric("--graph-generation"),
      expected_revision: numeric("--revision"),
      nonce: randomBytes(32).toString("hex"),
      issued_at_ms: issued,
      expires_at_ms: issued + config.max_validity_ms,
      max_calls: 1,
    });
    const preview = {
        action: "remote Graph cancellation",
        target: target.name,
        key_id: config.key_id,
        grant: body,
        physical_stop: "not_attested",
        retry: "never; query same request after uncertainty",
      },
      digest = remoteCancelDigest(preview);
    if (
      !(await (deps.confirm ?? terminalConfirm)(`${JSON.stringify(preview, null, 2)}\n`, `APPROVE ${digest}`))
    )
      throw Error();
    if (
      !raw.equals(await readPrivateDeliveryFile(configPath, 32768)) ||
      Date.now() >= body.expires_at_ms ||
      Date.now() < body.issued_at_ms
    )
      throw Error();
    const key = createPrivateKey(
      await readPrivateDeliveryFile(join(deps.home, `issuer-${config.key_id}.pem`), 4096),
    );
    if (!config.public_key_pem.startsWith("-----BEGIN PUBLIC KEY-----")) throw Error();
    const expected = createPublicKey(config.public_key_pem);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      expected.asymmetricKeyType !== "ed25519" ||
      !createPublicKey(key)
        .export({ format: "der", type: "spki" })
        .equals(expected.export({ format: "der", type: "spki" }))
    )
      throw Error();
    if (!raw.equals(await readPrivateDeliveryFile(configPath, 32768))) throw Error();
    const grant = SignedRemoteCancelGrant.parse({
      body,
      key_id: config.key_id,
      signature: sign(null, Buffer.from(deliveryCanonical(body)), key).toString("base64"),
    });
    if (!(await writeRemoteJournal(output, grant))) throw Error();
    out(
      `${JSON.stringify({ schema_version: 1, status: "grant_created", request_id: body.request_id, preview_sha256: digest, output })}\n`,
    );
    return 0;
  } catch {
    err("remote_cancel_issuer_refused\n");
    return 1;
  }
}
