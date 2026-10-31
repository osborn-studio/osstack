#!/usr/bin/env node
import { constants, existsSync } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(process.cwd());
const manifestPath = join(packageRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (typeof manifest.name !== "string" || !manifest.name.startsWith("@osstack/")) {
  throw new Error(`refusing to prepare a non-osstack package: ${manifestPath}`);
}

// dist/ is a build output and is never committed, so prepack must refuse to
// pack a package that has not been built rather than publish nothing or a
// stale tree. This script does not build; run `pnpm build` (or
// `pnpm --filter <package> build`) before `pnpm pack` / `pnpm publish`.
const buildHint = `run \`pnpm --filter ${manifest.name} build\` (or \`pnpm build\`) before packing`;
const dist = join(packageRoot, "dist");
const metadata = await lstat(dist).catch((error) => {
  if (error?.code === "ENOENT") throw new Error(`package ${manifest.name} has no dist/ directory: ${buildHint}`);
  throw error;
});
if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
  throw new Error(`package dist must be a real directory: ${dist}`);
}

const missingEntries = declaredDistEntries(manifest).filter((entry) => !existsSync(join(packageRoot, entry)));
if (missingEntries.length > 0) {
  throw new Error(`package ${manifest.name} is missing built entrypoints ${missingEntries.join(", ")}: ${buildHint}`);
}

const npmIgnore = [
  "**/*.test.*",
  "**/*.spec.*",
  "",
].join("\n");
const npmIgnorePath = join(dist, ".npmignore");
let handle;
try {
  handle = await open(
    npmIgnorePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  await handle.writeFile(npmIgnore, { encoding: "utf8" });
} finally {
  await handle?.close();
}
console.log(`prepared npm package ${manifest.name}: excluded compiled test/spec artifacts`);

function declaredDistEntries(pkg) {
  const entries = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      const normalized = value.replace(/^\.\//u, "");
      if (normalized.startsWith("dist/") && !normalized.includes("*")) entries.add(normalized);
    } else if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(pkg.main);
  visit(pkg.types);
  visit(pkg.typings);
  visit(pkg.bin);
  visit(pkg.exports);
  return [...entries].sort();
}
