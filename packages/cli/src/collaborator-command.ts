import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ContinuationGrantBody, ContinuationGrantStep, SignedContinuationGrant } from "@osstack/protocol";
import { canonicalContinuationGrantBody } from "@osstack/autonomy";
import type { SessionCommandDeps, SessionCommandRpcResponse } from "./session-command.js";

async function jsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  if (text.length > 1_000_000) throw new Error("grant input exceeds 1 MB");
  return JSON.parse(text) as unknown;
}

export async function handleCollaboratorCommand(args: string[], deps: SessionCommandDeps): Promise<number> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    out(`osstack collaborator — finite signed continuation for controlled planning/review sessions

  inspect <session_id> [--json]
  draft <session_id> --steps <steps.json> --out <grant.json> [--ttl-seconds <n>]
  sign --file <grant.json> --key-id <id> --private-key <owner.pem> --out <signed.json>
  install --file <signed.json> [--json]
  status <grant_id> [--json]
  revoke <grant_id> [--json]

Start with: osstack session start --agent claude-controlled-session ...
Trust: <OSSTACK_HOME>/continuation-trust.json (schema_version=1, keys[{key_id,public_key_pem}]).
Only public keys go in the daemon. Keep the signing key outside its runtime home.
Each frozen step checks the current output before sending its instruction.
Completion means delegated instructions are exhausted, not that the whole project is complete.
`);
    return 0;
  }
  try {
    const flags: Record<string, string> = {};
    let identifier: string | undefined;
    const allowed = new Set(sub === "draft" ? ["steps", "out", "ttl-seconds"] : sub === "sign"
      ? ["file", "key-id", "private-key", "out"] : sub === "install" ? ["file"] : []);
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--json") continue;
      if (arg.startsWith("--")) {
        const key = arg.slice(2);
        const value = args[++i];
        if (!allowed.has(key) || flags[key] !== undefined || value === undefined || value.startsWith("--")) throw new Error(`invalid argument ${arg}`);
        flags[key] = value;
      } else if (identifier === undefined && ["inspect", "draft", "status", "revoke"].includes(sub)) identifier = arg;
      else throw new Error(`unexpected argument ${arg}`);
    }
    const required = (key: string): string => {
      if (flags[key] === undefined) throw new Error(`--${key} is required`);
      return flags[key];
    };
    const rpc = async (method: string, params: unknown): Promise<unknown> => {
      const response = await deps.rpc(method, params, 10_000) as SessionCommandRpcResponse;
      if (!response.ok) throw new Error(response.error?.message ?? `${method} failed`);
      return response.result;
    };
    let result: unknown;
    if (sub === "inspect" || sub === "status" || sub === "revoke" || sub === "draft") {
      if (identifier === undefined) throw new Error(`${sub} requires an identifier`);
      result = await rpc(`collaborator.${sub === "draft" ? "inspect" : sub}`, sub === "inspect" || sub === "draft" ? { session_id: identifier } : { grant_id: identifier });
      if (sub === "draft") {
        const snapshot = result as { session_id: string; runtime_id: string; repo_path: string; turn_id: string; version: number; runtime_policy: { fingerprint: string } };
        const steps = ContinuationGrantStep.array().min(1).max(16).parse(await jsonFile(required("steps")));
        const ttl = Number(flags["ttl-seconds"] ?? 3600);
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error("ttl-seconds must be between 1 and 86400");
        const resumes = steps.reduce((sum, step) => sum + 1 + step.max_retries, 0);
        const now = Date.now();
        const body = ContinuationGrantBody.parse({
          version: 1, grant_id: `grant_${randomUUID()}`, session_id: snapshot.session_id,
          runtime_id: snapshot.runtime_id, runtime_policy_sha256: snapshot.runtime_policy.fingerprint,
          repo_path: snapshot.repo_path, initial_turn_id: snapshot.turn_id, initial_version: snapshot.version,
          issued_at: new Date(now).toISOString(), expires_at: new Date(now + ttl * 1000).toISOString(),
          max_resumes: Math.min(32, resumes), max_checks: Math.min(64, resumes), turn_timeout_ms: 120_000, steps,
        });
        await writeFile(required("out"), JSON.stringify(body, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        result = { state: "draft", path: required("out"), grant_id: body.grant_id };
      }
    } else if (sub === "sign") {
      const body = ContinuationGrantBody.parse(await jsonFile(required("file")));
      const key = createPrivateKey(await readFile(required("private-key"), "utf8"));
      if (key.asymmetricKeyType !== "ed25519") throw new Error("owner key must be Ed25519");
      const signed = SignedContinuationGrant.parse({ body, key_id: required("key-id"), signature: sign(null, Buffer.from(canonicalContinuationGrantBody(body)), key).toString("base64") });
      await writeFile(required("out"), JSON.stringify(signed, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      result = { state: "signed", path: required("out"), grant_id: body.grant_id };
    } else if (sub === "install") result = await rpc("collaborator.install", SignedContinuationGrant.parse(await jsonFile(required("file"))));
    else throw new Error(`unknown collaborator subcommand ${sub}`);
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    err("osstack collaborator:", error instanceof Error ? error.message : "command failed");
    return 1;
  }
}
