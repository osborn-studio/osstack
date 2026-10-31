import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type HardenedGitContext, HardenedGitError, runHardenedGit } from "./hardened-git.js";

export const REPO_CONFIG_REJECTION_CODES = [
  "REPO_CONFIG_FILTER",
  "REPO_CONFIG_DIFF_PROGRAM",
  "REPO_CONFIG_MERGE_DRIVER",
  "REPO_CONFIG_CORE_PROGRAM",
  "REPO_CONFIG_CREDENTIAL",
  "REPO_CONFIG_URL_REWRITE",
  "REPO_CONFIG_REMOTE_TRANSPORT",
  "REPO_CONFIG_PROTOCOL",
  "REPO_CONFIG_HTTP_PROXY",
  "REPO_CONFIG_UPLOADPACK",
  "REPO_CONFIG_RECEIVE",
  "REPO_CONFIG_INCLUDE_OUTSIDE",
  "REPO_CONFIG_HOOKS_PATH",
  "REPO_CONFIG_GPG_PROGRAM",
] as const;
export type RepoConfigRejectionCode = (typeof REPO_CONFIG_REJECTION_CODES)[number];

export interface RepoConfigEntry {
  scope: string;
  origin: string;
  /** As printed by git: section and variable lowercased, subsection verbatim. */
  key: string;
  value: string | null;
}
export interface RepoConfigRejection {
  code: RepoConfigRejectionCode;
  key: string;
  origin: string;
}
export interface RepoConfigInspection {
  /** Real path of the repository's common git directory. */
  gitDir: string;
  /** `sha256:<hex>` over the ordered (scope, key, value) entries; origins are excluded. */
  digest: string;
  entries: RepoConfigEntry[];
  rejections: RepoConfigRejection[];
}

export class RepoConfigChangedError extends Error {
  readonly code = "REPO_CONFIG_CHANGED";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`REPO_CONFIG_CHANGED: expected ${expected}, found ${actual}`);
    this.name = "RepoConfigChangedError";
  }
}

const CORE_PROGRAM_KEYS = new Set(["sshcommand", "gitproxy", "pager", "editor", "askpass"]);

function splitKey(key: string): { section: string; subsection: string | undefined; variable: string } {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  return {
    section: key.slice(0, first).toLowerCase(),
    subsection: first === last ? undefined : key.slice(first + 1, last),
    variable: key.slice(last + 1).toLowerCase(),
  };
}

function ruleFor(entry: RepoConfigEntry): RepoConfigRejectionCode | "include" | undefined {
  const { section, subsection, variable } = splitKey(entry.key);
  const sub = subsection !== undefined;
  switch (section) {
    case "filter":
      return "REPO_CONFIG_FILTER";
    case "diff":
      if ((sub && (variable === "textconv" || variable === "command")) || (!sub && variable === "external")) return "REPO_CONFIG_DIFF_PROGRAM";
      return undefined;
    case "merge":
      return sub && variable === "driver" ? "REPO_CONFIG_MERGE_DRIVER" : undefined;
    case "core":
      if (sub) return undefined;
      if (variable === "hookspath") return "REPO_CONFIG_HOOKS_PATH";
      if (CORE_PROGRAM_KEYS.has(variable)) return "REPO_CONFIG_CORE_PROGRAM";
      if (variable === "fsmonitor" && !/^(false|no|off|0|)$/i.test(entry.value ?? "true")) return "REPO_CONFIG_CORE_PROGRAM";
      return undefined;
    case "credential":
      return "REPO_CONFIG_CREDENTIAL";
    case "url":
      return sub && (variable === "insteadof" || variable === "pushinsteadof") ? "REPO_CONFIG_URL_REWRITE" : undefined;
    case "remote":
      return sub && ["receivepack", "uploadpack", "proxy"].includes(variable) ? "REPO_CONFIG_REMOTE_TRANSPORT" : undefined;
    case "protocol":
      return "REPO_CONFIG_PROTOCOL";
    case "http":
      return variable === "proxy" ? "REPO_CONFIG_HTTP_PROXY" : undefined;
    case "uploadpack":
      return "REPO_CONFIG_UPLOADPACK";
    case "receive":
      return "REPO_CONFIG_RECEIVE";
    case "gpg":
      return variable === "program" ? "REPO_CONFIG_GPG_PROGRAM" : undefined;
    case "include":
      return !sub && variable === "path" ? "include" : undefined;
    case "includeif":
      return sub && variable === "path" ? "include" : undefined;
    default:
      return undefined;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function includeInsideGitDir(entry: RepoConfigEntry, repoPath: string, gitDir: string, home: string | undefined): boolean {
  const value = entry.value;
  if (!value || !entry.origin.startsWith("file:")) return false;
  let target: string;
  if (value.startsWith("~/")) {
    if (!home) return false;
    target = join(home, value.slice(2));
  } else if (value.startsWith("~") || value.startsWith("%(prefix)")) {
    return false;
  } else {
    const originFile = resolve(repoPath, entry.origin.slice("file:".length));
    target = isAbsolute(value) ? value : resolve(dirname(originFile), value);
  }
  let real = resolve(target);
  try {
    real = realpathSync(real);
  } catch {
    try {
      real = join(realpathSync(dirname(real)), real.slice(dirname(real).length + 1));
    } catch {
      // keep the lexical path for a missing include
    }
  }
  return within(real, gitDir);
}

/** Parse `git config --list -z --show-scope --show-origin` output. */
export function parseGitConfigList(output: Buffer | string): RepoConfigEntry[] {
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) throw new Error("REPO_CONFIG_UNPARSEABLE");
  const entries: RepoConfigEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index] as string;
    const origin = fields[index + 1] as string;
    const keyValue = fields[index + 2] as string;
    const newline = keyValue.indexOf("\n");
    entries.push(
      newline < 0
        ? { scope, origin, key: keyValue, value: null }
        : { scope, origin, key: keyValue.slice(0, newline), value: keyValue.slice(newline + 1) },
    );
  }
  return entries;
}

