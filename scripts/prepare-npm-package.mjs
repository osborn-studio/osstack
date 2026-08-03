#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(process.cwd());
const manifestPath = join(packageRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (typeof manifest.name !== "string" || !manifest.name.startsWith("@osstack/")) {
  throw new Error(`refusing to prepare a non-osstack package: ${manifestPath}`);
}

const dist = join(packageRoot, "dist");
const metadata = await lstat(dist);
if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
  throw new Error(`package dist must be a real directory: ${dist}`);
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
