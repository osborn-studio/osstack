// Repo registry — the durable list of repos the control plane supervises.
// A plain JSON file (default `.osstack/repos.json`), Zod-validated on read
// and pretty-printed on write. Upsert is keyed by repo_id.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RepoRegistryEntry } from "./types.js";

/** Input accepted by upsert — schema defaults fill the rest. */
export type RepoRegistryEntryInput = {
  repo_id: string;
  name: string;
  path: string;
  role: RepoRegistryEntry["role"];
  owner?: string;
  priority?: number;
  verify_commands?: string[];
  loop_doc_path?: string;
  enabled?: boolean;
};

/** Read the registry. A missing file is an empty registry, not an error. */
export async function readRepoRegistry(path: string): Promise<RepoRegistryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => RepoRegistryEntry.parse(entry));
}

/** Write the registry, creating the parent directory if needed. */
export async function writeRepoRegistry(path: string, entries: RepoRegistryEntry[]): Promise<void> {
  const normalized = entries.map((entry) => RepoRegistryEntry.parse(entry));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

/** Upsert one entry by repo_id and persist. Returns the full registry. */
export async function addRepoRegistryEntry(
  path: string,
  entry: RepoRegistryEntryInput,
): Promise<RepoRegistryEntry[]> {
  const parsed = RepoRegistryEntry.parse(entry);
  const existing = await readRepoRegistry(path);
  const index = existing.findIndex((candidate) => candidate.repo_id === parsed.repo_id);
  if (index === -1) existing.push(parsed);
  else existing[index] = parsed;
  await writeRepoRegistry(path, existing);
  return existing;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
