#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registry = "https://registry.npmjs.org/";
const root = resolve(process.cwd());
const selfTest = process.argv.includes("--self-test");

function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(raw);
  if (match === null) throw new Error(`unsupported semver: ${raw}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareVersions(leftRaw, rightRaw) {
  const left = parseVersion(leftRaw);
  const right = parseVersion(rightRaw);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function sanitizeError(raw) {
  return String(raw)
    .replace(/https:\/\/www\.npmjs\.com\/auth\/cli\/[^\s]+/giu, "[npm-auth-url-redacted]")
    .replace(/npm_[A-Za-z0-9]{20,}/gu, "[npm-token-redacted]")
    .slice(0, 2_000);
}

async function publicWorkspacePackages() {
  const packagesRoot = join(root, "packages");
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const packages = [];
  for (const entry of entries) {
    try {
      const manifest = JSON.parse(await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"));
      if (manifest.private === true) continue;
      if (typeof manifest.name !== "string" || !manifest.name.startsWith("@osstack/")) {
        throw new Error(`invalid public package name in packages/${entry.name}/package.json`);
      }
      if (typeof manifest.version !== "string") {
        throw new Error(`missing package version in packages/${entry.name}/package.json`);
      }
      parseVersion(manifest.version);
      packages.push({ name: manifest.name, version: manifest.version, directory: entry.name });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return packages;
}

async function registryVersion(item) {
  try {
    const { stdout } = await execFileAsync("npm", [
      "view",
      item.name,
      "version",
      "--json",
      "--registry",
      registry,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const version = JSON.parse(stdout);
    if (typeof version !== "string") throw new Error("registry returned no latest version");
    parseVersion(version);
    return { ...item, registryVersion: version };
  } catch (error) {
    // A new public workspace package has no registry baseline yet. Test its
    // local tarball; this does not grant npm bootstrap/publish readiness.
    if (registryPackageMissing(error)) return { ...item, registryVersion: null };
    const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    throw new Error(`${item.name}: ${sanitizeError(output)}`);
  }
}

function registryPackageMissing(error) {
  if (error?.code !== 1 || error?.killed === true || error?.signal != null) return false;
  try {
    return JSON.parse(String(error?.stdout))?.error?.code === "E404";
  } catch {
    return false;
  }
}

function isCandidate(item) {
  return item.registryVersion === null || compareVersions(item.version, item.registryVersion) > 0;
}

function isRegression(item) {
  return item.registryVersion !== null && compareVersions(item.version, item.registryVersion) < 0;
}

function registryAnchor(states) {
  const cli = states.find((item) => item.name === "@osstack/cli");
  if (cli === undefined) throw new Error("public workspace package @osstack/cli is missing");
  if (cli.registryVersion === null) throw new Error("@osstack/cli has no registry baseline; registry-skew smoke requires a published anchor");
  return cli;
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      timeout: options.timeout ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed: ${sanitizeError(output)}`);
  }
}

