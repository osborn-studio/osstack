import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { ImprovementExecutionView, ImprovementPrDeliveryView } from "@osstack/core";
import { buildAgentChildEnv } from "@osstack/agents";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { assertImprovementTreeUnchanged } from "./improvement-candidate-artifacts.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const managerCache = process.env["COREPACK_HOME"] ?? join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "node/corepack");
const Inputs = z.record(z.string().regex(/^[a-f0-9]{64}$/));
export const ImprovementEnvironment = z.object({
  kind: z.literal("pnpm-frozen-v1"), pnpm_version: z.string().regex(/^11\.(?:[4-9]|[1-9][0-9]+)\.\d+$/),
  corepack_home: z.string(), node_version: z.string(), platform: z.string(), arch: z.string(), inputs: Inputs,
  lifecycle_scripts: z.literal(false), pnpm_hooks: z.literal(false), network: z.literal("public-npm"),
  preparation_runs: z.literal(2),
}).strict();
export type ImprovementEnvironment = z.infer<typeof ImprovementEnvironment>;

function childEnv(home: string): NodeJS.ProcessEnv {
  return buildAgentChildEnv({ HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false", PNPM_CONFIG_IGNORE_PNPMFILE: "true", PNPM_CONFIG_PM_ON_FAIL: "error", PNPM_CONFIG_RUNTIME_ON_FAIL: "error",
    OSSTACK_HOME: home, OSSTACK_AUTOAPPROVE: "0", CI: "true", COREPACK_ENABLE_NETWORK: "0",
    COREPACK_HOME: managerCache, COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENABLE_PROJECT_SPEC: "1", COREPACK_ENABLE_STRICT: "1", COREPACK_ENV_FILE: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  });
}
export function improvementVerificationEnvironment(home: string, value: unknown): NodeJS.ProcessEnv {
  const contract = ImprovementEnvironment.parse(value);
  if (contract.corepack_home !== managerCache) throw new Error("Environment tool cache changed since authorization");
  return childEnv(home);
}

async function command(binary: string, args: string[], cwd: string, home: string, timeout = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd, env: childEnv(home), timeout, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" },
      (error, stdout) => error ? reject(new Error(`Environment ${binary} command failed or was interrupted`)) : resolve(stdout));
  });
}
const versionArgs = ["--pm-on-fail=error", "--version"];

/** Inspect committed inputs, not ambient node_modules or an uncommitted manifest. */
async function inputFiles(repo: string, commit: string, home: string): Promise<Map<string, Buffer>> {
  const rows = (await command("git", ["ls-tree", "-r", "-z", commit], repo, home)).toString().split("\0").filter(Boolean);
  const files = new Map<string, Buffer>();
  for (const row of rows) {
    const [metadata, path] = row.split("\t");
    if (path?.split("/").includes("node_modules")) throw new Error("Committed node_modules cannot be used for clean preparation");
    if (!path || !/(^|\/)(package.json|pnpm-lock.yaml|pnpm-workspace.yaml|\.npmrc|\.pnpmfile\.[cm]?js)$/.test(path)) continue;
    const [mode, type, oid] = metadata!.split(" ");
    if ((mode !== "100644" && mode !== "100755") || type !== "blob" || !oid) throw new Error("Dependency inputs must be regular committed files");
    if (path !== "pnpm-workspace.yaml" && path.endsWith("/pnpm-workspace.yaml")) throw new Error("Nested workspace configuration is not supported");
    files.set(path, await command("git", ["cat-file", "blob", oid], repo, home));
  }
  return files;
}

