// Single rule for every temporary directory osstack creates.
//
// Layout — one root, never beside the repository and never scattered across
// the system temp dir:
//
//   <root>/
//     worktrees/   `loop run --worktree` checkouts (default --worktree-root)
//     runtime/     short-lived hand-off files the CLI, daemon and adapters write
//     tests/       vitest workers (one directory per worker, removed on exit)
//     smoke/       scripts/*.mjs smoke, demo and eval workspaces
//
// <root> is $OSSTACK_SCRATCH_ROOT when set (absolute, or resolved against the
// current working directory), otherwise <os.tmpdir()>/osstack.
//
// Keep this module free of package imports: vitest setup files load it from
// source before anything is built, and scripts/lib/scratch.mjs mirrors it for
// scripts that run without a build.
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SCRATCH_ROOT_ENV = "OSSTACK_SCRATCH_ROOT";
export const SCRATCH_KINDS = ["worktrees", "runtime", "tests", "smoke"] as const;
export type ScratchKind = (typeof SCRATCH_KINDS)[number];
export type ScratchEnv = Readonly<Record<string, string | undefined>>;

/** Root directory that holds every osstack scratch directory. */
export function scratchRoot(env: ScratchEnv = process.env): string {
  const override = env[SCRATCH_ROOT_ENV]?.trim();
  return override ? resolve(override) : join(tmpdir(), "osstack");
}

/** `<root>/<kind>` — the parent every scratch directory of that kind lives in. */
export function scratchPath(kind: ScratchKind, env: ScratchEnv = process.env): string {
  return join(scratchRoot(env), kind);
}

/** Create a fresh `<root>/<kind>/<label>-XXXXXX` directory and return its path. */
export async function createScratchDir(
  kind: ScratchKind,
  label: string,
  env: ScratchEnv = process.env,
): Promise<string> {
  const parent = scratchPath(kind, env);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(parent, `${sanitizeLabel(label)}-`));
}

/** Synchronous twin of {@link createScratchDir} for setup code and scripts. */
export function createScratchDirSync(
  kind: ScratchKind,
  label: string,
  env: ScratchEnv = process.env,
): string {
  const parent = scratchPath(kind, env);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, `${sanitizeLabel(label)}-`));
}

function sanitizeLabel(label: string): string {
  const sanitized = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return sanitized === "" ? "scratch" : sanitized.slice(0, 48);
}
