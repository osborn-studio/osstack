import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink, rename, opendir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { WorkerInspectParamsSchema, WorkerInspectResultSchema } from "./worker-view-service.js";

const absolute = z.string().min(1).max(4096).refine(isAbsolute).refine(v => !/[\p{C}]/u.test(v));
const pin = z.object({ path: absolute, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const backend = z.object({ kind: z.enum(["tmux", "cmux"]), executable: pin, version_output: z.string().min(1).max(256),
  socket: absolute, target: z.string().regex(/^(?:\$[0-9]+|[a-f0-9-]{36})$/), shell: z.literal("posix") }).strict();
export const ViewerHostConfigSchema = z.object({ schema_version: z.literal(1), home: absolute, node: pin, cli: pin,
  backends: z.array(backend).min(1).max(2) }).strict().refine(c => new Set(c.backends.map(b => b.kind)).size === c.backends.length);
type ViewerHostConfig = z.infer<typeof ViewerHostConfigSchema>;
type Backend = ViewerHostConfig["backends"][number];
type Run = (executable: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<string>;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function verifyAncestors(path: string) {
  for (let current = dirname(path); ; current = dirname(current)) {
    const entry = await lstat(current); const stickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.uid !== 0 && entry.uid !== process.getuid?.()) || ((entry.mode & 0o022) !== 0 && !stickyRoot)) throw Error("viewer_unsafe_ancestor");
    if (dirname(current) === current) break;
  }
}
async function boundedRead(path: string, maximum: number, privateFile: boolean) {
  await verifyAncestors(path);
  if (await realpath(path) !== path) throw Error("viewer_path_alias");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum || before.uid !== process.getuid?.() && before.uid !== 0 ||
      (before.mode & (privateFile ? 0o077 : 0o022)) !== 0 || privateFile && before.uid !== process.getuid?.()) throw Error("viewer_file_invalid");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await file.stat(); const current = await lstat(path);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) throw Error("viewer_file_changed");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
async function verifyPin(value: z.infer<typeof pin>) {
  await verifyAncestors(value.path);
  if (await realpath(value.path) !== value.path) throw Error("viewer_path_alias");
  const file = await open(value.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 268435456 || (before.uid !== process.getuid?.() && before.uid !== 0) || (before.mode & 0o022)) throw Error("viewer_file_invalid");
    const digest = createHash("sha256"); const buffer = Buffer.alloc(65536); let length = 0;
    while (length <= before.size) { const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; length += read.bytesRead; digest.update(buffer.subarray(0, read.bytesRead)); }
    const after = await file.stat(); const current = await lstat(value.path);
    if (length !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) throw Error("viewer_file_changed");
    if (digest.digest("hex") !== value.sha256) throw Error("viewer_pin_mismatch");
  } finally { await file.close(); }
}
const HandoffSchema = z.object({ schema_version: z.literal(1), expires_at_ms: z.number().int(), reference: WorkerInspectParamsSchema,
  duration_ms: z.number().int().min(1000).max(900000) }).strict();
/** Single-use, short-lived private handoff: authority never appears in terminal command text. */
export async function consumeViewerHandoff(homeInput: string, path: string): Promise<string[]> {
  const home = await realpath(homeInput);
  if ( !path.startsWith(`${home}/viewer-handoff-`) || !/^viewer-handoff-[a-f0-9-]{36}\.json$/.test(path.slice(home.length + 1))) throw Error("viewer_handoff_invalid");
  const claim = `${path}.claimed-${randomUUID()}`;
  // An exclusive hard-link claim is not sufficient: two different claim names race. Rename
  // atomically removes the original, so exactly one observer can acquire the capability.
  await rename(path, claim);
  try {
    const data = HandoffSchema.parse(JSON.parse((await boundedRead(claim, 16384, true)).toString("utf8")));
    if (data.expires_at_ms <= Date.now() || data.expires_at_ms > Date.now() + 60000) throw Error("viewer_handoff_expired");
    return ["watch", data.reference.view_id, "--repo", data.reference.repo_path, "--default-tenant", "--duration-ms", String(data.duration_ms)];
  } finally { await unlink(claim); }
}
const nativeRun: Run = async (executable, args, environment) => {
  const result = await promisify(execFile)(executable, args, { shell: false, env: environment, timeout: 3000,
    killSignal: "SIGKILL", maxBuffer: 16384, encoding: "utf8", windowsHide: true });
  return result.stdout;
};
/** tmux's documented multi-argument exec contract; cmux receives only shell-neutral
 * ASCII words. Repository paths and capability tokens stay in the private handoff. */
