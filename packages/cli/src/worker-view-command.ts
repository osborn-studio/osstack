import {
  WORKER_VIEW_ERROR_CODES, WORKER_VIEW_MAX_BYTES, serializeWorkerView,
  WorkerInspectParamsSchema, WorkerInspectResultSchema,
  WorkerListParamsSchema, WorkerListResultSchema,
  type WorkerViewInspectResult, type WorkerViewListResult,
} from "./worker-view-service.js";

export const WORKER_VIEW_HELP = `worker list --repo ABSOLUTE_PATH --default-tenant [--limit 1..50] [--cursor TOKEN] [--json]
worker inspect VIEW_ID --repo ABSOLUTE_PATH --default-tenant [--json]
Read-only Session and bound-run state views. Graph and log tails are not supported.
Views and cursors expire after 15 minutes or a daemon restart.\n`;

export interface WorkerViewCommandDependencies {
  /** Use the existing local daemon RPC client; never open a database here. */
  rpc: (method: string, params: unknown) => Promise<unknown>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function handleWorkerViewCommand(args: string[], dependencies: WorkerViewCommandDependencies): Promise<number> {
  const out = dependencies.stdout ?? (text => { process.stdout.write(text); });
  const err = dependencies.stderr ?? (text => { process.stderr.write(text); });
  if (args.length === 0 || (args.length === 1 && ["--help", "help"].includes(args[0]!))) {
    out(WORKER_VIEW_HELP); return 0;
  }
  let params: unknown;
  let json = false;
  const action = args[0];
  try {
    if (args.length > 12 || args.some(arg => arg.length > 4096) || !["list", "inspect"].includes(action!)) throw new Error();
    const flags = new Map<string, string | true>();
    const knownFlags = new Set(["--repo", "--limit", "--cursor", "--json", "--default-tenant", "--help"]);
    const viewId = action === "inspect" ? args[1] : undefined;
    // Base64url tokens can legitimately start with '--'. Reject actual option
    // names in value positions, not that valid random prefix.
    if (action === "inspect" && (!viewId || knownFlags.has(viewId))) throw new Error();
    for (let i = action === "inspect" ? 2 : 1; i < args.length; i++) {
      const flag = args[i]!;
      if (flags.has(flag)) throw new Error();
      if (["--json", "--default-tenant"].includes(flag)) { flags.set(flag, true); continue; }
      if (!(action === "list" ? ["--repo", "--limit", "--cursor"] : ["--repo"]).includes(flag)) throw new Error();
      const value = args[++i];
      if (!value || knownFlags.has(value)) throw new Error();
      flags.set(flag, value);
    }
    json = flags.has("--json");
    const limit = flags.get("--limit");
    if (limit !== undefined && (typeof limit !== "string" || !/^[1-9][0-9]*$/.test(limit))) throw new Error();
    const scope = { repo_path: flags.get("--repo"), default_tenant: flags.get("--default-tenant") };
    params = action === "list" ? WorkerListParamsSchema.parse({ ...scope,
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(flags.has("--cursor") ? { cursor: flags.get("--cursor") } : {}),
    }) : WorkerInspectParamsSchema.parse({ ...scope, view_id: viewId });
  } catch { err("invalid_request\n"); return 1; }

  let raw: unknown;
  try { raw = await dependencies.rpc(`worker.${action}`, params); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    err(`${(WORKER_VIEW_ERROR_CODES as readonly string[]).includes(message) ? message : "worker_request_failed"}\n`);
    return 1;
  }
  try {
    const serialized = serializeWorkerView(raw);
    if (!serialized || Buffer.byteLength(serialized) + 1 > WORKER_VIEW_MAX_BYTES) throw new Error();
    const response = action === "list" ? WorkerListResultSchema.parse(raw) : WorkerInspectResultSchema.parse(raw);
    const text = json ? `${serializeWorkerView(response)}\n` : render(response);
    if (Buffer.byteLength(text) > WORKER_VIEW_MAX_BYTES) throw new Error();
    out(text); return 0;
  } catch { err("invalid_worker_response\n"); return 1; }
}

function render(response: WorkerViewListResult | WorkerViewInspectResult): string {
  const views = "views" in response ? response.views : [response.view];
  // JSON quoting escapes terminal controls in directory names. Other displayed
  // strings are schema enums or authenticated base64url tokens, never log text.
  const pathLabel = serializeWorkerView(response.scope.repo_path);
  const lines = [`Worker state views — ${pathLabel} (default tenant)`,
    "Graph: unsupported; unbound runs: excluded_not_bound; content: structured metadata only.",
    "Process liveness: unknown; execution/cancel/resume controls: unsupported."];
  if ("total" in response) lines.push(`Source views: ${response.views.length}/${response.total} (Session and run can describe the same worker).`);
  for (const view of views) lines.push(`${view.source_kind}: ${view.state}; ${view.freshness}; wait=${view.wait_reason}\n  view_id=${view.view_id}`);
  if ("next_cursor" in response && response.next_cursor) lines.push(`next_cursor=${response.next_cursor}`);
  return `${lines.join("\n")}\n`;
}
