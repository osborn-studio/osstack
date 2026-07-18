import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  KnowledgeSurfaceInventoryV1,
  type KnowledgeSurfaceInventoryEntryV1,
} from "../types.js";
import {
  createRuleFinding,
  findingEvidence,
  type KnowledgeHygieneRuleV1,
} from "../rules/rule-types.js";
import type {
  AdapterDetectionInputV1,
  AdapterDetectionV1,
  AdapterInventoryInputV1,
  KnowledgeSurfaceAdapterV1,
} from "./adapter-contract.js";

export const CLAUDE_CODE_MEMORY_DOCUMENTATION =
  "https://code.claude.com/docs/en/memory";
export const CLAUDE_CODE_MEMORY_ADAPTER_ID = "claude-code";
export const CLAUDE_CODE_MEMORY_ADAPTER_VERSION = "1";
export const CLAUDE_CODE_MEMORY_INDEX_MAX_LINES = 200;
export const CLAUDE_CODE_MEMORY_INDEX_MAX_BYTES = 25 * 1024;

const MAX_ADAPTER_FILES = 1_000;
const MAX_ADAPTER_FILE_BYTES = 2 * 1024 * 1024;

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

function logicalLineCount(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n?/g, "\n");
  const parts = normalized.split("\n");
  return normalized.endsWith("\n") ? parts.length - 1 : parts.length;
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
    throw new Error("Claude Code memory directory must be absolute or start with ~/");
  }
  return resolve(configured);
}

function portablePath(name: string): string {
  return `claude-code://auto-memory/${name}`;
}

const adapterMetadata = {
  id: CLAUDE_CODE_MEMORY_ADAPTER_ID,
  version: CLAUDE_CODE_MEMORY_ADAPTER_VERSION,
  source: CLAUDE_CODE_MEMORY_DOCUMENTATION,
} as const;

export const CLAUDE_CODE_MEMORY_LIMIT_RULE_V1: KnowledgeHygieneRuleV1 = {
  id: "memory.platform_limit_exceeded",
  version: "1",
  default_severity: "warning",
  evaluate(input) {
    const index = input.inventory.surfaces.find(
      (surface) => surface.adapter?.id === CLAUDE_CODE_MEMORY_ADAPTER_ID
        && surface.path === portablePath("MEMORY.md"),
    );
    if (!index?.exists) return [];
    const exceeded = (
      index.lines !== undefined
      && index.lines > CLAUDE_CODE_MEMORY_INDEX_MAX_LINES
    ) || (
      index.bytes !== undefined
      && index.bytes > CLAUDE_CODE_MEMORY_INDEX_MAX_BYTES
    );
    if (!exceeded) return [];
    return [createRuleFinding(this, input, {
      path: index.path,
      anchor: "claude-code:memory-index-limit",
      surface: "memory",
      severity: "warning",
      confidence: "high",
      observed: {
        adapter_id: CLAUDE_CODE_MEMORY_ADAPTER_ID,
        adapter_version: CLAUDE_CODE_MEMORY_ADAPTER_VERSION,
        evidence_source: CLAUDE_CODE_MEMORY_DOCUMENTATION,
        lines: index.lines ?? null,
        bytes: index.bytes ?? null,
      },
      expected: {
        platform: "claude-code",
        maximum: {
          lines: CLAUDE_CODE_MEMORY_INDEX_MAX_LINES,
          bytes: CLAUDE_CODE_MEMORY_INDEX_MAX_BYTES,
        },
      },
      rationale: "Claude Code loads only the first 200 lines or 25KB of MEMORY.md at conversation start.",
      evidence_refs: [
        ...findingEvidence(index),
        { kind: "external", ref: CLAUDE_CODE_MEMORY_DOCUMENTATION },
      ],
      remediation: { mode: "human_decision" },
    })];
  },
};

async function detect(
  input: AdapterDetectionInputV1,
): Promise<AdapterDetectionV1> {
  const root = configuredRoot(input);
  const common = {
    adapter_id: CLAUDE_CODE_MEMORY_ADAPTER_ID,
    adapter_version: CLAUDE_CODE_MEMORY_ADAPTER_VERSION,
    evidence_source: {
      kind: "official_documentation" as const,
      ref: CLAUDE_CODE_MEMORY_DOCUMENTATION,
    },
  };
  if (root === undefined) return { ...common, status: "absent" };
  try {
    const metadata = await stat(root);
    if (!metadata.isDirectory()) return { ...common, status: "absent" };
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
  if (root === undefined) throw new Error("Claude Code adapter root is unavailable");
  const entries = (await readdir(root, { withFileTypes: true }))
    .sort((left, right) => {
      if (left.name === "MEMORY.md") return -1;
      if (right.name === "MEMORY.md") return 1;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
  const surfaces: KnowledgeSurfaceInventoryEntryV1[] = [];
  const reasons: string[] = [];
  let skippedFiles = 0;
  let recognized = 0;
  let hasMemoryIndex = false;

  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    recognized += 1;
    if (recognized > MAX_ADAPTER_FILES) {
      skippedFiles += 1;
      if (!reasons.includes(`Claude Code memory file limit exceeded: ${MAX_ADAPTER_FILES}`)) {
        reasons.push(`Claude Code memory file limit exceeded: ${MAX_ADAPTER_FILES}`);
      }
      continue;
    }
    if (entry.name === "MEMORY.md") hasMemoryIndex = true;
    const path = portablePath(entry.name);
    if (!entry.isFile()) {
      skippedFiles += 1;
      reasons.push(`Claude Code memory entry skipped: ${path}`);
      continue;
    }
    const absolutePath = join(root, entry.name);
    const metadata = await stat(absolutePath);
    if (metadata.size > MAX_ADAPTER_FILE_BYTES) {
      skippedFiles += 1;
      reasons.push(`Claude Code memory read limit exceeded: ${path}`);
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
    surfaces.push({
      surface: "memory",
      path,
      kind: "file",
      exists: true,
      bytes: buffer.byteLength,
      lines: logicalLineCount(buffer.toString("utf8")),
      sha256: createHash("sha256").update(buffer).digest("hex"),
      adapter: adapterMetadata,
    });
  }

  if (!hasMemoryIndex) {
    surfaces.unshift({
      surface: "memory",
      path: portablePath("MEMORY.md"),
      kind: "file",
      exists: false,
      adapter: adapterMetadata,
    });
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

/**
 * Read-only Claude Code auto-memory adapter.
 * Source: https://code.claude.com/docs/en/memory
 *
 * The documentation does not publish the <project> directory encoding, so the
 * adapter accepts exactly one explicit directory and never enumerates siblings.
 */
export const CLAUDE_CODE_MEMORY_ADAPTER_V1: KnowledgeSurfaceAdapterV1 =
  Object.freeze({
    id: CLAUDE_CODE_MEMORY_ADAPTER_ID,
    version: CLAUDE_CODE_MEMORY_ADAPTER_VERSION,
    capabilities: ["read"] as const,
    detect,
    inventory,
    rules: () => [CLAUDE_CODE_MEMORY_LIMIT_RULE_V1],
  });
