// osstack `hub` command — CLI-first Private Hub candidate registration and
// publish (Phase 2B Task 8). osstack is an OPTIONAL project manager over the
// OPEN Hub; it resolves Hub tooling from OSSTACK_HUB_ROOT (fallback HUB_ROOT)
// and invokes Node with ARGUMENT ARRAYS, never shell strings.
//
// Reconciliation with the current Hub (Phase 2A.5):
//  - publish is routed to the Hub's `tooling/osstack_publish.mjs` (contract 1.1,
//    --gate/--json); release identity is release_id + digest + storage_key,
//    NEVER a dist/packages path.
//  - candidate registration records only an EXTERNAL source reference (repo +
//    exact HEAD commit + repo-relative path); it never copies working source and
//    never implies a release. A dirty source is refused unless --allow-dirty,
//    and a dirty registration records source_dirty:true and cannot pass
//    client/commercial gates.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as pathResolve } from "node:path";

const execFileAsync = promisify(execFile);

export interface HubCliResult {
  exitCode: number;
  stdout: string;
}

export interface ResolvedSource {
  repository: string;
  commit: string;
  path: string;
  dirty: boolean;
}

export interface HubCliDeps {
  env?: NodeJS.ProcessEnv;
  /** Run a Node script with an argument array; returns its stdout + exit code. */
  runNode: (scriptPath: string, argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Resolve the git source triple (+ dirty flag) for an asset path. */
  resolveSource: (assetPath: string) => Promise<ResolvedSource>;
}

// ── arg parsing ──────────────────────────────────────────────────────────

interface ParsedFlags {
  positional: string[];
  namespace?: string;
  reuseScope: string;
  gate: string;
  surfaces: string;
  json: boolean;
  allowDirty: boolean;
}

const REUSE_SCOPES = new Set(["personal", "team", "client", "commercial"]);
const GATES = new Set(["draft", "team", "client", "commercial", "embedded"]);
const SURFACES = new Set(["api", "store", "none"]);

/** A flag value must exist and NOT itself be an option token (blocks
 *  `--surfaces --no-push` style option injection into the child arg array). */
function flagValue(args: string[], i: number): string | undefined {
  const v = args[i];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

function parseFlags(args: string[]): ParsedFlags & { invalid?: string } {
  const out: ParsedFlags & { invalid?: string } = { positional: [], reuseScope: "team", gate: "team", surfaces: "api", json: false, allowDirty: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--namespace": { const v = flagValue(args, ++i); if (v === undefined) out.invalid ??= "--namespace"; else out.namespace = v; break; }
      case "--reuse-scope": { const v = flagValue(args, ++i); if (v === undefined) out.invalid ??= "--reuse-scope"; else out.reuseScope = v; break; }
      case "--gate": { const v = flagValue(args, ++i); if (v === undefined) out.invalid ??= "--gate"; else out.gate = v; break; }
      case "--surfaces": { const v = flagValue(args, ++i); if (v === undefined) out.invalid ??= "--surfaces"; else out.surfaces = v; break; }
      case "--json": out.json = true; break;
      case "--allow-dirty": out.allowDirty = true; break;
      default:
        if (a !== undefined && !a.startsWith("--")) out.positional.push(a);
        else if (a !== undefined) out.invalid ??= a; // unknown flag
    }
  }
  // enum validation (rejects injected option tokens masquerading as values)
  if (out.invalid === undefined) {
    if (!REUSE_SCOPES.has(out.reuseScope)) out.invalid = "--reuse-scope";
    else if (!GATES.has(out.gate)) out.invalid = "--gate";
    else if (!SURFACES.has(out.surfaces)) out.invalid = "--surfaces";
  }
  return out;
}

function resolveHubRoot(env: NodeJS.ProcessEnv): string | undefined {
  return env["OSSTACK_HUB_ROOT"] ?? env["HUB_ROOT"];
}

function parseNamespace(value: string | undefined): { kind: string; id: string } | undefined {
  if (value === undefined) return undefined;
  const [kind, id] = value.split("/");
  if (kind === undefined || id === undefined || id === "") return undefined;
  if (kind !== "personal" && kind !== "organization") return undefined;
  return { kind, id };
}

function fail(json: boolean, exitCode: number, payload: Record<string, unknown>): HubCliResult {
  return { exitCode, stdout: json ? JSON.stringify(payload) : `${payload["status"] ?? "error"}: ${(payload["reasons"] as string[] | undefined)?.join(", ") ?? payload["message"] ?? ""}` };
}

// ── command ───────────────────────────────────────────────────────────────

export async function handleHubCommand(args: string[], deps: HubCliDeps): Promise<HubCliResult> {
  const env = deps.env ?? process.env;
  const sub = args[0];
  const flags = parseFlags(args.slice(1));
  if (flags.invalid !== undefined) {
    return fail(flags.json, 1, { status: "error", reasons: ["invalid_flag"], message: `invalid or option-injected value for ${flags.invalid}` });
  }
  const hubRoot = resolveHubRoot(env);
  if (hubRoot === undefined) {
    return fail(flags.json, 1, { status: "error", reasons: ["no_hub_root"], message: "set OSSTACK_HUB_ROOT (or HUB_ROOT)" });
  }

  if (sub === "candidate") return await runCandidate(hubRoot, flags, deps);
  if (sub === "publish") return await runPublish(hubRoot, flags, deps);
  return fail(flags.json, 1, { status: "error", reasons: ["unknown_subcommand"], message: "usage: osstack hub <candidate|publish> ..." });
}

async function runCandidate(hubRoot: string, flags: ParsedFlags, deps: HubCliDeps): Promise<HubCliResult> {
  const assetPath = flags.positional[0];
  if (assetPath === undefined) {
    return fail(flags.json, 1, { status: "error", reasons: ["missing_asset_path"] });
  }
  const namespace = parseNamespace(flags.namespace);
  if (namespace === undefined) {
    return fail(flags.json, 1, { status: "error", reasons: ["invalid_namespace"], message: "--namespace personal|organization/<id> required" });
  }

  const source = await deps.resolveSource(assetPath);
  if (source.dirty && !flags.allowDirty) {
    // Refuse a dirty external source unless explicitly allowed.
    return fail(flags.json, 2, { status: "blocked", reasons: ["dirty_source"], message: "source has uncommitted changes; re-run with --allow-dirty to register a dirty reference" });
  }
  // A dirty source can NEVER pass a client/commercial gate — refuse it outright
  // (even with --allow-dirty), rather than record a claim the Hub can't enforce.
  if (source.dirty && (flags.reuseScope === "client" || flags.reuseScope === "commercial")) {
    return fail(flags.json, 2, { status: "blocked", reasons: ["dirty_source_elevated_scope"], message: `a dirty source cannot be registered at reuse_scope=${flags.reuseScope}` });
  }

  // Register ONLY the external source reference — never copy working source. The
  // Hub companion CLI derives asset identity from the asset manifest and calls
  // registerCandidate (source reference only, no promotion).
  const script = pathResolve(hubRoot, "tooling", "register_candidate_cli.mjs");
  const argv = [
    "--asset-path", assetPath,
    "--namespace", `${namespace.kind}/${namespace.id}`,
    "--reuse-scope", flags.reuseScope,
    "--repository", source.repository,
    "--commit", source.commit,
    "--path", source.path,
    ...(source.dirty ? ["--source-dirty"] : []),
    "--json",
  ];
  const { stdout, exitCode } = await deps.runNode(script, argv);
  const parsed = safeJson(stdout);
  // STRICT mapping: registered -> 0; explicit blocked -> 2; everything else
  // (including exit 0 with malformed output) -> error (1). Never trust an
  // arbitrary child exit code.
  const status = parsed !== undefined ? String(parsed["status"] ?? "") : "";
  if (exitCode !== 0 || status !== "registered") {
    const code = status === "blocked" ? 2 : 1;
    return fail(flags.json, code, { status: status === "blocked" ? "blocked" : "error", reasons: parsed !== undefined ? parseReasons(stdout) : ["malformed_output"] });
  }
  const p = parsed as Record<string, unknown>; // defined: status === "registered"
  const result = {
    status: "registered" as const,
    namespace: `${namespace.kind}/${namespace.id}`,
    reuse_scope: flags.reuseScope,
    source_dirty: source.dirty === true,
    ...(safeCandidateId(p["candidate_id"]) !== undefined ? { candidate_id: safeCandidateId(p["candidate_id"]) } : {}),
  };
  return { exitCode: 0, stdout: flags.json ? JSON.stringify(result) : `registered candidate for ${result.namespace} (dirty: ${result.source_dirty})` };
}

async function runPublish(hubRoot: string, flags: ParsedFlags, deps: HubCliDeps): Promise<HubCliResult> {
  const assetId = flags.positional[0];
  if (assetId === undefined) {
    return fail(flags.json, 1, { status: "error", reasons: ["missing_asset_id"] });
  }
  // Route to the Hub publish command (contract 1.1). Argument array, no shell.
  const script = pathResolve(hubRoot, "tooling", "osstack_publish.mjs");
  const argv = [assetId, "--gate", flags.gate, "--surfaces", flags.surfaces, "--json"];
  const { stdout } = await deps.runNode(script, argv);

  const parsed = safeJson(stdout);
  if (parsed === undefined) {
    return fail(flags.json, 1, { status: "error", reasons: ["malformed_output"] });
  }
  const status = String(parsed["status"] ?? "error");
  // Sanitize the Hub-controlled id AND the caller's assetId (either could be a
  // path); reasons are redacted. Never echo an absolute/dist path or a secret.
  const id = safeAssetId(parsed["id"]) ?? safeAssetId(assetId) ?? "redacted";
  const out: Record<string, unknown> = {
    status,
    id,
    gate: GATES.has(String(parsed["gate"])) ? parsed["gate"] : flags.gate,
    reasons: redactReasons(parsed["reasons"]),
  };
  if (status === "published") {
    // Release identity ONLY on success; identity is logical (never a dist/
    // absolute path smuggled via namespace/releaseId).
    const namespace = safeNamespace(parsed["namespace"]);
    const releaseId = safeReleaseId(parsed["releaseId"]);
    const digest = typeof parsed["digest"] === "string" && /^sha256:[a-f0-9]{64}$/.test(parsed["digest"] as string) ? parsed["digest"] : undefined;
    if (namespace !== undefined) out["namespace"] = namespace;
    if (releaseId !== undefined) out["release_id"] = releaseId;
    if (digest !== undefined) out["digest"] = digest;
    const storageKey = safeStorageKey(parsed["storage_key"]) ?? safeStorageKey(parsed["packagePath"]);
    if (storageKey !== undefined) out["storage_key"] = storageKey;
  }
  const code = status === "published" ? 0 : status === "blocked" ? 2 : 1;
  return { exitCode: code, stdout: flags.json ? JSON.stringify(out) : `${status} ${out["id"]} ${out["release_id"] ?? ""}`.trim() };
}

const RELEASE_ID_RE = /^[a-z0-9][a-z0-9-]*__[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.-]*$/;
const NAMESPACE_RE = /^(personal|organization)\/[a-z0-9][a-z0-9-]*$/;

/** Logical relative locator only — rejects any drive prefix (incl. drive-relative
 *  "C:x"), backslashes, leading "/", and dist/packages case-insensitively. */
function safeStorageKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) return undefined;
  if (/(^|\/)dist\/packages(\/|$)/i.test(value) || /^dist\//i.test(value)) return undefined;
  if (value.split("/").some((s) => s === "" || s === "." || s === "..")) return undefined;
  return value;
}
function safeReleaseId(value: unknown): string | undefined {
  return typeof value === "string" && RELEASE_ID_RE.test(value) ? value : undefined;
}
const ASSET_ID_RE = /^[a-z0-9][a-z0-9._-]+$/;
const CANDIDATE_ID_RE = /^cand-[a-z0-9-]+$/;
function safeAssetId(value: unknown): string | undefined {
  return typeof value === "string" && ASSET_ID_RE.test(value) ? value : undefined;
}
function safeCandidateId(value: unknown): string | undefined {
  return typeof value === "string" && CANDIDATE_ID_RE.test(value) ? value : undefined;
}
/** Mask absolute paths / dist-packages / secrets in Hub-controlled free text. */
function redactText(s: string): string {
  return String(s)
    .replace(/\/(?:Volumes|Users|home|private|etc|opt|var|tmp|root|mnt|srv)\/\S*/gi, "[redacted-path]")
    .replace(/[A-Za-z]:[\\/]\S*/g, "[redacted-path]")
    .replace(/dist\/packages\/\S*/gi, "[redacted-path]")
    .replace(/\b(?:sb_secret_[A-Za-z0-9]+|sk-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})\b/g, "[redacted-secret]");
}
function redactReasons(r: unknown): string[] {
  return Array.isArray(r) ? r.map((x) => redactText(String(x))) : [];
}
function safeNamespace(value: unknown): string | undefined {
  return typeof value === "string" && NAMESPACE_RE.test(value) ? value : undefined;
}

