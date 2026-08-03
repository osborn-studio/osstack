#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const temp = await mkdtemp(join(tmpdir(), "osstack-npm-trust-smoke-"));
const root = join(temp, "repo");
const authRoot = join(temp, "auth-repo");
const bin = join(temp, "bin");
for (const name of ["configured", "missing", "mismatched", "private"]) {
  await mkdir(join(root, "packages", name), { recursive: true });
}
await mkdir(bin);
await mkdir(join(authRoot, "packages", "auth"), { recursive: true });
await writeFile(join(root, "packages", "configured", "package.json"), JSON.stringify({ name: "@fixture/configured" }));
await writeFile(join(root, "packages", "missing", "package.json"), JSON.stringify({ name: "@fixture/missing" }));
await writeFile(join(root, "packages", "mismatched", "package.json"), JSON.stringify({ name: "@fixture/mismatched" }));
await writeFile(join(root, "packages", "private", "package.json"), JSON.stringify({ name: "@fixture/private", private: true }));
await writeFile(join(authRoot, "packages", "auth", "package.json"), JSON.stringify({ name: "@fixture/auth" }));
await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const name = process.argv[4];
if (process.argv[2] !== "trust" || process.argv[3] !== "list") process.exit(2);
if (name === "@fixture/configured") {
  console.log(JSON.stringify({ type: "github", repository: "gilosbornhello/osstack", file: "release.yml", permissions: ["createPackage"] }));
} else if (name === "@fixture/mismatched") {
  console.log(JSON.stringify({ type: "github", repository: "wrong/repo", file: "publish.yml", permissions: [] }));
} else if (name === "@fixture/auth") {
  console.error("npm error code EOTP");
  console.error("https://www.npmjs.com/auth/cli/secret-auth-id");
  process.exit(1);
}
`, { mode: 0o755 });

const result = await run(process.execPath, [
  "scripts/preflight-npm-trusted-publishers.mjs",
  "--root",
  root,
  "--json",
], { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });

assert(result.code === 1, "trust preflight must block missing or mismatched publisher configuration");
const parsed = JSON.parse(result.stderr);
assert(parsed.kind === "npm_trusted_publishers", "trust preflight must emit its stable contract kind");
assert(parsed.configured.includes("@fixture/configured"), "trust preflight must accept the expected GitHub publisher");
assert(parsed.missing.includes("@fixture/missing"), "trust preflight must detect an absent publisher");
assert(parsed.mismatched[0]?.name === "@fixture/mismatched", "trust preflight must detect repository/workflow/permission drift");
assert(!parsed.packages.includes("@fixture/private"), "trust preflight must ignore private packages");

const authResult = await run(process.execPath, [
  "scripts/preflight-npm-trusted-publishers.mjs",
  "--root",
  authRoot,
  "--json",
], { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
assert(authResult.code === 1, "trust preflight must stop when npm requires fresh 2FA");
const authParsed = JSON.parse(authResult.stderr);
assert(authParsed.authentication_required === true, "trust preflight must classify fresh 2FA as an external auth requirement");
assert(!authResult.stderr.includes("secret-auth-id"), "trust preflight must not echo npm web-auth session URLs");

console.log(JSON.stringify({
  ok: true,
  kind: "npm-trusted-publishers-smoke",
  checked: ["configured publisher", "missing publisher", "mismatched publisher", "private package exclusion", "web-auth URL redaction"],
}, null, 2));
