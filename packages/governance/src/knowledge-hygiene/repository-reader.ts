import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { KnowledgeHygieneConfigV1 } from "./config.js";
import { assertKnowledgeHygieneRepositoryPathV1 } from "./path-pattern.js";
import {
  KnowledgeSurfaceInventoryV1,
  type KnowledgeHygieneSurfaceV1,
  type KnowledgeSurfaceInventoryEntryV1,
} from "./types.js";

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".pnpm",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
]);

export interface KnowledgeSurfaceInventoryLimitsV1 {
  max_files?: number;
  max_file_bytes?: number;
  max_total_bytes?: number;
}

export interface InventoryKnowledgeSurfacesInputV1 {
  repo_root: string;
  config?: KnowledgeHygieneConfigV1;
  limits?: KnowledgeSurfaceInventoryLimitsV1;
}

interface CandidateSurface {
  path: string;
  expected_kind: "file" | "directory";
  surface: KnowledgeHygieneSurfaceV1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("inventory limits must be positive integers");
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logicalLineCount(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n?/g, "\n");
  const parts = normalized.split("\n");
  return normalized.endsWith("\n") ? parts.length - 1 : parts.length;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function isExactPath(pattern: string): boolean {
  return !pattern.includes("*");
}

function instructionPaths(config: KnowledgeHygieneConfigV1 | undefined): Set<string> {
  const paths = new Set(["AGENTS.md", "CLAUDE.md"]);
  if (config?.instructions) {
    paths.add(config.instructions.canonical);
    for (const mirror of config.instructions.mirrors) paths.add(mirror.path);
  }
  return paths;
}

function configuredCandidates(
  config: KnowledgeHygieneConfigV1 | undefined,
): Array<{ path: string; kind: "file" | "directory" }> {
  if (!config) return [];
  const candidates: Array<{ path: string; kind: "file" | "directory" }> = [];
  if (config.instructions) {
    candidates.push({ path: config.instructions.canonical, kind: "file" });
    for (const mirror of config.instructions.mirrors) {
      candidates.push({ path: mirror.path, kind: "file" });
    }
  }
  for (const surface of config.required_surfaces) {
    candidates.push({ path: surface.path, kind: surface.kind });
  }
  for (const budget of config.budgets) {
    candidates.push({ path: budget.path, kind: "file" });
  }
  for (const contract of config.contracts) {
    for (const path of contract.review.any_path) {
      if (isExactPath(path)) candidates.push({ path, kind: "file" });
    }
  }
  for (const ignore of config.ignore) {
    for (const path of ignore.paths) {
      if (isExactPath(path)) candidates.push({ path, kind: "file" });
    }
  }
  return candidates;
}

export async function inventoryKnowledgeSurfaces(
  input: InventoryKnowledgeSurfacesInputV1,
): Promise<KnowledgeSurfaceInventoryV1> {
  const repoRoot = await realpath(resolve(input.repo_root));
  const maxFiles = positiveLimit(input.limits?.max_files, DEFAULT_MAX_FILES);
  const maxFileBytes = positiveLimit(
    input.limits?.max_file_bytes,
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxTotalBytes = positiveLimit(
    input.limits?.max_total_bytes,
    DEFAULT_MAX_TOTAL_BYTES,
  );
  const canonicalPaths = instructionPaths(input.config);
  const candidates = new Map<string, CandidateSurface>();
  const reasons: string[] = [];
  let skippedFiles = 0;
  let limitReached = false;

  const addReason = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const addCandidate = (
    path: string,
    expectedKind: "file" | "directory" = "file",
  ): void => {
    if (candidates.has(path)) return;
    assertKnowledgeHygieneRepositoryPathV1(path);
    if (candidates.size >= maxFiles) {
      if (!limitReached) {
        limitReached = true;
        skippedFiles += 1;
        addReason(`recognized file limit exceeded: ${maxFiles}`);
      }
      return;
    }
    candidates.set(path, {
      path,
      expected_kind: expectedKind,
      surface: canonicalPaths.has(path) ? "instruction" : "documentation",
    });
  };

  for (const candidate of configuredCandidates(input.config)) {
    addCandidate(candidate.path, candidate.kind);
  }

  try {
    const rootEntries = await readdir(repoRoot, { withFileTypes: true });
    for (const entry of rootEntries.sort((left, right) => compareText(left.name, right.name))) {
      if (
        entry.name === "AGENTS.md" ||
        entry.name === "CLAUDE.md" ||
        /^README.*\.md$/i.test(entry.name)
      ) {
        addCandidate(entry.name);
      }
    }
  } catch (error) {
    addReason(`repository root unreadable: ${errorMessage(error)}`);
  }

  const walkDocs = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    let metadata: Stats;
    try {
      metadata = await lstat(absoluteDirectory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      addReason(`directory unreadable: ${relativeDirectory}`);
      return;
    }
    if (metadata.isSymbolicLink()) {
      skippedFiles += 1;
      addReason(`symlink directory skipped: ${relativeDirectory}`);
      return;
    }
    if (!metadata.isDirectory()) return;

    let entries: Dirent[];
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      addReason(`directory unreadable: ${relativeDirectory}`);
      return;
    }
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      if (limitReached) return;
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await walkDocs(resolve(absoluteDirectory, entry.name), relativePath);
        }
      } else if (entry.isSymbolicLink()) {
        if (entry.name.toLowerCase().endsWith(".md")) addCandidate(relativePath);
        else {
          skippedFiles += 1;
          addReason(`symlink entry skipped: ${relativePath}`);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        addCandidate(relativePath);
      }
    }
  };
  await walkDocs(resolve(repoRoot, "docs"), "docs");

  const surfaces: KnowledgeSurfaceInventoryEntryV1[] = [];
  let totalBytes = 0;
  for (const candidate of [...candidates.values()].sort((left, right) =>
    compareText(left.path, right.path))) {
    const absolutePath = resolve(repoRoot, candidate.path);
    if (!isInsideRoot(repoRoot, absolutePath)) {
      skippedFiles += 1;
      addReason(`path outside repository skipped: ${candidate.path}`);
      continue;
    }

    let metadata: Stats;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        surfaces.push({
          surface: candidate.surface,
          path: candidate.path,
          kind: candidate.expected_kind,
          exists: false,
        });
        continue;
      }
      skippedFiles += 1;
      addReason(`surface unreadable: ${candidate.path}`);
      continue;
    }

    if (metadata.isSymbolicLink()) {
      let target: string;
      try {
        target = await readlink(absolutePath);
      } catch {
        skippedFiles += 1;
        addReason(`surface unreadable: ${candidate.path}`);
        continue;
      }
      const bytes = Buffer.byteLength(target, "utf8");
      surfaces.push({
        surface: candidate.surface,
        path: candidate.path,
        kind: "file",
        exists: true,
        bytes,
        lines: logicalLineCount(target),
        sha256: createHash("sha256").update(target).digest("hex"),
        link_target: target,
      });
      if (candidate.expected_kind === "directory") {
        addReason(`symlink directory skipped: ${candidate.path}`);
      }
      continue;
    }
    if (metadata.isDirectory()) {
      surfaces.push({
        surface: candidate.surface,
        path: candidate.path,
        kind: "directory",
        exists: true,
      });
      continue;
    }
    if (!metadata.isFile()) {
      skippedFiles += 1;
      addReason(`unsupported surface type: ${candidate.path}`);
      continue;
    }
    if (metadata.size > maxFileBytes) {
      skippedFiles += 1;
      addReason(`file byte limit exceeded: ${candidate.path}`);
      surfaces.push({
        surface: candidate.surface,
        path: candidate.path,
        kind: "file",
        exists: true,
        bytes: metadata.size,
      });
      continue;
    }
    if (totalBytes + metadata.size > maxTotalBytes) {
      skippedFiles += 1;
      addReason(`total byte limit exceeded at: ${candidate.path}`);
      continue;
    }

    try {
      const handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let buffer: Buffer;
      try {
        buffer = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (buffer.byteLength > maxFileBytes) {
        skippedFiles += 1;
        addReason(`file byte limit exceeded: ${candidate.path}`);
        continue;
      }
      if (totalBytes + buffer.byteLength > maxTotalBytes) {
        skippedFiles += 1;
        addReason(`total byte limit exceeded at: ${candidate.path}`);
        continue;
      }
      totalBytes += buffer.byteLength;
      const content = buffer.toString("utf8");
      surfaces.push({
        surface: candidate.surface,
        path: candidate.path,
        kind: "file",
        exists: true,
        bytes: buffer.byteLength,
        lines: logicalLineCount(content),
        sha256: createHash("sha256").update(buffer).digest("hex"),
        content,
      });
    } catch {
      skippedFiles += 1;
      addReason(`surface unreadable: ${candidate.path}`);
    }
  }

  return KnowledgeSurfaceInventoryV1.parse({
    surfaces,
    completeness: {
      complete: reasons.length === 0,
      skipped_files: skippedFiles,
      reasons,
    },
  });
}
