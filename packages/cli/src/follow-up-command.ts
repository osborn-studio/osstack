import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { FollowUpCreateParams, FollowUpListParams, FollowUpDraftParams, FollowUpResolveParams, FollowUpMutationResult, FollowUpListResult } from "@osstack/protocol";
import { FOLLOW_UP_ERROR_CODES, FOLLOW_UP_MAX_BYTES, serializeFollowUp } from "@osstack/core";

export const FOLLOW_UP_HELP = `follow-up list --repo PATH --default-tenant [--limit 1..50] [--state STATE] [--cursor TOKEN] [--json]
follow-up create --repo PATH --default-tenant --input FILE [--json]
follow-up draft ID --repo PATH --default-tenant --revision N --actor LABEL [--json]
follow-up resolve ID --repo PATH --default-tenant --revision N --actor LABEL --mode waive|condition --reason TEXT [--json]
Local obligation ledger only; external delivery is unsupported. Drafts are UNSENT and do not resolve obligations.
Create input excludes repo_path/default_tenant; select scope explicitly with flags. Actor is a label, not an authorization credential.\n`;
export interface FollowUpCommandDependencies { rpc(method: string, params: unknown): Promise<unknown>; stdout?: (text: string) => void; stderr?: (text: string) => void }
export async function handleFollowUpCommand(args: string[], dependencies: FollowUpCommandDependencies): Promise<number> {
  const out = dependencies.stdout ?? (text => { process.stdout.write(text); }); const err = dependencies.stderr ?? (text => { process.stderr.write(text); });
  if (args.length === 0 || (args.length === 1 && ["help", "--help"].includes(args[0]!))) { out(FOLLOW_UP_HELP); return 0; }
  const action = args[0]; let params: unknown; let json = false;
  try {
    if (args.length > 22 || args.some(arg => arg.length > 4096) || !["list", "create", "draft", "resolve"].includes(action!)) throw new Error();
    const identity = action === "draft" || action === "resolve"; const id = identity ? args[1] : undefined;
    const flags = new Map<string, string | true>();
    const allowed = ["--repo", "--default-tenant", "--json", ...(action === "list" ? ["--limit", "--cursor", "--state"] : action === "create" ? ["--input"] : action === "draft" ? ["--revision", "--actor"] : ["--revision", "--actor", "--mode", "--reason"])];
    for (let i = identity ? 2 : 1; i < args.length; i++) {
      const key = args[i]!; if (!allowed.includes(key) || flags.has(key)) throw new Error();
      if (key === "--default-tenant" || key === "--json") flags.set(key, true);
      else { const value = args[++i]; if (!value || allowed.includes(value)) throw new Error(); flags.set(key, value); }
    }
    json = flags.has("--json");
    const scope = { repo_path: flags.get("--repo"), default_tenant: flags.get("--default-tenant") };
    const number = (name: string) => { const value = flags.get(name); if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error(); return Number(value); };
    if (action === "list") params = FollowUpListParams.parse({ ...scope, ...(flags.has("--limit") ? { limit: number("--limit") } : {}), ...(flags.has("--cursor") ? { cursor: flags.get("--cursor") } : {}), ...(flags.has("--state") ? { state: flags.get("--state") } : {}) });
    else if (action === "create") {
      const path = flags.get("--input"); if (typeof path !== "string") throw new Error();
      const body = FollowUpCreateParams.omit({ repo_path: true, default_tenant: true }).parse(await readInput(path));
      params = FollowUpCreateParams.parse({ ...body, ...scope });
    } else {
      const base = { ...scope, obligation_id: id, expected_revision: number("--revision"), actor: flags.get("--actor") };
      params = action === "draft" ? FollowUpDraftParams.parse(base) : FollowUpResolveParams.parse({ ...base, mode: flags.get("--mode"), reason: flags.get("--reason") });
    }
  } catch { err("invalid_follow_up_request\n"); return 1; }
  let raw: unknown;
  try { raw = await dependencies.rpc(`follow-up.${action}`, params); }
  catch (error) { const code = error instanceof Error ? error.message : ""; err(`${(FOLLOW_UP_ERROR_CODES as readonly string[]).includes(code) ? code : "follow_up_request_failed"}\n`); return 1; }
  try {
    if (Buffer.byteLength(serializeFollowUp(raw)) + 1 > FOLLOW_UP_MAX_BYTES) throw new Error();
    const result = action === "list" ? FollowUpListResult.parse(raw) : FollowUpMutationResult.parse(raw);
    const text = json ? `${serializeFollowUp(result)}\n` : render(result);
    if (Buffer.byteLength(text) > FOLLOW_UP_MAX_BYTES) throw new Error(); out(text); return 0;
  } catch { err("invalid_follow_up_response\n"); return 1; }
}
async function readInput(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 16384) throw new Error();
    const bytes = Buffer.alloc(16385); let length = 0;
    while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > 16384) throw new Error(); return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { await file.close(); }
}
function render(result: FollowUpListResult | FollowUpMutationResult): string {
  const rows = "obligations" in result ? result.obligations : [result.obligation];
  const lines = ["Local obligations — external delivery unsupported; drafts are UNSENT."];
  if ("overdue_count" in result) lines.push(`Overdue: ${result.overdue_count}; page: ${rows.length}`);
  for (const row of rows) {
    lines.push(`${row.obligation_id} revision=${row.revision} state=${row.state}; source=${row.source_missing ? "source_missing" : row.source!.state}`);
    lines.push(`  promise=${serializeFollowUp("promise" in row ? row.promise : row.promise_preview)}`);
    if ("draft" in row && row.draft) lines.push(`  unsent_draft=${serializeFollowUp(row.draft.text)}`);
    if (row.state === "fulfilled_local") lines.push("  Local condition verified; no external delivery is claimed.");
  }
  if ("next_cursor" in result && result.next_cursor) lines.push(`next_cursor=${serializeFollowUp(result.next_cursor)}`);
  return `${lines.join("\n")}\n`;
}