/** Deliberately bounded public-registry policy; unsupported configuration fails before install. */
export function validateDependencyInputs(files: Map<string, Buffer>): { version: string; inputs: Record<string, string> } {
  const root = files.get("package.json");
  const lock = files.get("pnpm-lock.yaml");
  const workspace = files.get("pnpm-workspace.yaml");
  if (!root || !lock || !workspace) throw new Error("Preparation requires committed package.json, pnpm-lock.yaml and pnpm-workspace.yaml");
  if ([...files.keys()].some((p) => p.split("/").at(-1) === ".npmrc")) throw new Error("Custom npmrc credentials/configuration are not supported by public-npm preparation");
  const rootPackage = z.object({ packageManager: z.string() }).passthrough().parse(JSON.parse(root.toString()));
  const version = /^pnpm@(11\.(?:[4-9]|[1-9][0-9]+)\.\d+)$/.exec(rootPackage.packageManager)?.[1];
  if (!version) throw new Error("Preparation requires an exact pnpm@11.4+ (11.x) packageManager version");
  for (const [path, contents] of files) {
    if (!path.endsWith("package.json")) continue;
    const manifest = z.record(z.unknown()).parse(JSON.parse(contents.toString()));
    if (manifest.pnpm !== undefined || manifest.devEngines !== undefined) throw new Error("Manifest pnpm/devEngines configuration requires a separate environment policy");
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = z.record(z.string()).parse(manifest[key] ?? {});
      for (const spec of Object.values(dependencies)) {
        if (/^catalog:[A-Za-z0-9_-]*$/.test(spec)) continue;
        if (/^workspace:[~^*0-9][~^*0-9.><=| -]*$/.test(spec)) continue;
        if (/^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@[~^*0-9][~^*0-9.><=| -]*$/.test(spec)) continue;
        if (/[/:\\]/.test(spec) || spec.includes("$") || spec.startsWith(".")) throw new Error("External file, link, Git and URL dependencies are not supported");
      }
    }
  }
  const settings = z.object({ packages: z.array(z.string()).optional(), overrides: z.record(z.string()).optional(),
    catalog: z.record(z.string()).optional(), catalogs: z.record(z.record(z.string())).optional(),
    allowBuilds: z.record(z.boolean()).optional(),
  }).strict().parse(parseYaml(workspace.toString()) ?? {});
  for (const pattern of settings.packages ?? []) {
    if (!/^!?[A-Za-z0-9_*.-]+(?:\/[A-Za-z0-9_*.-]+)*$/.test(pattern) || pattern.includes("..") || pattern.includes("**")
      || pattern.replace(/^!/, "").split("/").some((part) => part.includes("*") && part !== "*")) throw new Error("Workspace patterns support relative paths and single-segment * only");
  }
  for (const values of [settings.overrides, settings.catalog, ...Object.values(settings.catalogs ?? {})]) {
    if (Object.values(values ?? {}).some((value) => /[/:\\$]/.test(value))) throw new Error("Exotic override/catalog sources are not supported");
  }
  const lockfile = z.object({ lockfileVersion: z.union([z.string(), z.number()]), packages: z.record(z.object({
    resolution: z.object({ integrity: z.string().regex(/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/) }).strict(),
  }).passthrough()).optional() }).passthrough().parse(parseYaml(lock.toString()));
  if (String(lockfile.lockfileVersion) !== "9.0" && String(lockfile.lockfileVersion) !== "9") throw new Error("Only pnpm lockfile version 9 is supported");
  if (Object.keys(lockfile.packages ?? {}).some((key) => key.includes(":"))) throw new Error("Unsupported locked package source");
  const snapshots = z.record(z.record(z.unknown())).parse(lockfile.snapshots ?? {});
  for (const snapshot of Object.values(snapshots)) {
    for (const kind of ["dependencies", "optionalDependencies"]) {
      if (Object.values(z.record(z.string()).parse(snapshot[kind] ?? {})).some((value) => value.includes(":") || value.includes("\\"))) throw new Error("Unsupported transitive lockfile source");
    }
  }
  const importers = z.record(z.record(z.unknown())).parse(lockfile.importers ?? {});
  const patterns = (settings.packages ?? []).map((pattern) => ({ exclude: pattern.startsWith("!"),
    match: new RegExp(`^${pattern.replace(/^!/, "").split("/").map((part) => part === "*" ? "[^/]+" : part.replaceAll(".", "\\.")).join("/")}$`) }));
  const expectedImporters = [".", ...[...files.keys()].filter((path) => path.endsWith("/package.json"))
    .map((path) => path.slice(0, -"/package.json".length))
    .filter((path) => patterns.some((p) => !p.exclude && p.match.test(path)) && !patterns.some((p) => p.exclude && p.match.test(path)))].sort();
  if (JSON.stringify(Object.keys(importers).sort()) !== JSON.stringify(expectedImporters)) throw new Error("Lockfile importers differ from committed workspace packages");
  for (const [path, importer] of Object.entries(importers)) {
    if (path !== "." && (path.startsWith("/") || path.includes("..") || path.includes("\\"))) throw new Error("Lockfile importer escapes repository");
    if (!files.has(path === "." ? "package.json" : `${path}/package.json`)) throw new Error("Lockfile importer manifest is not committed");
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const dependency of Object.values(z.record(z.object({ version: z.string() }).passthrough()).parse(importer[kind] ?? {}))) {
        if (dependency.version.startsWith("link:")) {
          const target = posix.normalize(posix.join(path, dependency.version.slice(5)));
          if (target.startsWith("../") || posix.isAbsolute(dependency.version.slice(5)) || !Object.hasOwn(importers, target) || !files.has(`${target}/package.json`)) throw new Error("Lockfile link must target a committed in-repository package");
        } else if (/[/:\\]/.test(dependency.version.split("(")[0]!)) throw new Error("Unsupported lockfile dependency source");
      }
    }
  }
  return { version, inputs: Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => [path, hash(bytes)])) };
}

