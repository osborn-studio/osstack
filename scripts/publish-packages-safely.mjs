#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org/";
const packageNamePattern = /^@osstack\/[a-z0-9][a-z0-9._-]*$/u;
const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function buildTopologicalPublishPlan(packages) {
  const byName = new Map();
  for (const item of packages) {
    if (byName.has(item.name)) throw new Error(`duplicate public package: ${item.name}`);
    byName.set(item.name, item);
  }

  const remainingDependencies = new Map();
  const dependents = new Map([...byName.keys()].map((name) => [name, new Set()]));
  for (const item of packages) {
    const dependencies = new Set(item.internalDependencies);
    for (const dependency of dependencies) {
      if (dependency === item.name) throw new Error(`package cannot depend on itself: ${item.name}`);
      if (!byName.has(dependency)) {
        throw new Error(`${item.name} references missing internal dependency ${dependency}`);
      }
      dependents.get(dependency).add(item.name);
    }
    remainingDependencies.set(item.name, dependencies);
  }

  const ready = [...byName.keys()]
    .filter((name) => remainingDependencies.get(name).size === 0)
    .sort(compareNames);
  const plan = [];
  while (ready.length > 0) {
    const name = ready.shift();
    plan.push(byName.get(name));
    for (const dependent of [...dependents.get(name)].sort(compareNames)) {
      const dependencies = remainingDependencies.get(dependent);
      dependencies.delete(name);
      if (dependencies.size === 0) {
        ready.push(dependent);
        ready.sort(compareNames);
      }
    }
  }

  if (plan.length !== packages.length) {
    const blocked = [...remainingDependencies]
      .filter(([, dependencies]) => dependencies.size > 0)
      .map(([name, dependencies]) => `${name} -> ${[...dependencies].sort(compareNames).join(", ")}`)
      .sort(compareNames);
    throw new Error(`internal dependency cycle: ${blocked.join("; ")}`);
  }
  return plan;
}

export async function publishPackagesSequentially(packages, options) {
  const plan = buildTopologicalPublishPlan(packages);
  const byName = new Map(packages.map((item) => [item.name, item]));
  const available = new Set(options.publishedVersions);
  const published = [];
  const skipped = [];

  for (const item of plan) {
    const key = packageVersionKey(item);
    if (available.has(key)) {
      skipped.push(item);
      continue;
    }

    for (const dependencyName of item.internalDependencies) {
      const dependency = byName.get(dependencyName);
      const dependencyKey = packageVersionKey(dependency);
      if (!available.has(dependencyKey)) {
        throw new Error(
          `${item.name}@${item.version} cannot publish before ${dependencyKey} is available`,
        );
      }
    }

    await options.publish(item);
    available.add(key);
    await options.recordPublished(item);
    published.push(item);
  }

  return { plan, published, skipped };
}

export function sanitizePublishError(raw) {
  return String(raw)
    .replace(/https:\/\/www\.npmjs\.com\/auth\/cli\/[^\s]+/giu, "[npm-auth-url-redacted]")
    .replace(/npm_[A-Za-z0-9]{20,}/gu, "[npm-token-redacted]")
    .replace(/(?:_authToken\s*=\s*)[^\s]+/giu, "_authToken=[npm-token-redacted]")
    .replace(/(?:Authorization\s*:\s*Bearer\s+)[^\s]+/giu, "Authorization: Bearer [npm-token-redacted]")
    .slice(0, 4_000);
}

export function changesetsTagAnnouncement(item) {
  return `New tag: ${packageVersionKey(item)}`;
}

async function main() {
  const packages = await publicWorkspacePackages();
  const publishedVersions = await registryPublishedVersions(packages);
  const distTag = releaseDistTag(packages);
  const result = await publishPackagesSequentially(packages, {
    publishedVersions,
    publish: (item) => publishPackage(item, distTag),
    recordPublished: recordPublishedPackage,
  });

  console.log(JSON.stringify({
    ok: true,
    kind: "safe-sequential-npm-publish",
    dist_tag: distTag,
    public_packages: packages.length,
    published: result.published.map(packageVersionKey),
    skipped: result.skipped.map(packageVersionKey),
    invariant: "internal dependencies exist before dependents publish",
  }, null, 2));
}

