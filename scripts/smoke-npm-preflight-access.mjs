#!/usr/bin/env node
import { mkdtemp, writeFile } from "node:fs/promises";
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tmp = await mkdtemp(join(tmpdir(), "osstack-npm-preflight-smoke-"));
const npmShim = join(tmp, "npm");
await writeFile(
  npmShim,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "whoami") {
  console.log("osstack-ci");
  process.exit(0);
}
if (args[0] === "access" && args[1] === "list" && args[2] === "packages") {
  console.error("npm ERR! code E403");
  console.error("npm ERR! 403 Forbidden - You do not have permission to publish packages under @osstack.");
  process.exit(1);
}
console.error("unexpected npm shim args", args.join(" "));
process.exit(2);
`,
  { mode: 0o755 },
);

const result = await run(process.execPath, ["scripts/preflight-npm-publish-access.mjs"], {
  env: {
    PATH: `${tmp}:${process.env.PATH ?? ""}`,
    OSSTACK_NPM_SCOPE: "@osstack",
  },
});

assert(result.code === 1, "npm preflight must fail when npm returns E403.");
assert(
  result.stderr.includes("NPM_TOKEN account cannot publish to @osstack"),
  "npm preflight must explain forbidden publish access as an NPM_TOKEN account permission problem.",
);
assert(
  result.stderr.includes("Add the npm account behind NPM_TOKEN as an owner or publisher for @osstack"),
  "npm preflight must print the owner/publisher remediation step.",
);

console.log(JSON.stringify({
  ok: true,
  kind: "npm-preflight-access-smoke",
  checked: ["E403 forbidden publish access"],
}, null, 2));
