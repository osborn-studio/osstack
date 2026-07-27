import { execFile } from "node:child_process";
import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  extname,
  isAbsolute,
  resolve,
  sep,
} from "node:path";
import {
  evaluateReviewBoundary,
  type ReviewBoundaryFile,
  type ReviewBoundaryResult,
} from "@osstack/governance";

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 5_000_000;
const GIT_PATH_OUTPUT_LIMIT = 16_000_000;

export interface ReviewBoundaryPolicy {
  forbidden_paths: string[];
  max_file_bytes: number;
  max_total_bytes: number;
  allowed_extensions: string[];
}

export interface CollectedReviewBoundary {
  boundary: ReviewBoundaryResult;
  sanitized_diff?: string;
}

export const DEFAULT_REVIEW_BOUNDARY_POLICY: Readonly<ReviewBoundaryPolicy> = {
  forbidden_paths: [".env", ".git", ".ssh", ".aws", ".config"],
  max_file_bytes: DEFAULT_MAX_FILE_BYTES,
  max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
  allowed_extensions: [".ts", ".tsx", ".js", ".json", ".md", ".yaml", ".yml"],
};

export async function collectReviewBoundary(
  workspacePath: string,
  overrides: Partial<ReviewBoundaryPolicy> = {},
): Promise<CollectedReviewBoundary> {
  const policy: ReviewBoundaryPolicy = {
    ...DEFAULT_REVIEW_BOUNDARY_POLICY,
    ...overrides,
  };
  validatePolicy(policy);
  const workspace = await realpath(resolve(workspacePath));

  const [trackedOutput, untrackedOutput] = await Promise.all([
    execGit(
      workspace,
      ["diff", "--name-only", "-z", "HEAD", "--"],
      GIT_PATH_OUTPUT_LIMIT,
    ),
    execGit(
      workspace,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      GIT_PATH_OUTPUT_LIMIT,
    ),
  ]);
  const trackedPaths = parseNullDelimited(trackedOutput);
  const untrackedPaths = parseNullDelimited(untrackedOutput);
  const changedPaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();
  const files = await Promise.all(changedPaths.map((path) => collectFile(
    workspace,
    path,
    policy,
  )));

  let trackedDiff: Buffer = Buffer.alloc(0);
  let rawDiffTooLarge = false;
  try {
    trackedDiff = await execGit(
      workspace,
      ["diff", "--binary", "HEAD", "--"],
      Math.max(policy.max_total_bytes + 1, 1_024),
    );
  } catch (error) {
    if (!(error instanceof GitOutputTooLargeError)) throw error;
    rawDiffTooLarge = true;
  }

  const untrackedSections = untrackedPaths.map((path) => {
    const file = files.find((candidate) => candidate.path === path);
    if (file?.kind === "text" && file.content !== undefined) {
      return [
        `<UNTRACKED_FILE path=${JSON.stringify(path)}>`,
        file.content,
        "</UNTRACKED_FILE>",
      ].join("\n");
    }
    if (file?.is_symlink === true) {
      return `<UNTRACKED_SYMLINK path=${JSON.stringify(path)}>`;
    }
    return `<UNTRACKED_UNREAD path=${JSON.stringify(path)}>`;
  });
  const candidateDiff = [
    trackedDiff.toString("utf8"),
    ...untrackedSections,
  ].filter((part) => part !== "").join("\n");
  const diffBytes = rawDiffTooLarge
    ? policy.max_total_bytes + 1
    : Buffer.byteLength(candidateDiff, "utf8");

  const boundary = evaluateReviewBoundary({
    workspace_path: workspace,
    changed_paths: changedPaths,
    files,
    diff_bytes: diffBytes,
    ...(rawDiffTooLarge ? {} : { diff_content: candidateDiff }),
    forbidden_paths: policy.forbidden_paths,
    max_file_bytes: policy.max_file_bytes,
    max_total_bytes: policy.max_total_bytes,
    allowed_extensions: policy.allowed_extensions,
  });
  if (!boundary.pass) return { boundary };
  return { boundary, sanitized_diff: candidateDiff };
}

