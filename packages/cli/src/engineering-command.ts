import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  EngineeringAdoptRequest, EngineeringObserveRequest, EngineeringDecideRequest,
  EngineeringDeferRequest, EngineeringCancelRequest, EngineeringEndObservationRequest,
  EngineeringReconcileRequest,
} from "@osstack/protocol";

const HELP = `Usage: osstack engineering <command> [flags] [--json]
Session adoption pilot. Completion level: observed_turn (the reply turn, not code delivery).
  adopt --scope ID --task ID --run ID --session ID --goal TEXT --request ID
  observe --mission ID [--cursor N] [--limit 1..100]
  decide --observation FILE --wait ID --action ID (--choice ID | --text TEXT)
  defer --observation FILE --wait ID --request ID --revisit-at UTC_ISO --reason TEXT
  cancel --mission ID --revision N --request ID [--reason TEXT]
  end-observation --mission ID --revision N --request ID [--reason TEXT]
  reconcile --kind query_action --mission ID --action ID
  reconcile --kind dispose_wait --observation FILE --wait ID --request ID
    --disposition human_answered_out_of_band|no_longer_relevant --reason TEXT
Each command also accepts --input FILE instead of request flags (strict JSON, at most 1 MiB).
Save observe --json output to use --observation. Saved revisions remain exact; they are not refreshed.
Use the same action/request ID and unchanged input when retrying an uncertain request.
Host setup: OSSTACK_ENGINEERING=1 and OSSTACK_ATTENTION=1. No daemon starts automatically.
The host assigns identity and rights through OSSTACK_ENGINEERING_CREDENTIAL. No --actor flag.
Cancel requests a stop. End-observation does not stop the Worker or claim completion.
See docs/guides/engineering-session-adoption.md (中文) and engineering-session-adoption.en.md.`;

const requests = {
  adopt: EngineeringAdoptRequest,
  observe: EngineeringObserveRequest,
  decide: EngineeringDecideRequest,
  defer: EngineeringDeferRequest,
  cancel: EngineeringCancelRequest,
  "end-observation": EngineeringEndObservationRequest,
  reconcile: EngineeringReconcileRequest,
} as const;
type Command = keyof typeof requests;

export interface EngineeringCommandDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  rpc?: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  readCredential?: () => string;
  readInput?: (path: string) => Promise<unknown>;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\p{Cf}]/gu, (char) =>
    char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  return value as Record<string, unknown>;
}
async function readBoundedJson(path: string): Promise<unknown> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const limit = 1024 * 1024;
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("input_file_must_be_regular_and_at_most_1MiB");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error("input_file_exceeds_1MiB");
    return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
  } finally { closeSync(fd); }
}

const flagsByCommand: Record<Command, readonly string[]> = {
  adopt: ["scope", "task", "run", "session", "goal", "request"],
  observe: ["mission", "cursor", "limit"],
  decide: ["observation", "wait", "action", "choice", "text"],
  defer: ["observation", "wait", "request", "revisit-at", "reason"],
  cancel: ["mission", "revision", "request", "reason"],
  "end-observation": ["mission", "revision", "request", "reason"],
  reconcile: ["kind", "mission", "action", "observation", "wait", "request", "disposition", "reason"],
};