export function repoConfigDigest(entries: readonly RepoConfigEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(JSON.stringify([entry.scope, entry.key, entry.value])).update("\n");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Read every repository-scoped config entry (local and worktree files, with
 * include/includeIf expanded) and flag keys that run programs or change transport.
 */
export async function inspectRepoConfig(repoPath: string, context: HardenedGitContext = {}): Promise<RepoConfigInspection> {
  const commonDir = (await runHardenedGit(["rev-parse", "--git-common-dir"], { ...context, cwd: repoPath })).stdout.toString("utf8").trim();
  const gitDir = await realpath(resolve(repoPath, commonDir));
  const listing = await runHardenedGit(["config", "--list", "-z", "--show-scope", "--show-origin", "--includes"], {
    ...context,
    cwd: repoPath,
  });
  const entries = parseGitConfigList(listing.stdout).filter((entry) => entry.scope !== "command");
  const home = context.home ?? context.env?.HOME ?? process.env.HOME;
  const rejections: RepoConfigRejection[] = [];
  for (const entry of entries) {
    const rule = ruleFor(entry);
    if (rule === undefined) continue;
    if (rule === "include") {
      if (!includeInsideGitDir(entry, repoPath, gitDir, home)) rejections.push({ code: "REPO_CONFIG_INCLUDE_OUTSIDE", key: entry.key, origin: entry.origin });
      continue;
    }
    rejections.push({ code: rule, key: entry.key, origin: entry.origin });
  }
  return { gitDir, digest: repoConfigDigest(entries), entries, rejections };
}

/** Re-inspect and throw {@link RepoConfigChangedError} unless the digest still matches. */
export async function assertRepoConfigUnchanged(repoPath: string, expectedDigest: string, context: HardenedGitContext = {}): Promise<RepoConfigInspection> {
  const inspection = await inspectRepoConfig(repoPath, context);
  if (inspection.digest !== expectedDigest) throw new RepoConfigChangedError(expectedDigest, inspection.digest);
  return inspection;
}

/**
 * `-c` overrides that disable every configured filter driver, for the few
 * plumbing commands that may hash worktree files (index refresh).
 */
export async function filterNeutralizingConfig(cwd: string, context: HardenedGitContext = {}): Promise<[string, string][]> {
  const listing = await runHardenedGit(["config", "--list", "-z", "--show-scope", "--show-origin", "--includes"], { ...context, cwd });
  const drivers = new Set<string>();
  for (const entry of parseGitConfigList(listing.stdout)) {
    const { section, subsection } = splitKey(entry.key);
    if (section !== "filter" || subsection === undefined) continue;
    if (/[=\n\0]/.test(subsection)) throw new HardenedGitError("HARDENED_GIT_INVALID_ARGS", ["config"]);
    drivers.add(subsection);
  }
  return [...drivers].flatMap((name): [string, string][] => [
    [`filter.${name}.clean`, ""],
    [`filter.${name}.smudge`, ""],
    [`filter.${name}.process`, ""],
    [`filter.${name}.required`, "false"],
  ]);
}
