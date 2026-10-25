import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  FollowUpDeliveryPrepareParams,
  FollowUpDeliveryListParams,
  FollowUpDeliveryInspectParams,
  FollowUpDeliveryActionParams,
  FollowUpDeliveryAuthorizeParams,
  FollowUpDeliveryRevokeParams,
  SignedFollowUpDeliveryGrant,
  FollowUpDeliveryResult,
  FollowUpDeliveryListResult,
} from "@osstack/protocol";
import { FOLLOW_UP_DELIVERY_ERRORS, serializeFollowUpDelivery } from "@osstack/core";
export const FOLLOW_UP_DELIVERY_HELP = `follow-up-delivery prepare --repo PATH --default-tenant --input FILE [--json]
follow-up-delivery list --repo PATH --default-tenant [--limit 1..50] [--after ID] [--json]
follow-up-delivery inspect ID --repo PATH --default-tenant [--json]
follow-up-delivery authorize ID --repo PATH --default-tenant --revision N --grant FILE [--json]
follow-up-delivery revoke ID --repo PATH --default-tenant --revision N --reason TEXT [--json]
follow-up-delivery dispatch|reconcile ID --repo PATH --default-tenant --revision N [--json]
GitHub delivery is disabled unless the host installs a private follow-up-delivery.json registry, credential, and trusted issuer key.
Absent transport stays qualification_pending and never consumes authorization.
Authorize imports a signed, host-trusted, exact-target/body/scope/single-attempt grant.
Local issue-grant requires a host-provisioned private issuer and interactive exact-preview approval; RPC callers cannot create authority.
Prepare input excludes repo_path/default_tenant. Unknown delivery never retries; reconcile only queries a registered provider.
JSON output preserves exact reviewable content. Dispatch/reconcile exit 0 only for production-qualified delivered evidence; fake and sandbox evidence exit 1.
Delivery does not resolve the independent local obligation.\n`;
export interface FollowUpDeliveryCommandDependencies {
  rpc(method: string, params: unknown): Promise<unknown>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
export async function handleFollowUpDeliveryCommand(
  args: string[],
  deps: FollowUpDeliveryCommandDependencies,
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
  if (!args.length || (args.length === 1 && ["help", "--help"].includes(args[0]!))) {
    out(FOLLOW_UP_DELIVERY_HELP);
    return 0;
  }
  const action = args[0];
  let params: unknown;
  try {
    if (
      args.length > 20 ||
      args.some((a) => Buffer.byteLength(a) > 4096) ||
      !["prepare", "list", "inspect", "authorize", "revoke", "dispatch", "reconcile"].includes(action!)
    )
      throw Error();
    const identity = action !== "prepare" && action !== "list",
      id = identity ? args[1] : undefined;
    const allowed = [
      "--repo",
      "--default-tenant",
      "--json",
      ...(action === "prepare"
        ? ["--input"]
        : action === "list"
          ? ["--limit", "--after"]
          : action === "inspect"
            ? []
            : action === "authorize"
              ? ["--revision", "--grant"]
              : action === "revoke"
                ? ["--revision", "--reason"]
                : ["--revision"]),
    ];
    const flags = new Map<string, string | true>();
    for (let i = identity ? 2 : 1; i < args.length; i++) {
      const key = args[i]!;
      if (!allowed.includes(key) || flags.has(key)) throw Error();
      if (key === "--default-tenant" || key === "--json") flags.set(key, true);
      else {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw Error();
        flags.set(key, value);
      }
    }
    const scope = { repo_path: flags.get("--repo"), default_tenant: flags.get("--default-tenant") };
    const number = (key: string) => {
      const value = flags.get(key);
      if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw Error();
      return Number(value);
    };
    const file = async (key: string) => {
      const path = flags.get(key);
      if (typeof path !== "string") throw Error();
      return readInput(path);
    };
    if (action === "prepare") {
      const body = FollowUpDeliveryPrepareParams.omit({ repo_path: true, default_tenant: true }).parse(
        await file("--input"),
      );
      params = FollowUpDeliveryPrepareParams.parse({ ...body, ...scope });
    } else if (action === "list")
      params = FollowUpDeliveryListParams.parse({
        ...scope,
        ...(flags.has("--limit") ? { limit: number("--limit") } : {}),
        ...(flags.has("--after") ? { after_id: flags.get("--after") } : {}),
      });
    else if (action === "inspect") params = FollowUpDeliveryInspectParams.parse({ ...scope, attempt_id: id });
    else {
      const base = { ...scope, attempt_id: id, expected_revision: number("--revision") };
      params =
        action === "authorize"
          ? FollowUpDeliveryAuthorizeParams.parse({
              ...base,
              grant: SignedFollowUpDeliveryGrant.parse(await file("--grant")),
            })
          : action === "revoke"
            ? FollowUpDeliveryRevokeParams.parse({ ...base, reason: flags.get("--reason") })
            : FollowUpDeliveryActionParams.parse(base);
    }
  } catch {
    err("invalid_delivery_request\n");
    return 1;
  }
  let raw: unknown;
  try {
    raw = await deps.rpc(`follow-up-delivery.${action}`, params);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    err(
      `${(FOLLOW_UP_DELIVERY_ERRORS as readonly string[]).includes(code) ? code : "delivery_request_failed"}\n`,
    );
    return 1;
  }
  try {
    if (Buffer.byteLength(serializeFollowUpDelivery(raw)) + 1 > 65536) throw Error();
    const result =
      action === "list" ? FollowUpDeliveryListResult.parse(raw) : FollowUpDeliveryResult.parse(raw);
    const text = `${serializeFollowUpDelivery(result)}\n`;
    if (Buffer.byteLength(text) > 65536) throw Error();
    out(text);
    return action === "dispatch" || action === "reconcile"
      ? "attempt" in result &&
        result.attempt.state === "delivered" &&
        result.attempt.qualification === "production_qualified"
        ? 0
        : 1
      : 0;
  } catch {
    err("invalid_delivery_response\n");
    return 1;
  }
}
async function readInput(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw Error();
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 65536) throw Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    await file.close();
  }
}
