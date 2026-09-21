import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Workspace-only fixture: real pnpm without downloading dependency packages. */
export async function seedPnpmEnvironment(repo: string): Promise<void> {
  await mkdir(join(repo, "packages/local"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "test-root", packageManager: "pnpm@11.4.0",
    dependencies: { "test-local": "workspace:*" }, scripts: { postinstall: "node -e \"require('fs').writeFileSync('script-ran','bad')\"" } }));
  await writeFile(join(repo, "packages/local/package.json"), JSON.stringify({ name: "test-local", version: "1.0.0", main: "index.js", scripts: { postinstall: "node -e \"require('fs').writeFileSync('dependency-script-ran','bad')\"" } }));
  await writeFile(join(repo, "packages/local/index.js"), "module.exports = 'available';\n");
  await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\nallowBuilds:\n  test-local: true\n");
  await writeFile(join(repo, ".corepack.env"), "COREPACK_HOME=/this-cache-must-not-be-used\nCOREPACK_ENABLE_NETWORK=1\n");
  await writeFile(join(repo, ".pnpmfile.cjs"), "throw new Error('pnpm hook must not execute');\n");
  await exec("pnpm", ["--pm-on-fail=error", "install", "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile", "--reporter=silent"], { cwd: repo, env: { ...process.env, COREPACK_ENV_FILE: "0" } });
}
