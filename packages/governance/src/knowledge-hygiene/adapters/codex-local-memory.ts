import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  KnowledgeSurfaceInventoryV1,
  type KnowledgeSurfaceInventoryEntryV1,
} from "../types.js";
import type {
  AdapterDetectionInputV1,
  AdapterDetectionV1,
  AdapterInventoryInputV1,
  KnowledgeSurfaceAdapterV1,
} from "./adapter-contract.js";

export const CODEX_LOCAL_MEMORY_DOCUMENTATION =
  "https://learn.chatgpt.com/docs/customization/memories.md";
export const CODEX_LOCAL_MEMORY_ADAPTER_ID = "codex-local";
export const CODEX_LOCAL_MEMORY_ADAPTER_VERSION = "1";

const MAX_ADAPTER_FILES = 1_000;
const MAX_ADAPTER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ADAPTER_DEPTH = 16;
const MAX_ADAPTER_ENTRIES = 5_000;

const optionsSchema = z.object({
  memory_directory: z.string().min(1).optional(),
  home_directory: z.string().min(1).optional(),
}).passthrough();

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function configuredRoot(input: AdapterDetectionInputV1): string | undefined {
  const options = optionsSchema.parse(input.options);
  const configured = options.memory_directory;
  if (configured === undefined) return undefined;
  if (configured.startsWith("~/")) {
    if (options.home_directory === undefined) return undefined;
    return resolve(options.home_directory, configured.slice(2));
  }
  if (!isAbsolute(configured)) {
    throw new Error(
      "Codex local memory directory must be absolute or start with ~/",
    );
  }
  return resolve(configured);
}

function portablePath(relativePath: string): string {
  return `codex-local://generated-memory/${relativePath}`;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== ".."
      && !isAbsolute(pathFromRoot));
}

const adapterMetadata = {
  id: CODEX_LOCAL_MEMORY_ADAPTER_ID,
  version: CODEX_LOCAL_MEMORY_ADAPTER_VERSION,
  source: CODEX_LOCAL_MEMORY_DOCUMENTATION,
} as const;

async function detect(
  input: AdapterDetectionInputV1,
): Promise<AdapterDetectionV1> {
  const root = configuredRoot(input);
  const common = {
    adapter_id: CODEX_LOCAL_MEMORY_ADAPTER_ID,
    adapter_version: CODEX_LOCAL_MEMORY_ADAPTER_VERSION,
    evidence_source: {
      kind: "official_documentation" as const,
      ref: CODEX_LOCAL_MEMORY_DOCUMENTATION,
    },
  };
  if (root === undefined) return { ...common, status: "absent" };
  try {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { ...common, status: "absent" };
    }
    return { ...common, status: "available", root };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ...common, status: "absent" };
    throw error;
  }
}

async function inventory(
  input: AdapterInventoryInputV1,
): Promise<KnowledgeSurfaceInventoryV1> {
  const root = input.detection.root;
  if (root === undefined) throw new Error("Codex local adapter root is unavailable");

  const surfaces: KnowledgeSurfaceInventoryEntryV1[] = [];
  const reasons: string[] = [];
  let recognizedFiles = 0;
  let skippedFiles = 0;
  let visitedEntries = 0;
  let traversalStopped = false;

  const skip = (reason: string): void => {
    skippedFiles += 1;
    reasons.push(reason);
  };

  let canonicalRoot: string;
  try {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      skip("Codex generated-memory root changed after detection");
      return KnowledgeSurfaceInventoryV1.parse({
        surfaces,
        completeness: { complete: false, skipped_files: skippedFiles, reasons },
      });
    }
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    skip("Codex generated-memory root disappeared after detection");
    return KnowledgeSurfaceInventoryV1.parse({
      surfaces,
      completeness: { complete: false, skipped_files: skippedFiles, reasons },
    });
  }

  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (traversalStopped) return;
    let resolvedDirectory: string;
    try {
      const metadata = await lstat(directory);
      resolvedDirectory = await realpath(directory);
      if (
        metadata.isSymbolicLink()
        || !metadata.isDirectory()
        || !isWithinRoot(canonicalRoot, resolvedDirectory)
      ) {
        skip(`Codex generated-memory directory traversal rejected: ${portablePath(relativeDirectory)}`);
        return;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      skip(`Codex generated-memory directory changed during read: ${portablePath(relativeDirectory)}`);
      return;
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_ADAPTER_ENTRIES) {
        skip(`Codex generated-memory entry limit exceeded: ${MAX_ADAPTER_ENTRIES}`);
        traversalStopped = true;
        return;
      }
      const relativePath = relativeDirectory === ""
        ? entry.name
        : posix.join(relativeDirectory, entry.name);
      const path = portablePath(relativePath);
      if (entry.isSymbolicLink()) {
        skip(`Codex generated-memory symlink skipped: ${path}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (depth >= MAX_ADAPTER_DEPTH) {
          skip(`Codex generated-memory depth limit exceeded: ${path}`);
          continue;
        }
        await visit(join(directory, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skip(`Codex generated-memory entry skipped: ${path}`);
        continue;
      }
      recognizedFiles += 1;
      if (recognizedFiles > MAX_ADAPTER_FILES) {
        skip(`Codex generated-memory file limit exceeded: ${MAX_ADAPTER_FILES}`);
        traversalStopped = true;
        return;
      }

      const absolutePath = join(directory, entry.name);
      let handle: FileHandle;
      try {
        handle = await open(
          absolutePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (!["ELOOP", "ENOENT"].includes(errorCode(error) ?? "")) throw error;
        skip(`Codex generated-memory entry changed during read: ${path}`);
        continue;
      }
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          skip(`Codex generated-memory entry changed during read: ${path}`);
          continue;
        }
        if (metadata.size > MAX_ADAPTER_FILE_BYTES) {
          skip(`Codex generated-memory read limit exceeded: ${path}`);
          surfaces.push({
            surface: "memory",
            path,
            kind: "file",
            exists: true,
            bytes: metadata.size,
            adapter: adapterMetadata,
          });
          continue;
        }
        const buffer = Buffer.alloc(metadata.size);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
          const result = await handle.read(
            buffer,
            bytesRead,
            buffer.byteLength - bytesRead,
            bytesRead,
          );
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        const boundedContent = buffer.subarray(0, bytesRead);
        surfaces.push({
          surface: "memory",
          path,
          kind: "file",
          exists: true,
          bytes: boundedContent.byteLength,
          sha256: createHash("sha256").update(boundedContent).digest("hex"),
          adapter: adapterMetadata,
        });
      } finally {
        await handle.close();
      }
    }
  };

  await visit(root, "", 0);
  return KnowledgeSurfaceInventoryV1.parse({
    surfaces,
    completeness: {
      complete: reasons.length === 0,
      skipped_files: skippedFiles,
      reasons,
    },
  });
}

/**
 * Read-only adapter for the local Codex generated-memory store.
 *
 * The store is generated state, so this adapter exposes metadata and hashes
 * only. It accepts one explicit root, never discovers sibling directories,
 * never emits file content, and deliberately exposes no mutation rules.
 * Source: https://learn.chatgpt.com/docs/customization/memories.md
 */
export const CODEX_LOCAL_MEMORY_ADAPTER_V1: KnowledgeSurfaceAdapterV1 =
  Object.freeze({
    id: CODEX_LOCAL_MEMORY_ADAPTER_ID,
    version: CODEX_LOCAL_MEMORY_ADAPTER_VERSION,
    capabilities: ["read"] as const,
    detect,
    inventory,
    rules: () => [],
  });
