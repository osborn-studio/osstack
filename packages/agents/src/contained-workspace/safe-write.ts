import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

export const SAFE_FILE_ERROR_CODES = [
  "SAFE_PATH_INVALID",
  "SAFE_ROOT_INVALID",
  "SAFE_PATH_SYMLINK_COMPONENT",
  "SAFE_PATH_NOT_DIRECTORY",
  "SAFE_PATH_SYMLINK",
  "SAFE_PATH_HARDLINK",
  "SAFE_PATH_NOT_REGULAR",
  "SAFE_PATH_NOT_FOUND",
  "SAFE_PATH_ESCAPED",
  "SAFE_WRITE_VERIFY_MISMATCH",
] as const;
export type SafeFileErrorCode = (typeof SAFE_FILE_ERROR_CODES)[number];

export class SafeFileError extends Error {
  constructor(
    readonly code: SafeFileErrorCode,
    readonly relPath: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${relPath}: ${detail}` : `${code}: ${relPath}`);
    this.name = "SafeFileError";
  }
}

export interface SafeFileResult {
  path: string;
  sha256: string;
  size: number;
}
export interface SafeReadResult extends SafeFileResult {
  bytes: Buffer;
  executable: boolean;
}

const IGNORABLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
const MAX_PATH_LENGTH = 4096;

/** Split a repository-relative path into segments, or throw SAFE_PATH_INVALID. */
export function safeRelativePathSegments(relPath: string): string[] {
  const invalid = (detail: string) => new SafeFileError("SAFE_PATH_INVALID", relPath, detail);
  if (typeof relPath !== "string" || relPath === "") throw invalid("empty");
  if (relPath.length > MAX_PATH_LENGTH) throw invalid("too long");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject
  if (/[\u0000-\u001f\u007f]/.test(relPath)) throw invalid("control character");
  if (relPath.includes("\\")) throw invalid("backslash");
  if (relPath.startsWith("/")) throw invalid("absolute");
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "") throw invalid("empty segment");
    if (segment === "." || segment === "..") throw invalid("dot segment");
    if (Buffer.byteLength(segment) > 255) throw invalid("segment too long");
    if (segment.replace(IGNORABLE, "").replace(/[. ]+$/, "").toLowerCase() === ".git") throw invalid(".git segment");
  }
  return segments;
}

async function resolveRoot(root: string): Promise<string> {
  try {
    const real = await realpath(root);
    if ((await lstat(real)).isDirectory()) return real;
  } catch {
    // fall through
  }
  throw new SafeFileError("SAFE_ROOT_INVALID", root);
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function walkParents(root: string, relPath: string, segments: readonly string[], create: boolean): Promise<string> {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let stat = await lstatOrUndefined(current);
    if (!stat) {
      if (!create) throw new SafeFileError("SAFE_PATH_NOT_FOUND", relPath);
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink()) throw new SafeFileError("SAFE_PATH_SYMLINK_COMPONENT", relPath, segment);
    if (!stat.isDirectory()) throw new SafeFileError("SAFE_PATH_NOT_DIRECTORY", relPath, segment);
  }
  return current;
}

async function assertContained(root: string, parent: string, relPath: string): Promise<void> {
  const real = await realpath(parent);
  if (real !== parent || (real !== root && !real.startsWith(root + sep))) throw new SafeFileError("SAFE_PATH_ESCAPED", relPath);
}

function checkExisting(stat: Awaited<ReturnType<typeof lstat>>, relPath: string): void {
  if (stat.isSymbolicLink()) throw new SafeFileError("SAFE_PATH_SYMLINK", relPath);
  if (!stat.isFile()) throw new SafeFileError("SAFE_PATH_NOT_REGULAR", relPath);
  if (stat.nlink > 1) throw new SafeFileError("SAFE_PATH_HARDLINK", relPath);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readNoFollow(path: string, relPath: string): Promise<{ bytes: Buffer; mode: number }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new SafeFileError("SAFE_PATH_SYMLINK", relPath);
    if (code === "ENOENT") throw new SafeFileError("SAFE_PATH_NOT_FOUND", relPath);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SafeFileError("SAFE_PATH_NOT_REGULAR", relPath);
    if (stat.nlink > 1) throw new SafeFileError("SAFE_PATH_HARDLINK", relPath);
    return { bytes: await handle.readFile(), mode: stat.mode };
  } finally {
    await handle.close();
  }
}

/**
 * Write `content` to `root/relPath` without following symlinks: every parent
 * component is lstat-checked (and created one level at a time), the data goes
 * to a same-directory temp file that is fsynced and renamed into place, and the
 * result is re-read and compared by sha256.
 */
export async function safeWriteFile(root: string, relPath: string, content: Uint8Array | string, mode = 0o644): Promise<SafeFileResult> {
  const segments = safeRelativePathSegments(relPath);
  const base = await resolveRoot(root);
  const parent = await walkParents(base, relPath, segments, true);
  await assertContained(base, parent, relPath);
  const target = join(parent, segments.at(-1) as string);
  const existing = await lstatOrUndefined(target);
  if (existing) checkExisting(existing, relPath);
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const expected = sha256(bytes);
  const temp = join(parent, `.osstack-write-${randomBytes(8).toString("hex")}.tmp`);
  const fileMode = mode & 0o777;
  let renamed = false;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fileMode);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(fileMode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
  await syncDirectory(parent);
  await assertContained(base, dirname(target), relPath);
  const written = await readNoFollow(target, relPath);
  if (sha256(written.bytes) !== expected) throw new SafeFileError("SAFE_WRITE_VERIFY_MISMATCH", relPath);
  return { path: target, sha256: expected, size: bytes.length };
}

/** Remove the regular file at `root/relPath`; refuses symlinks, hard links and symlinked parents. */
export async function safeRemoveFile(root: string, relPath: string): Promise<void> {
  const segments = safeRelativePathSegments(relPath);
  const base = await resolveRoot(root);
  const parent = await walkParents(base, relPath, segments, false);
  await assertContained(base, parent, relPath);
  const target = join(parent, segments.at(-1) as string);
  const existing = await lstatOrUndefined(target);
  if (!existing) throw new SafeFileError("SAFE_PATH_NOT_FOUND", relPath);
  checkExisting(existing, relPath);
  await unlink(target);
  await syncDirectory(parent);
}

/** Read the regular file at `root/relPath` under the same component checks as {@link safeWriteFile}. */
export async function safeReadFile(root: string, relPath: string): Promise<SafeReadResult> {
  const segments = safeRelativePathSegments(relPath);
  const base = await resolveRoot(root);
  const parent = await walkParents(base, relPath, segments, false);
  await assertContained(base, parent, relPath);
  const target = join(parent, segments.at(-1) as string);
  const { bytes, mode } = await readNoFollow(target, relPath);
  return { path: target, bytes, sha256: sha256(bytes), size: bytes.length, executable: (mode & 0o100) !== 0 };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY).catch(() => undefined);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close();
}
