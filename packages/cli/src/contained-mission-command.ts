import { resolve } from "node:path";
import { ContainedMissionRpcRequests } from "./contained-mission-rpc.js";

const HELP = `Usage: osstack mission <command> [flags] [--json]
Contained single-executor Missions: Codex proposes a patch read-only, the host classifies,
applies and commits it, verifies in a no-network container, and stops at publication_pending.
  start --scope ID --repo PATH --base REF --goal TEXT --allow GLOB [--allow GLOB...]
        --verify-arg ARG [--verify-arg ARG...] [--max-repair N] [--supersedes MISSION]
        [--publish-repository OWNER/NAME [--publish-remote origin] [--publish-base REF]
         [--publish-draft true|false] [--publish-title TEXT] [--publish-preauthorized]]
  status --mission ID
  cancel --mission ID
  decide --mission ID --decision abandon|extra_repair|approve_publication|discard_changes|adopt_worktree|retry_stop_check
Host setup: OSSTACK_CONTAINED_MISSIONS=1 with OSSTACK_ENGINEERING=1 and OSSTACK_ATTENTION=1, plus
OSSTACK_CONTAINED_CODEX_BIN, OSSTACK_CONTAINED_CODEX_HOME and the OSSTACK_CONTAINED_DOCKER_* settings.
The host assigns identity and rights through OSSTACK_ENGINEERING_CREDENTIAL. No daemon starts automatically.
Publication is a separate bounded grant: one PR on the named repository and base, opened after the
candidate's own verification passed and approve_publication (or --publish-preauthorized). Nothing is merged.`;

type Command = "start" | "status" | "cancel" | "decide";
const flagsByCommand: Record<Command, { single: readonly string[]; repeated: readonly string[] }> = {
  start: { single: ["scope", "repo", "base", "goal", "max-repair", "supersedes", "publish-repository", "publish-remote", "publish-base", "publish-draft", "publish-title"], repeated: ["allow", "verify-arg"] },
  status: { single: ["mission"], repeated: [] },
  cancel: { single: ["mission"], repeated: [] },
  decide: { single: ["mission", "decision"], repeated: [] },
};

export interface ContainedMissionCommandDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  rpc?: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  readCredential?: () => string;
  cwd?: string;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\p{Cf}]/gu, (char) =>
    char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

export async function handleContainedMissionCommand(args: string[], deps: ContainedMissionCommandDeps = {}): Promise<number> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  let credential = "";
  if (args.length === 0 || ["help", "--help", "-h"].includes(args[0]!)) { out(HELP); return 0; }
  try {
    const command = args[0]! as Command;
    if (!Object.hasOwn(flagsByCommand, command)) throw new Error("unknown_mission_command");
    const single = new Map<string, string>(); const repeated = new Map<string, string[]>();
    let json = false; let preauthorized = false;
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--help" || arg === "-h") { out(HELP); return 0; }
      if (!arg.startsWith("--")) throw new Error(`unexpected_argument:${arg}`);
      const key = arg.slice(2);
      if (key === "json") { if (json) throw new Error("duplicate_flag:--json"); json = true; continue; }
      if (key === "publish-preauthorized" && command === "start") { if (preauthorized) throw new Error("duplicate_flag:--publish-preauthorized"); preauthorized = true; continue; }
      const value = args[++i];
      if (value === undefined || value.includes("\0")) throw new Error(`missing_value:--${key}`);
      if (flagsByCommand[command].repeated.includes(key)) { repeated.set(key, [...(repeated.get(key) ?? []), value]); continue; }
      if (!flagsByCommand[command].single.includes(key)) throw new Error(`unknown_flag:--${key}`);
      if (single.has(key)) throw new Error(`duplicate_flag:--${key}`);
      if (value.startsWith("--")) throw new Error(`missing_value:--${key}`);
      single.set(key, value);
    }
    const required = (key: string): string => { const v = single.get(key); if (!v) throw new Error(`required:--${key}`); return v; };
    let params: Record<string, unknown>;
    if (command === "start") {
      const argv = repeated.get("verify-arg") ?? []; const allow = repeated.get("allow") ?? [];
      if (argv.length === 0) throw new Error("required:--verify-arg");
      if (allow.length === 0) throw new Error("required:--allow");
      params = { scope_id: required("scope"), ...(single.has("supersedes") ? { supersedes: required("supersedes") } : {}),
        request: { goal: required("goal"), repo_path: resolve(deps.cwd ?? process.cwd(), required("repo")), base_ref: required("base"), allowed_paths: allow,
          verify: { argv }, ...(single.has("max-repair") ? { max_repair_cycles: Number(required("max-repair")) } : {}),
          ...(single.has("publish-repository") ? { publication: { repository: required("publish-repository"), remote: single.get("publish-remote") ?? "origin",
            base: single.get("publish-base") ?? required("base"), draft: (single.get("publish-draft") ?? "true") !== "false",
            ...(single.has("publish-title") ? { title: required("publish-title") } : {}), ...(preauthorized ? { preauthorized: true } : {}) } } : {}) } };
      if (single.has("publish-draft") && !["true", "false"].includes(required("publish-draft"))) throw new Error("invalid:--publish-draft");
      if (!single.has("publish-repository") && [...single.keys(), ...(preauthorized ? ["publish-preauthorized"] : [])].some(k => k.startsWith("publish-"))) throw new Error("required:--publish-repository");
    } else if (command === "decide") {
      params = { mission_id: required("mission"), decision: required("decision") };
    } else {
      params = { mission_id: required("mission") };
    }
    const method = `mission.${command}` as const;
    // Validate locally before reading the credential, so a typo never needs the secret.
    const probe = ContainedMissionRpcRequests[method].safeParse({ ...params, credential: "x".repeat(32) });
    if (!probe.success) throw new Error(`invalid_request:${probe.error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",")}`);
    if (!deps.rpc) throw new Error("daemon_connection_required");
    credential = deps.readCredential ? deps.readCredential() : (await import("./engineering-access.js")).readEngineeringCredential();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject bearer transport control bytes before RPC.
    if (credential.length < 32 || credential.length > 4096 || /[\u0000\r\n]/u.test(credential)) throw new Error("engineering_credential_required");
    const response = await deps.rpc(method, { ...params, credential }, 120000) as { ok?: boolean; result?: unknown; error?: { code?: unknown } };
    if (response?.ok !== true) throw new Error(typeof response?.error?.code === "string" ? response.error.code : "mission_request_failed");
    const text = safeJson(response.result ?? null).split(credential).join("[REDACTED]");
    out(json ? text : `Mission · ${command}\n${text}\nThe daemon advances the Mission on its own tick. Nothing is merged or published by this command.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(`osstack mission: ${safeJson(credential ? message.split(credential).join("[REDACTED]") : message)}`);
    return 1;
  }
}
