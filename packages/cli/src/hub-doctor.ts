import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Fixed origin: configuration cannot redirect the shared read credential to
// another host. This checks health, never POSTs or runs the publisher.
const API_HEALTH = "https://api.osbornhub.com/api/health";

export interface HubDoctorDeps {
  home: string;
  fetch: typeof globalThis.fetch;
}

async function exists(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const info = await stat(path);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch { return false; }
}

async function readHealth(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) return null;
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function inspectHub(
  env: NodeJS.ProcessEnv,
  deps: HubDoctorDeps = { home: homedir(), fetch: globalThis.fetch },
): Promise<Record<string, unknown>> {
  const root = env["OSSTACK_HUB_ROOT"]?.trim() || env["HUB_ROOT"]?.trim();
  const reasons: string[] = [];
  const publisher = root !== undefined && await exists(join(root, "tooling/osstack_publish.mjs"), "file");
  const candidate = root !== undefined && await exists(join(root, "tooling/register_candidate_cli.mjs"), "file");
  const catalogRoot = env["CATALOG_DIR"] || (root ? resolve(root, "../osborn-skill-catalog") : undefined);
  const catalog = catalogRoot !== undefined && await exists(join(catalogRoot, "skills"), "directory");
  if (!root) reasons.push("no_hub_root");
  if (!publisher) reasons.push("publisher_missing");
  if (!candidate) reasons.push("candidate_tool_missing");
  if (!catalog) reasons.push("catalog_missing");

  let key = env["SKILL_HUB_KEY"]?.trim();
  if (!key) {
    try { key = (await readFile(join(deps.home, ".osborn/secrets/skill_hub_key"), "utf8")).trim(); }
    catch { /* Missing credentials are a diagnostic result, never printed. */ }
  }
  let apiRead = "missing_key";
  if (key) {
    try {
      const response = await deps.fetch(API_HEALTH, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.status === 401 || response.status === 403) apiRead = "unauthorized";
      else if (!response.ok) apiRead = "http_error";
      else {
        const body = await readHealth(response);
        apiRead = body !== null && typeof body === "object" && "ok" in body && body.ok === true
          ? "reachable" : "unexpected_response";
      }
    } catch { apiRead = "unreachable"; }
  }
  if (apiRead !== "reachable") reasons.push(`api_${apiRead}`);
  return {
    status: reasons.length === 0 ? "configured" : "needs_configuration",
    target: "https://api.osbornhub.com",
    route: "catalog-gitops",
    local: { publisher, candidate, catalog },
    api_read: apiRead,
    publish_permission: "unverified",
    // An agent display name or a successful health check is not a grant.
    permission_check: "requires authenticated catalog writer and repository policy",
    publish_command: "osstack hub publish <asset-id> --gate team --json",
    reasons,
  };
}