export async function handleEngineeringCommand(args: string[], deps: EngineeringCommandDeps = {}): Promise<number> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  let credential = "";
  if (args.length === 0 || ["help", "--help", "-h"].includes(args[0]!)) {
    out(HELP);
    return 0;
  }
  try {
    const commandName = args[0]!;
    if (!Object.hasOwn(requests, commandName)) throw new Error("unknown_engineering_command");
    const command = commandName as Command;
    const flags = new Map<string, string>();
    let json = false;
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--help" || arg === "-h") { out(HELP); return 0; }
      if (!arg.startsWith("--")) throw new Error(`unexpected_argument:${arg}`);
      const key = arg.slice(2);
      if (flags.has(key) || (key === "json" && json)) throw new Error(`duplicate_flag:--${key}`);
      if (key === "json") { json = true; continue; }
      if (key !== "input" && !flagsByCommand[command].includes(key)) throw new Error(`unknown_flag:--${key}`);
      const value = args[++i];
      if (value === undefined || value.startsWith("--") || value.includes("\0")) throw new Error(`missing_value:--${key}`);
      flags.set(key, value);
    }
    const required = (key: string): string => {
      const value = flags.get(key);
      if (value === undefined || value.length === 0) throw new Error(`required:--${key}`);
      return value;
    };
    const readInput = deps.readInput ?? readBoundedJson;
    let input: unknown;
    if (flags.has("input")) {
      if (flags.size !== 1) throw new Error("input_cannot_be_combined_with_request_flags");
      input = await readInput(required("input"));
    } else if (command === "adopt") {
      input = { scope_id: required("scope"), task_id: required("task"), run_id: required("run"), session_id: required("session"), goal: required("goal"), request_id: required("request") };
    } else if (command === "observe") {
      input = { mission_id: required("mission"), ...(flags.has("cursor") ? { cursor: Number(required("cursor")) } : {}), ...(flags.has("limit") ? { limit: Number(required("limit")) } : {}) };
    } else if (command === "cancel" || command === "end-observation") {
      input = { mission_id: required("mission"), if_revision: Number(required("revision")), request_id: required("request"), ...(flags.has("reason") ? { reason: required("reason") } : {}) };
    } else if (command === "reconcile" && required("kind") === "query_action") {
      for (const key of flags.keys()) if (!["kind", "mission", "action"].includes(key)) throw new Error(`unexpected_query_action_flag:--${key}`);
      input = { kind: "query_action", mission_id: required("mission"), action_id: required("action") };
    } else {
      if (command === "reconcile") {
        if (required("kind") !== "dispose_wait") throw new Error("unknown_reconciliation_kind");
        if (flags.has("mission") || flags.has("action")) throw new Error("dispose_wait_requires_frozen_observation");
      }
      const view = object(await readInput(required("observation")), "observation");
      const mission = object(view["mission"], "observation_mission");
      if (!Array.isArray(view["waits"])) throw new Error("invalid_observation_waits");
      const matches = view["waits"].map((wait: unknown) => object(wait, "wait")).filter((wait: Record<string, unknown>) => wait["wait_id"] === required("wait"));
      if (matches.length !== 1) throw new Error("wait_not_unique_in_observation");
      const wait = matches[0]!;
      const common = { mission_id: mission["mission_id"], wait_id: wait["wait_id"], if_revision: mission["revision"] };
      if (command === "decide") {
        if (Number(flags.has("choice")) + Number(flags.has("text")) !== 1) throw new Error("exactly_one_of_choice_or_text_required");
        input = { ...common, decision_ref: wait["decision_ref"], action_id: required("action"), interaction_token: wait["interaction_token"], answer: flags.has("choice") ? { kind: "choice", choice_id: required("choice") } : { kind: "text", text: required("text") } };
      } else if (command === "defer") {
        input = { ...common, wait_revision: wait["revision"], request_id: required("request"), revisit_at: required("revisit-at"), reason: required("reason") };
      } else {
        input = { kind: "dispose_wait", ...common, wait_revision: wait["revision"], request_id: required("request"), observed_source_version: view["source_version"], observed_turn_id: view["turn_id"], observed_snapshot_digest: view["snapshot_digest"], disposition: required("disposition"), reason: required("reason") };
      }
    }
    const parsed = requests[command].safeParse(input);
    if (!parsed.success) throw new Error(`invalid_request:${parsed.error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",")}`);
    if (!deps.rpc) throw new Error("daemon_connection_required");
    credential = deps.readCredential ? deps.readCredential() : (await import("./engineering-access.js")).readEngineeringCredential();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject bearer transport control bytes before RPC.
    if (credential.length < 32 || credential.length > 4096 || /[\u0000\r\n]/u.test(credential)) throw new Error("engineering_credential_required");
    const method = command === "end-observation" ? "engineering.endObservation" : `engineering.${command}`;
    const response = object(await deps.rpc(method, { ...parsed.data, credential }, 120000), "daemon_response");
    if (response["ok"] !== true) {
      const error = object(response["error"] ?? {}, "daemon_error");
      throw new Error(typeof error["code"] === "string" ? error["code"] : "engineering_request_failed");
    }
    const text = safeJson(response["result"] ?? null).split(credential).join("[REDACTED]");
    out(json ? text : `Engineering · ${command}\n${text}\nobserved_turn confirms one reply turn. It does not prove code delivery. Stop requests remain unconfirmed until host evidence exists.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = credential ? message.split(credential).join("[REDACTED]") : message;
    err(`osstack engineering: ${safeJson(redacted)}`);
    return 1;
  }
}