export function viewerLaunchArguments(config: ViewerHostConfig, item: Backend, handoff: string) {
  const command = ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C", `OSSTACK_HOME=${config.home}`,
    config.node.path, config.cli.path, "worker", "watch-handoff", handoff];
  if (item.kind === "tmux") {
    if (!/^\$[0-9]+$/.test(item.target)) throw Error("viewer_target_invalid");
    return ["-N", "-S", item.socket, "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${item.target}:`,
      "-n", "osstack-view", "-c", config.home, ...command];
  }
  if (!/^[a-f0-9-]{36}$/.test(item.target) || command.some(word => !/^[a-zA-Z0-9_./=:-]+$/.test(word))) throw Error("viewer_shell_contract_invalid");
  return ["--socket", item.socket, "--window", item.target, "--json", "new-workspace", "--command", command.join(" ")];
}
export async function launchWorkerViewer(options: { home: string; backend: "tmux" | "cmux"; reference: unknown; durationMs?: number;
  inspect: (reference: z.infer<typeof WorkerInspectParamsSchema>, signal: AbortSignal) => Promise<unknown>; run?: Run }) {
  const reference = WorkerInspectParamsSchema.parse(options.reference);
  const durationMs = z.number().int().min(1000).max(900000).parse(options.durationMs ?? 60000);
  const home = await realpath(options.home);
  const homeStat = await lstat(home);
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid?.() || (homeStat.mode & 0o077) !== 0) throw Error("viewer_home_not_private");
  const path = join(home, "viewer-backends.json"); const bytes = await boundedRead(path, 32768, true);
  const config = ViewerHostConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (config.home !== home || await realpath(reference.repo_path) !== reference.repo_path) throw Error("viewer_scope_mismatch");
  const item = config.backends.find(row => row.kind === options.backend); if (!item) throw Error("viewer_backend_not_registered");
  if (item.kind === "cmux" && process.platform !== "darwin") throw Error("viewer_platform_unsupported");
  const checkSocket = async () => { await verifyAncestors(item.socket); const socket = await lstat(item.socket);
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0 || await realpath(item.socket) !== item.socket) throw Error("viewer_socket_invalid");
    return `${socket.dev}:${socket.ino}`; };
  const socketIdentity = await checkSocket();
  for (const value of [item.executable, config.node, config.cli]) await verifyPin(value);
  const run = options.run ?? nativeRun; const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const version = await run(item.executable.path, [item.kind === "tmux" ? "-V" : "--version"], env);
  if (version.trim() !== item.version_output) throw Error("viewer_version_mismatch");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const observed = WorkerInspectResultSchema.parse(await Promise.race([options.inspect(reference, controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(Error("viewer_inspect_timeout")), { once: true }))]));
    if (observed.scope.repo_path !== reference.repo_path || observed.scope.tenant !== "default" || observed.view.view_id !== reference.view_id) throw Error("viewer_scope_mismatch");
  } finally { clearTimeout(timer); controller.abort(); }
  if (hash(await boundedRead(path, 32768, true)) !== hash(bytes) || await checkSocket() !== socketIdentity) throw Error("viewer_configuration_changed");
  for (const value of [item.executable, config.node, config.cli]) await verifyPin(value);
  if (await checkSocket() !== socketIdentity) throw Error("viewer_configuration_changed");
  let pending = 0; let scanned = 0;
  for await (const entry of await opendir(home)) {
    if (++scanned > 4096) throw Error("viewer_home_inventory_limit");
    if (!/^viewer-handoff-[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
    const candidate = join(home, entry.name);
    const previous = HandoffSchema.parse(JSON.parse((await boundedRead(candidate, 16384, true)).toString("utf8")));
    if (previous.expires_at_ms <= Date.now()) await unlink(candidate);
    else if (++pending >= 64) throw Error("viewer_pending_limit");
  }
  const handoff = join(home, `viewer-handoff-${randomUUID()}.json`);
  const args = viewerLaunchArguments(config, item, handoff);
  const handle = await open(handoff, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schema_version: 1, expires_at_ms: Date.now() + 60000, reference, duration_ms: durationMs })); await handle.sync(); }
  finally { await handle.close(); }
  // Unknown launch retains the expiring handoff because a delayed child may still consume it.

  try {
    const output = await run(item.executable.path, args, env);
    if (item.kind === "tmux" && !/^%[0-9]+\s*$/.test(output)) throw Error("invalid_launch_receipt");
    if (item.kind === "cmux") {
      const response: unknown = JSON.parse(output);
      if (!response || typeof response !== "object" || Array.isArray(response) || "ok" in response && response.ok === false) throw Error("invalid_launch_receipt");
      const payload = "result" in response ? response.result : response;
      if (!payload || typeof payload !== "object" || !("workspace_id" in payload) || typeof payload.workspace_id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(payload.workspace_id)) throw Error("invalid_launch_receipt");
    }
    return { state: "launch_requested" as const, backend: item.kind, response_sha256: hash(output), worker_controls: "unsupported", auto_retry: false,
      qualification: "backend_runtime_pending", duration_ms: durationMs };
  } catch { return { state: "launch_unknown" as const, backend: item.kind, worker_controls: "unsupported", auto_retry: false, qualification: "backend_runtime_pending" }; }
}

