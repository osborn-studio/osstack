import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// R0.5 conformance #5 — import-boundary test.
//
// ADR-001 §D3 makes it a rule that NO kernel consumer may import the osstack
// CLI product package (or parse its text output as an API). This package is a
// stand-in external consumer, so it must itself obey the rule. Two independent
// enforcement paths:
//   (a) no source file under src/ references the forbidden package specifier;
//   (b) package.json declares no dependency (of any kind) on it.
//
// The forbidden specifier is assembled from parts on purpose: it must NOT
// appear as a literal in any source file, otherwise this very scan would flag
// itself. Keeping the literal out of the tree is precisely the property (a)
// asserts.

const FORBIDDEN = ["@osstack", "cli"].join("/");
const srcDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(srcDir, "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Import boundary (ADR-001 §D3) — no osstack CLI product coupling", () => {
  it("no source file under src/ references the forbidden CLI specifier", () => {
    const files = collectTsFiles(srcDir);
    // Sanity: we actually scanned this package's sources.
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) =>
      readFileSync(file, "utf-8").includes(FORBIDDEN),
    );
    expect(offenders).toEqual([]);
  });

  it("package.json declares no dependency on the forbidden CLI specifier", () => {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };
    expect(Object.keys(allDeps)).not.toContain(FORBIDDEN);
  });
});