if (selfTest) {
  const cases = [
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.0.0", "1.1.0", -1],
    ["2.0.0-beta.2", "2.0.0-beta.1", 1],
    ["2.0.0-beta.1", "2.0.0", -1],
    ["2.0.0", "2.0.0-beta.9", 1],
  ];
  for (const [left, right, expected] of cases) {
    const actual = Math.sign(compareVersions(left, right));
    if (actual !== expected) throw new Error(`semver comparison failed: ${left} vs ${right}`);
  }
  const sanitized = sanitizeError("https://www.npmjs.com/auth/cli/secret-session npm_exampletoken12345678901234567890");
  if (sanitized.includes("secret-session") || sanitized.includes("npm_exampletoken")) {
    throw new Error("registry smoke error sanitizer exposed authentication material");
  }
  const registryErrors = [
    [{ code: 1, stdout: JSON.stringify({ error: { code: "E404" } }) }, true],
    [{ code: 1, stdout: JSON.stringify({ error: { code: "E401" } }) }, false],
    [{ code: 1, stdout: JSON.stringify({ error: { code: "E403" } }) }, false],
    [{ code: 1, stdout: JSON.stringify({ error: { code: "ETIMEDOUT" } }) }, false],
    [{ code: 1, stdout: "not json E404", stderr: "E404" }, false],
    [{ code: 1, stdout: JSON.stringify("1.0.0"), stderr: "E404" }, false],
    [{ code: "ETIMEDOUT", stdout: JSON.stringify({ error: { code: "E404" } }) }, false],
    [{ code: 1, killed: true, stdout: JSON.stringify({ error: { code: "E404" } }) }, false],
    [{ code: 1, signal: "SIGTERM", stdout: JSON.stringify({ error: { code: "E404" } }) }, false],
  ];
  for (const [error, expected] of registryErrors) {
    if (registryPackageMissing(error) !== expected) throw new Error("registry error classification failed");
  }
  const versions = [
    [{ version: "0.1.0", registryVersion: null }, true, false],
    [{ version: "1.0.1", registryVersion: "1.0.0" }, true, false],
    [{ version: "1.0.0", registryVersion: "1.0.0" }, false, false],
    [{ version: "1.0.0", registryVersion: "1.0.1" }, false, true],
  ];
  for (const [item, candidate, regression] of versions) {
    if (isCandidate(item) !== candidate || isRegression(item) !== regression) throw new Error("registry baseline classification failed");
  }
  for (const states of [[], [{ name: "@osstack/cli", version: "0.19.0", registryVersion: null }]]) {
    let refused = false;
    try { registryAnchor(states); } catch { refused = true; }
    if (!refused) throw new Error("missing registry anchor was accepted");
  }
  const anchor = { name: "@osstack/cli", version: "0.19.0", registryVersion: "0.19.0" };
  if (registryAnchor([anchor]) !== anchor) throw new Error("published registry anchor was rejected");
  console.log(JSON.stringify({ ok: true, kind: "npm-registry-skew-self-test", cases: cases.length + registryErrors.length + versions.length + 3 }));
  process.exit(0);
}

const temp = await mkdtemp(join(tmpdir(), "osstack-registry-skew-"));
try {
  const packDir = join(temp, "packs");
  const prefix = join(temp, "prefix");
  const workspace = join(temp, "workspace");
  const osstackHome = join(temp, "home");
  await mkdir(packDir);
  await mkdir(workspace);

  const packages = await publicWorkspacePackages();
  const states = [];
  for (let index = 0; index < packages.length; index += 6) {
    states.push(...await Promise.all(packages.slice(index, index + 6).map(registryVersion)));
  }
  const cli = registryAnchor(states);
  const regressions = states.filter(isRegression);
  if (regressions.length > 0) {
    throw new Error(`workspace versions are behind npm:\n${regressions.map((item) =>
      `${item.name}: local ${item.version}, registry ${item.registryVersion}`).join("\n")}`);
  }
  const candidates = states.filter(isCandidate);
  for (const candidate of candidates) {
    await run("pnpm", [
      "--filter",
      candidate.name,
      "pack",
      "--pack-destination",
      packDir,
    ]);
  }
  const tarballs = (await readdir(packDir))
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(packDir, entry))
    .sort();
  if (tarballs.length !== candidates.length) {
    throw new Error(`expected ${candidates.length} candidate tarballs, found ${tarballs.length}`);
  }

  const cliCandidate = candidates.some((item) => item.name === "@osstack/cli");
  const installSpecs = [
    ...tarballs,
    ...(cliCandidate ? [] : [`@osstack/cli@${cli.version}`]),
  ];
  await run("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--registry",
    registry,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...installSpecs,
  ], { timeout: 180_000 });

  const osstack = join(prefix, "bin", "osstack");
  const versionResult = await run(osstack, ["--version"], { env: { OSSTACK_HOME: osstackHome } });
  const expectedVersionOutput = `osstack ${cli.version}`;
  if (versionResult.stdout.trim() !== expectedVersionOutput) {
    throw new Error(`installed CLI version mismatch: expected ${expectedVersionOutput}, got ${versionResult.stdout.trim()}`);
  }
  const doctor = await run(osstack, ["doctor", "--workspace", workspace, "--json"], {
    env: { OSSTACK_HOME: osstackHome, OSSTACK_UPDATE_CHECK: "0" },
  });
  const doctorResult = JSON.parse(doctor.stdout);
  if (doctorResult.ok !== true) throw new Error(`registry-skew installed CLI doctor failed: ${doctor.stdout}`);

  console.log(JSON.stringify({
    ok: true,
    kind: "npm-registry-skew-smoke",
    public_packages: states.length,
    candidates: candidates.map((item) => ({
      name: item.name,
      local_version: item.version,
      registry_version: item.registryVersion,
    })),
    cli_source: cliCandidate ? "candidate-tarball" : "npm-registry",
    cli_version: cli.version,
  }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
