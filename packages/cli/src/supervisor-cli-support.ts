// Shared helpers for the supervisor CLI command modules (supervise / feedback
// / improve / evaluator / adversarial / meta). Kept small and local so the
// command modules do not reach into bin.ts internals.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { openDb } from "@osstack/core";
import type Database from "better-sqlite3";
import { osstackHome } from "./paths.js";

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function flagAll(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      values.push(args[i + 1]!);
      i++;
    }
  }
  return values;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** First non-flag positional token (a bare value not consumed by a flag). */
export function firstPositional(args: string[], flagsWithValues: Set<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("--")) {
      if (flagsWithValues.has(token)) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * Registry path resolution (R1.6, plan §R1.6 step 2 — the portfolio registry is
 * machine-scoped, not repo-scoped):
 *   1. explicit `--registry P` wins;
 *   2. explicit `--workspace P` pins `P/.osstack/repos.json` (no fallback —
 *      naming a workspace means that workspace, absent file included);
 *   3. otherwise `cwd/.osstack/repos.json` when it exists (legacy repo-scoped);
 *   4. otherwise `$OSSTACK_HOME/repos.json` when it exists (machine-scoped);
 *   5. otherwise the legacy cwd default (callers treat an absent file as an
 *      empty registry, so this preserves pre-R1.6 behavior byte-for-byte).
 */
export function resolveRegistryPath(args: string[]): string {
  const explicit = flag(args, "--registry");
  if (explicit !== undefined) return isAbsolute(explicit) ? explicit : join(process.cwd(), explicit);
  const workspace = flag(args, "--workspace");
  if (workspace !== undefined) return join(workspace, ".osstack", "repos.json");
  const local = join(process.cwd(), ".osstack", "repos.json");
  if (existsSync(local)) return local;
  const machine = join(osstackHome(), "repos.json");
  if (existsSync(machine)) return machine;
  return local;
}

/** Open the local osstack state DB (creating the home dir), for read or write. */
export async function openStateDb(): Promise<{ db: Database.Database; dbPath: string }> {
  const home = osstackHome();
  await mkdir(home, { recursive: true });
  const dbPath = join(home, "state.db");
  return { db: openDb({ path: dbPath }), dbPath };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Convert an epoch-seconds timestamp to ISO for the supervisor domain shapes. */
export function epochToIso(seconds: number): string {
  return new Date(Math.round(seconds * 1000)).toISOString();
}