async function publicWorkspacePackages() {
  const packagesRoot = join(root, "packages");
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareNames(left.name, right.name));
  const workspaceManifests = [];
  for (const entry of entries) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (typeof manifest.name !== "string" || !packageNamePattern.test(manifest.name)) {
      throw new Error(`invalid workspace package name in packages/${entry.name}/package.json`);
    }
    if (manifest.private !== true && (typeof manifest.version !== "string" || !packageVersionPattern.test(manifest.version))) {
      throw new Error(`invalid package version for ${manifest.name}`);
    }
    workspaceManifests.push({ entry, manifest });
  }

  const publicManifests = workspaceManifests.filter(({ manifest }) => manifest.private !== true);
  const publicNames = new Set(publicManifests.map(({ manifest }) => manifest.name));
  const privateNames = new Set(
    workspaceManifests
      .filter(({ manifest }) => manifest.private === true)
      .map(({ manifest }) => manifest.name),
  );
  return publicManifests.map(({ entry, manifest }) => {
    const dependencyNames = new Set();
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = manifest[section];
      if (dependencies === undefined) continue;
      if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
        throw new Error(`${manifest.name} has invalid ${section}`);
      }
      for (const name of Object.keys(dependencies)) {
        if (privateNames.has(name)) {
          throw new Error(`${manifest.name} cannot publish with private workspace dependency ${name}`);
        }
        if (publicNames.has(name)) dependencyNames.add(name);
      }
    }
    return {
      name: manifest.name,
      version: manifest.version,
      directory: join("packages", entry.name),
      access: manifest.publishConfig?.access === "restricted" ? "restricted" : "public",
      internalDependencies: [...dependencyNames].sort(compareNames),
    };
  });
}

async function registryPublishedVersions(packages) {
  const published = new Set();
  for (let offset = 0; offset < packages.length; offset += 6) {
    const states = await Promise.all(packages.slice(offset, offset + 6).map(registryHasVersion));
    for (let index = 0; index < states.length; index += 1) {
      if (states[index]) published.add(packageVersionKey(packages[offset + index]));
    }
  }
  return published;
}

async function registryHasVersion(item) {
  try {
    const { stdout } = await execFileAsync("npm", [
      "view",
      `${item.name}@${item.version}`,
      "version",
      "--json",
      "--registry",
      registry,
    ], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const version = JSON.parse(stdout);
    if (version !== item.version) {
      throw new Error(`registry returned ${JSON.stringify(version)} instead of ${item.version}`);
    }
    return true;
  } catch (error) {
    const output = publishErrorOutput(error);
    if (/\b(?:E404|ETARGET)\b/u.test(output)) return false;
    throw new Error(`could not inspect ${item.name}@${item.version}: ${sanitizePublishError(output)}`);
  }
}

function releaseDistTag(packages) {
  const configured = process.env.OSSTACK_NPM_DIST_TAG?.trim();
  const tag = configured === undefined || configured === "" ? "latest" : configured;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tag)) throw new Error(`invalid npm dist-tag: ${tag}`);
  if (tag === "latest" && packages.some((item) => item.version.includes("-"))) {
    throw new Error("prerelease versions require OSSTACK_NPM_DIST_TAG to be set explicitly");
  }
  return tag;
}

async function publishPackage(item, distTag) {
  console.log(`Publishing ${item.name}@${item.version} after all internal dependencies are available.`);
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", [
      "--dir",
      item.directory,
      "publish",
      "--access",
      item.access,
      "--tag",
      distTag,
      "--no-git-checks",
      "--provenance",
      "--json",
      "--registry",
      registry,
    ], {
      cwd: root,
      env: process.env,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = sanitizePublishError(`${stdout}\n${stderr}`).trim();
    if (output !== "") console.log(output);
  } catch (error) {
    throw new Error(`publish failed for ${item.name}@${item.version}: ${sanitizePublishError(publishErrorOutput(error))}`);
  }
}

async function recordPublishedPackage(item) {
  const tag = `${item.name}@${item.version}`;
  const tagRef = `refs/tags/${tag}`;
  const tagCheck = await runAllowFailure("git", ["rev-parse", "--verify", "--quiet", tagRef]);
  if (tagCheck.code === 0) {
    const taggedCommit = (await execFileAsync("git", ["rev-list", "-n", "1", tagRef], {
      cwd: root,
      timeout: 10_000,
    })).stdout.trim();
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      timeout: 10_000,
    })).stdout.trim();
    if (taggedCommit !== head) throw new Error(`${tag} already points to ${taggedCommit}, not ${head}`);
  } else if (tagCheck.code === 1) {
    await execFileAsync("git", ["tag", "-a", tag, "-m", tag], { cwd: root, timeout: 10_000 });
  } else {
    throw new Error(`could not inspect release tag ${tag}: ${sanitizePublishError(tagCheck.stderr)}`);
  }

  const event = JSON.stringify({ type: "git-tag", tag, packageName: item.name });
  const outputPath = process.env.CHANGESETS_OUTPUT;
  if (outputPath === undefined || outputPath.trim() === "") {
    console.log(event);
  } else {
    await appendFile(outputPath, `${event}\n`, "utf8");
  }
  // changesets/action@v1 discovers successful monorepo releases by parsing
  // this exact stdout contract before it pushes the tag and creates a release.
  console.log(changesetsTagAnnouncement(item));
}

async function runAllowFailure(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : 2,
      stdout: String(error?.stdout ?? ""),
      stderr: publishErrorOutput(error),
    };
  }
}

function packageVersionKey(item) {
  return `${item.name}@${item.version}`;
}

function publishErrorOutput(error) {
  return [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`osstack release: ${sanitizePublishError(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
}