function safeJson(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").at(-1);
  if (line === undefined) return undefined;
  try {
    const v = JSON.parse(line);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

function parseReasons(stdout: string): string[] {
  const parsed = safeJson(stdout);
  const reasons = parsed?.["reasons"];
  return Array.isArray(reasons) && reasons.length > 0 ? redactReasons(reasons) : ["hub_error"];
}

// ── real deps (spawn + git) ────────────────────────────────────────────────

export function buildRealHubCliDeps(): HubCliDeps {
  return {
    env: process.env,
    runNode: (scriptPath, argv) => new Promise((resolveP) => {
      const child = spawn(process.execPath, [scriptPath, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      child.on("error", () => resolveP({ stdout, stderr, exitCode: 1 }));
      child.on("close", (code) => resolveP({ stdout, stderr, exitCode: code ?? 1 }));
    }),
    resolveSource: async (assetPath) => {
      const dir = pathResolve(assetPath);
      const git = async (a: string[]): Promise<string> => (await execFileAsync("git", ["-C", dir, ...a])).stdout.trim();
      const repository = await git(["config", "--get", "remote.origin.url"]);
      const commit = await git(["rev-parse", "HEAD"]);
      const toplevel = await git(["rev-parse", "--show-toplevel"]);
      const rel = dir.startsWith(toplevel) ? dir.slice(toplevel.length + 1) : dir;
      const status = await git(["status", "--porcelain", "--", "."]);
      return { repository, commit, path: rel || ".", dirty: status.trim() !== "" };
    },
  };
}
