// Version is read from package.json at module load — never hand-maintained.
// Works both from src/ (vitest) and from the tsup bundle at dist/bin.js,
// because in both cases package.json sits one directory up.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch { /* fall through */ }
  return "0.0.0";
}

export const VERSION: string = readPackageVersion();

/**
 * CLI↔daemon wire-protocol version. Bump on breaking changes to the framed
 * RPC contract; the CLI warns when the daemon reports a different major.
 */
export const PROTOCOL_VERSION = 1;

/** Compare two semver strings (no prerelease support needed yet). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
