#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const prepareScript = join(root, "scripts", "prepare-npm-package.mjs");
const temp = await mkdtemp(join(tmpdir(), "osstack-package-artifacts-smoke-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const fixture = join(temp, "fixture");
  await mkdir(join(fixture, "dist"), { recursive: true });
  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "@osstack/package-artifact-fixture",
    version: "1.0.0",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist"],
  }));
  await writeFile(join(fixture, "dist", "index.js"), "export const ready = true;\n");
  await writeFile(join(fixture, "dist", "index.d.ts"), "export declare const ready = true;\n");
  await writeFile(join(fixture, "dist", "index.test.js"), "throw new Error('must not ship');\n");
  await writeFile(join(fixture, "dist", "nested.spec.d.ts"), "export {};\n");

  const prepare = run(process.execPath, [prepareScript], { cwd: fixture });
  assert(prepare.code === 0, `package preparation failed: ${prepare.stderr}`);
  const ignore = await readFile(join(fixture, "dist", ".npmignore"), "utf8");
  assert(ignore.includes("**/*.test.*"), "generated dist/.npmignore must exclude test artifacts");
  assert(ignore.includes("**/*.spec.*"), "generated dist/.npmignore must exclude spec artifacts");

  const packed = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: fixture });
  assert(packed.code === 0, `fixture npm pack failed: ${packed.stderr}`);
  const manifest = JSON.parse(packed.stdout)[0];
  const paths = manifest?.files?.map((entry) => entry.path) ?? [];
  assert(paths.includes("dist/index.js"), "npm package must retain its runtime entrypoint");
  assert(paths.includes("dist/index.d.ts"), "npm package must retain its type entrypoint");
  assert(!paths.some((entry) => /\.(?:test|spec)\./u.test(entry)), "npm package must not contain test/spec artifacts");

  const symlinkFixture = join(temp, "symlink-fixture");
  const externalDist = join(temp, "external-dist");
  await mkdir(symlinkFixture);
  await mkdir(externalDist);
  await writeFile(join(symlinkFixture, "package.json"), JSON.stringify({
    name: "@osstack/symlink-package-fixture",
    version: "1.0.0",
  }));
  await symlink(externalDist, join(symlinkFixture, "dist"), "dir");
  const rejected = run(process.execPath, [prepareScript], { cwd: symlinkFixture });
  assert(rejected.code !== 0, "package preparation must reject a symlinked dist directory");

  const ignoreSymlinkFixture = join(temp, "ignore-symlink-fixture");
  const externalIgnore = join(temp, "external-ignore");
  await mkdir(join(ignoreSymlinkFixture, "dist"), { recursive: true });
  await writeFile(join(ignoreSymlinkFixture, "package.json"), JSON.stringify({
    name: "@osstack/ignore-symlink-package-fixture",
    version: "1.0.0",
  }));
  await writeFile(externalIgnore, "must remain unchanged\n");
  await symlink(externalIgnore, join(ignoreSymlinkFixture, "dist", ".npmignore"));
  const ignoreRejected = run(process.execPath, [prepareScript], { cwd: ignoreSymlinkFixture });
  assert(ignoreRejected.code !== 0, "package preparation must reject a symlinked dist/.npmignore");
  assert(await readFile(externalIgnore, "utf8") === "must remain unchanged\n", "package preparation must not follow a dist/.npmignore symlink");

  // dist/ is never committed: an unbuilt package must fail prepack loudly instead
  // of packing nothing or a stale tree.
  const unbuiltFixture = join(temp, "unbuilt-fixture");
  await mkdir(unbuiltFixture);
  await writeFile(join(unbuiltFixture, "package.json"), JSON.stringify({
    name: "@osstack/unbuilt-package-fixture",
    version: "1.0.0",
    main: "./dist/index.js",
    files: ["dist"],
  }));
  const unbuilt = run(process.execPath, [prepareScript], { cwd: unbuiltFixture });
  assert(unbuilt.code !== 0, "package preparation must reject a package without dist/");
  assert(/has no dist\/ directory: run `pnpm --filter @osstack\/unbuilt-package-fixture build`/u.test(unbuilt.stderr),
    `package preparation must explain how to build a package without dist/: ${unbuilt.stderr}`);

  const partialFixture = join(temp, "partial-fixture");
  await mkdir(join(partialFixture, "dist"), { recursive: true });
  await writeFile(join(partialFixture, "package.json"), JSON.stringify({
    name: "@osstack/partial-package-fixture",
    version: "1.0.0",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    files: ["dist"],
  }));
  await writeFile(join(partialFixture, "dist", "index.d.ts"), "export {};\n");
  const partial = run(process.execPath, [prepareScript], { cwd: partialFixture });
  assert(partial.code !== 0, "package preparation must reject a dist/ missing its declared entrypoint");
  assert(partial.stderr.includes("missing built entrypoints dist/index.js"),
    `package preparation must name the missing entrypoint: ${partial.stderr}`);

  console.log(JSON.stringify({
    ok: true,
    kind: "npm-package-artifacts-smoke",
    checked: [
      "runtime/type entries retained",
      "test/spec artifacts excluded",
      "symlinked dist rejected",
      "symlinked dist/.npmignore rejected",
      "unbuilt package (no dist/) rejected with build hint",
      "dist/ missing a declared entrypoint rejected",
    ],
  }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
