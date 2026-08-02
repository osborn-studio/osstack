#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const zeroSha = /^0+$/;

export function isReleaseSensitivePackagePath(path) {
  const match = /^packages\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return undefined;

  const [, directory, packagePath] = match;
  if (!directory || !packagePath) return undefined;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(packagePath)) return undefined;
  if (packagePath.includes("/__tests__/") || packagePath.includes("/fixtures/")) return undefined;

  const releaseSensitive = packagePath === "package.json"
    || packagePath.startsWith("src/")
    || packagePath.startsWith("schemas/")
    || packagePath.startsWith("scripts/")
    || packagePath.startsWith("assets/")
    || packagePath.startsWith("bin/");

  return releaseSensitive ? directory : undefined;
}

export function parseChangesetPackageNames(contents) {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1];
  if (!frontmatter) return [];

  const packages = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^:\s]+))\s*:\s*(?:patch|minor|major)\s*$/.exec(line);
    const packageName = match?.[1] ?? match?.[2] ?? match?.[3];
    if (packageName) packages.push(packageName);
  }
  return packages;
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function firstUsableSha(candidates, fallback) {
  return candidates.find((candidate) => candidate && !zeroSha.test(candidate)) ?? fallback;
}

function resolveBaseSha() {
  return firstUsableSha([
    argumentValue("--base"),
    process.env.CHANGESET_COVERAGE_BASE_SHA,
    process.env.PR_BASE_SHA,
    process.env.PUSH_BEFORE_SHA,
  ], "origin/main");
}

function resolveHeadSha() {
  return firstUsableSha([
    argumentValue("--head"),
    process.env.CHANGESET_COVERAGE_HEAD_SHA,
    process.env.HEAD_SHA,
  ], "HEAD");
}

async function coveredPackageNames() {
  const changesetDirectory = join(root, ".changeset");
  const files = await readdir(changesetDirectory);
  const covered = new Set();
  for (const file of files.filter((name) => name.endsWith(".md") && name !== "README.md")) {
    const contents = await readFile(join(changesetDirectory, file), "utf8");
    for (const packageName of parseChangesetPackageNames(contents)) covered.add(packageName);
  }
  return covered;
}

async function changedPublicPackages(baseSha, headSha) {
  const output = runGit(["diff", "--name-only", baseSha, headSha]);
  const directories = new Set(
    output.split(/\r?\n/).map(isReleaseSensitivePackagePath).filter(Boolean),
  );
  const packages = [];
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(root, "packages", directory, "package.json"), "utf8"));
    if (manifest.private !== true && typeof manifest.name === "string") packages.push(manifest.name);
  }
  return packages.sort();
}

function runSelfTest() {
  assert.equal(isReleaseSensitivePackagePath("packages/governance/src/review-boundary.ts"), "governance");
  assert.equal(isReleaseSensitivePackagePath("packages/governance/src/review-boundary.test.ts"), undefined);
  assert.equal(isReleaseSensitivePackagePath("packages/governance/CHANGELOG.md"), undefined);
  assert.equal(firstUsableSha([undefined, "", "000000", "abc123"], "fallback"), "abc123");
  assert.deepEqual(
    parseChangesetPackageNames('---\n"@osstack/governance": minor\n\'@osstack/loop\': patch\n---\n\nRelease.\n'),
    ["@osstack/governance", "@osstack/loop"],
  );
  console.log("changeset coverage self-test: ok");
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  const baseSha = resolveBaseSha();
  const headSha = resolveHeadSha();
  const [changed, covered] = await Promise.all([
    changedPublicPackages(baseSha, headSha),
    coveredPackageNames(),
  ]);
  const missing = changed.filter((packageName) => !covered.has(packageName));
  if (missing.length > 0) {
    console.error(`changeset coverage: missing release entries for ${missing.join(", ")}`);
    console.error(`checked diff: ${baseSha}..${headSha}`);
    process.exitCode = 1;
  } else {
    console.log(`changeset coverage: ok (${changed.length} release-sensitive package${changed.length === 1 ? "" : "s"})`);
  }
}