async function collectFile(
  workspace: string,
  path: string,
  policy: ReviewBoundaryPolicy,
): Promise<ReviewBoundaryFile> {
  const lexical = resolve(workspace, path);
  if (!isInside(workspace, lexical) || isAbsoluteRepositoryPath(path)) {
    return {
      path,
      resolved_path: lexical,
      size_bytes: 0,
      kind: "unread",
      is_symlink: false,
    };
  }

  let metadata;
  try {
    metadata = await lstat(lexical);
  } catch (error) {
    if (isMissing(error)) {
      return {
        path,
        resolved_path: lexical,
        size_bytes: 0,
        kind: "text",
        content: "",
        is_symlink: false,
      };
    }
    return {
      path,
      resolved_path: lexical,
      size_bytes: 0,
      kind: "unread",
      is_symlink: false,
    };
  }

  const isSymlink = metadata.isSymbolicLink();
  let resolvedPath = lexical;
  try {
    resolvedPath = await realpath(lexical);
  } catch {
    // Keep the lexical path; the unread entry will fail closed if otherwise unsafe.
  }

  const base: ReviewBoundaryFile = {
    path,
    resolved_path: resolvedPath,
    size_bytes: metadata.size,
    kind: "unread",
    is_symlink: isSymlink,
  };
  if (isSymlink) return base;
  if (!metadata.isFile()) return { ...base, kind: "binary" };
  if (!isInside(workspace, resolvedPath)) return base;
  if (metadata.size > policy.max_file_bytes) return base;
  if (!isAllowedExtension(path, policy.allowed_extensions)) return base;
  if (isForbidden(path, policy.forbidden_paths)) return base;

  const bytes = await readFile(lexical);
  if (bytes.includes(0)) return { ...base, kind: "binary" };
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ...base, kind: "text", content };
  } catch {
    return { ...base, kind: "binary" };
  }
}

function execGit(
  workspace: string,
  args: readonly string[],
  maxBuffer: number,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: workspace,
        encoding: "buffer",
        maxBuffer,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            || /maxBuffer/.test(error.message)
          ) {
            reject(new GitOutputTooLargeError());
            return;
          }
          reject(new Error(
            `git ${args[0] ?? "command"} failed: ${safeGitError(stderr)}`,
            { cause: error },
          ));
          return;
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function parseNullDelimited(output: Buffer): string[] {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw new Error("git returned a non-UTF-8 changed path", { cause: error });
  }
  if (value === "") return [];
  const parts = value.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function validatePolicy(policy: ReviewBoundaryPolicy): void {
  if (!Number.isSafeInteger(policy.max_file_bytes) || policy.max_file_bytes <= 0) {
    throw new Error("review boundary max_file_bytes must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.max_total_bytes) || policy.max_total_bytes <= 0) {
    throw new Error("review boundary max_total_bytes must be a positive integer");
  }
  if (policy.allowed_extensions.length === 0) {
    throw new Error("review boundary requires at least one allowed extension");
  }
}

function isAllowedExtension(path: string, allowed: readonly string[]): boolean {
  const extension = extname(path).toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === extension);
}

function isForbidden(path: string, forbiddenPaths: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  return forbiddenPaths.some((candidate) => {
    const forbidden = candidate.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
    return normalized === forbidden
      || normalized.startsWith(`${forbidden}/`)
      || normalized.endsWith(`/${forbidden}`)
      || normalized.includes(`/${forbidden}/`);
  });
}

function isAbsoluteRepositoryPath(path: string): boolean {
  return isAbsolute(path)
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.replaceAll("\\", "/").split("/").includes("..");
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

function safeGitError(stderr: string | Buffer): string {
  return String(stderr).replace(/\s+/g, " ").trim().slice(0, 300);
}

class GitOutputTooLargeError extends Error {
  constructor() {
    super("git output exceeded review boundary");
    this.name = "GitOutputTooLargeError";
  }
}
