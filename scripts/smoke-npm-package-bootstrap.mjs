#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const temp = await mkdtemp(join(tmpdir(), "osstack-npm-bootstrap-smoke-"));
const root = join(temp, "repo");
const bin = join(temp, "bin");
await mkdir(join(root, "packages", "published"), { recursive: true });
await mkdir(join(root, "packages", "missing"), { recursive: true });
await mkdir(join(root, "packages", "private"), { recursive: true });
await mkdir(bin);
await writeFile(join(root, "packages", "published", "package.json"), JSON.stringify({ name: "@fixture/published", version: "1.0.0" }));
await writeFile(join(root, "packages", "missing", "package.json"), JSON.stringify({ name: "@fixture/missing", version: "1.0.0" }));
await writeFile(join(root, "packages", "private", "package.json"), JSON.stringify({ name: "@fixture/private", private: true }));
await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const name = process.argv[3];
if (process.argv[2] !== "view") process.exit(2);
if (name === "@fixture/published") {
  console.log(JSON.stringify("1.0.0"));
  process.exit(0);
}
console.error("npm ERR! code E404");
process.exit(1);
`, { mode: 0o755 });

const result = await run(process.execPath, [
  "scripts/preflight-npm-package-bootstrap.mjs",
  "--root",
  root,
  "--json",
], { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });

assert(result.code === 1, "bootstrap preflight must block an unpublished public package");
const parsed = JSON.parse(result.stderr);
assert(parsed.kind === "npm_package_bootstrap", "bootstrap preflight must emit its stable contract kind");
assert(parsed.missing.length === 1 && parsed.missing[0] === "@fixture/missing", "bootstrap preflight must identify the unpublished package");
assert(!parsed.packages.includes("@fixture/private"), "bootstrap preflight must ignore private workspace packages");

console.log(JSON.stringify({
  ok: true,
  kind: "npm-package-bootstrap-smoke",
  checked: ["published package", "unpublished package", "private package exclusion"],
}, null, 2));