export async function previewImprovementEnvironment(repo: string, baseSha: string): Promise<ImprovementEnvironment> {
  const home = await mkdtemp(join(tmpdir(), "osstack-env-preview-"));
  try {
    const { version, inputs } = validateDependencyInputs(await inputFiles(repo, baseSha, home));
    await writeFile(join(home, "package.json"), JSON.stringify({ packageManager: `pnpm@${version}` }));
    const actual = (await command("pnpm", versionArgs, home, home)).toString().trim();
    if (actual !== version) throw new Error(`Installed pnpm version differs from pinned ${version}; automatic download is disabled`);
    return ImprovementEnvironment.parse({ kind: "pnpm-frozen-v1", pnpm_version: version, corepack_home: managerCache, node_version: (await command("node", ["--version"], home, home)).toString().trim(),
      platform: process.platform, arch: process.arch, inputs, lifecycle_scripts: false, pnpm_hooks: false,
      network: "public-npm", preparation_runs: 2 });
  } finally { await rm(home, { recursive: true, force: true }); }
}

/** Runs once in a new stage directory; a crash leaves a started receipt, never permission to retry. */
export async function prepareImprovementEnvironment(input: {
  contract: ImprovementEnvironment; workspace: string; commit: string; directory: string;
  timeoutMs: number; checkActive: () => void;
}): Promise<void> {
  const contract = ImprovementEnvironment.parse(input.contract);
  input.checkActive();
  await mkdir(input.directory, { mode: 0o700 });
  const home = join(input.directory, "home");
  await mkdir(home, { mode: 0o700 });
  const start = { environment: contract, commit: input.commit, workspace: input.workspace, started_at: Date.now() / 1000 };
  await writeFile(join(input.directory, "started.json"), JSON.stringify(start), { flag: "wx", mode: 0o600 });
  let phase = "input_validation";
  try {
    const current = validateDependencyInputs(await inputFiles(input.workspace, input.commit, home));
    if (Object.keys(current.inputs).length !== Object.keys(contract.inputs).length
      || Object.entries(current.inputs).some(([path, digest]) => contract.inputs[path] !== digest) || current.version !== contract.pnpm_version) throw new Error("Frozen dependency inputs changed");
    phase = "toolchain_check";
    await writeFile(join(home, "package.json"), JSON.stringify({ packageManager: `pnpm@${contract.pnpm_version}` }));
    if (managerCache !== contract.corepack_home || process.platform !== contract.platform || process.arch !== contract.arch
      || (await command("node", ["--version"], home, home)).toString().trim() !== contract.node_version
      || (await command("pnpm", versionArgs, home, home)).toString().trim() !== contract.pnpm_version) throw new Error("Environment toolchain changed since authorization");
    await assertImprovementTreeUnchanged(input.workspace, input.commit);
    for (const path of Object.keys(current.inputs).filter((path) => path.endsWith("package.json"))) {
      let exists = false;
      try { await lstat(join(input.workspace, dirname(path), "node_modules")); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (exists) throw new Error("Environment preparation requires a fresh checkout without existing node_modules");
    }
    input.checkActive();
    phase = "install";
    await command("pnpm", ["--pm-on-fail=error", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--no-runtime",
      "--store-dir", join(input.directory, "store"), "--virtual-store-dir", "node_modules/.pnpm", "--modules-dir", "node_modules",
      "--package-import-method", "copy", "--config.enable-global-virtual-store=false", "--config.side-effects-cache=false",
      "--config.runtime-on-fail=error", "--registry=https://registry.npmjs.org/", "--reporter=silent",
    ], input.workspace, home, input.timeoutMs);
    input.checkActive();
    phase = "source_check";
    await assertImprovementTreeUnchanged(input.workspace, input.commit);
    await writeFile(join(input.directory, "completed.json"), JSON.stringify({ ...start, completed_at: Date.now() / 1000 }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Do not persist raw installer output: URLs or config errors can contain credentials.
    await writeFile(join(input.directory, "failed.json"), JSON.stringify({ ...start, failed_at: Date.now() / 1000,
      phase, message: error instanceof Error ? error.message : "Environment preparation failed", retry_allowed: false,
    }), { flag: "wx", mode: 0o600 });
    throw error;
  }
}


export async function improvementEnvironmentStatus(execution: ImprovementExecutionView, delivery?: ImprovementPrDeliveryView) {
  if (execution.request.environment === undefined || typeof execution.request.evidence_root !== "string") return undefined;
  const read = async (directory: string) => {
    for (const state of ["failed", "completed", "started"] as const) {
      try {
        const receipt = JSON.parse(await readFile(join(directory, `${state}.json`), "utf8")) as unknown;
        return { directory, state, receipt };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { directory, state: "unreadable" as const };
      }
    }
    return { directory, state: "not_started" as const };
  };
  return {
    candidate: await read(join(execution.request.evidence_root, hash(execution.execution_id), "dependency-environment")),
    ...(delivery?.workspace_path === undefined ? {} : { replay: await read(join(delivery.workspace_path, "dependency-environment")) }),
  };
}
