import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgePack, KnowledgePackManifest, KnowledgeSearchResult } from "./types.js";

export async function loadKnowledgePack(path: string): Promise<KnowledgePack> {
  const pathStat = await stat(path);
  const manifestPath = pathStat.isDirectory() ? join(path, "manifest.json") : path;
  const raw = await readFile(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const manifest = validateKnowledgePackManifest(parsed);
  return { manifest, path: manifestPath };
}

export function validateKnowledgePackManifest(value: unknown): KnowledgePackManifest {
  if (!isRecord(value)) throw new Error("knowledge pack manifest must be an object");
  const id = requiredString(value, "id");
  const version = requiredString(value, "version");
  const name = requiredString(value, "name");
  const license = requiredString(value, "license");
  const sourceKind = requiredString(value, "source_kind");
  if (!["osstack_native", "processed_mit", "curated_external", "internal"].includes(sourceKind)) {
    throw new Error("knowledge pack source_kind is invalid");
  }
  const qualityScore = requiredNumber(value, "quality_score");
  if (qualityScore < 0 || qualityScore > 100) {
    throw new Error("knowledge pack quality_score must be between 0 and 100");
  }
  const chunksRaw = value["chunks"];
  if (!Array.isArray(chunksRaw)) throw new Error("knowledge pack chunks must be an array");
  const chunks = chunksRaw.map((chunk, index) => {
    if (!isRecord(chunk)) throw new Error(`knowledge chunk at index ${index} must be an object`);
    const normalized = {
      chunk_id: requiredString(chunk, "chunk_id"),
      title: requiredString(chunk, "title"),
      body: requiredString(chunk, "body"),
    };
    const tags = optionalStringArray(chunk, "tags");
    const sourceRefs = optionalStringArray(chunk, "source_refs");
    return {
      ...normalized,
      ...(tags === undefined ? {} : { tags }),
      ...(sourceRefs === undefined ? {} : { source_refs: sourceRefs }),
    };
  });
  const generatedAt = optionalString(value, "generated_at");
  const sourceAttribution = optionalStringArray(value, "source_attribution");
  return {
    id,
    version,
    name,
    license,
    source_kind: sourceKind as KnowledgePackManifest["source_kind"],
    quality_score: qualityScore,
    ...(generatedAt === undefined ? {} : { generated_at: generatedAt }),
    ...(sourceAttribution === undefined ? {} : { source_attribution: sourceAttribution }),
    chunks,
  };
}

export function searchKnowledgePacks(
  packs: KnowledgePack[],
  query: string,
  options: { limit?: number } = {},
): KnowledgeSearchResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const results: KnowledgeSearchResult[] = [];
  for (const pack of packs) {
    for (const chunk of pack.manifest.chunks) {
      const haystack = `${chunk.title} ${chunk.body} ${(chunk.tags ?? []).join(" ")}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + countOccurrences(haystack, term), 0);
      if (score === 0) continue;
      results.push({
        pack_id: pack.manifest.id,
        pack_version: pack.manifest.version,
        chunk_id: chunk.chunk_id,
        title: chunk.title,
        score,
        snippet: snippetFor(chunk.body, terms),
        tags: chunk.tags ?? [],
        source_refs: chunk.source_refs ?? [],
      });
    }
  }
  return results
    .sort((a, b) => b.score - a.score || a.pack_id.localeCompare(b.pack_id) || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, options.limit ?? 5);
}

export function assembleKnowledgeSnippet(results: KnowledgeSearchResult[]): string {
  return results.map((result) => [
    `# ${result.title}`,
    `pack=${result.pack_id}@${result.pack_version} chunk=${result.chunk_id} score=${result.score}`,
    result.snippet,
  ].join("\n")).join("\n\n");
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fa5]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0) {
    count++;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function snippetFor(body: string, terms: string): string;
function snippetFor(body: string, terms: string[]): string;
function snippetFor(body: string, terms: string | string[]): string {
  const termList = Array.isArray(terms) ? terms : [terms];
  const lower = body.toLowerCase();
  const firstMatch = termList
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - 80);
  const end = Math.min(body.length, firstMatch + 220);
  return body.slice(start, end).replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`knowledge pack ${key} must be a non-empty string`);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`knowledge pack ${key} must be a non-empty string`);
  }
  return field;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`knowledge pack ${key} must be a finite number`);
  }
  return field;
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
    throw new Error(`knowledge pack ${key} must be an array of strings`);
  }
  return field;
}