export async function handleWorkerViewerLaunchCommand(args: string[], deps: { home: string;
  inspect: Parameters<typeof launchWorkerViewer>[0]["inspect"]; out?: (text: string) => void; run?: Run }): Promise<number> {
  const out = deps.out ?? console.log;
  if (args.length === 1 && ["help", "--help"].includes(args[0]!)) {
    out("worker open VIEW_ID --backend tmux|cmux --repo ABSOLUTE_PATH --default-tenant [--duration-ms 1000..900000]\nUses fixed private viewer-backends.json; opens a read-only observer. Never focuses, reuses, closes or controls workers."); return 0;
  }
  try {
    if (args[0] !== "open" || args.length > 10 || !args[1] || args[1].startsWith("--")) throw Error("invalid_request");
    const flags = new Map<string, string | true>();
    for (let i = 2; i < args.length; i++) {
      const key = args[i]!;
      if (!["--backend", "--repo", "--default-tenant", "--duration-ms"].includes(key) || flags.has(key)) throw Error("invalid_request");
      if (key === "--default-tenant") { flags.set(key, true); continue; }
      const value = args[++i]; if (!value || value.startsWith("--")) throw Error("invalid_request"); flags.set(key, value);
    }
    const duration = flags.get("--duration-ms");
    if (duration !== undefined && (typeof duration !== "string" || !/^[1-9][0-9]*$/.test(duration))) throw Error("invalid_request");
    const result = await launchWorkerViewer({ home: deps.home, backend: z.enum(["tmux", "cmux"]).parse(flags.get("--backend")),
      reference: { view_id: args[1], repo_path: flags.get("--repo"), default_tenant: flags.get("--default-tenant") },
      ...(duration === undefined ? {} : { durationMs: Number(duration) }), inspect: deps.inspect, ...(deps.run ? { run: deps.run } : {}) });
    out(JSON.stringify(result)); return result.state === "launch_requested" ? 0 : 2;
  } catch {
    out(JSON.stringify({ state: "rejected", reason: "viewer_configuration_or_request_invalid", worker_controls: "unsupported", auto_retry: false })); return 1;
  }
}
