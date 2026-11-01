#!/usr/bin/env node
// release-facts — one command that proves the repo's release story is
// internally consistent (Doc 15 R0.1: "仓库、npm、GitHub Release、README 的版本
// 状态可由一个命令生成并验证").
//
// Facts model (two release channels move independently):
//   - npm channel:    canonical version = packages/cli/package.json. Every
//                     `@osstack/cli@X.Y.Z` and the `osstack X.Y.Z` version
//                     sample in the READMEs must match it.
//   - binary channel: the macOS single-binary release (vX.Y.Z tag). It is cut
//                     separately and may lag npm. All binary references
//                     (`osstack-X.Y.Z-darwin-arm64`, `/releases/tag/vX.Y.Z`,
//                     `gh release view vX.Y.Z`) must agree on ONE version.
//
// Modes:
//   node scripts/release-facts.mjs               offline checks (CI-safe)
//   node scripts/release-facts.mjs --remote      + npm dist-tag and GitHub
//                                                release existence checks
//   node scripts/release-facts.mjs --self-test   run embedded fixtures
//   node scripts/release-facts.mjs --json        machine-readable report
//
// Exit codes: 0 = consistent, 1 = drift found, 2 = execution error.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READMES = ["README.md", "README.zh.md"];

/** Pure check: compare README text against the canonical npm version and a
 *  self-consistent binary version. Returns a list of human-readable problems. */
export function checkReleaseFacts({ npmVersion, readmes }) {
  const problems = [];
  const binaryVersions = new Set();

  for (const { name, text } of readmes) {
    // npm channel: @osstack/cli@X.Y.Z occurrences must equal package.json.
    for (const match of text.matchAll(/@osstack\/cli@(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== npmVersion) {
        problems.push(`${name}: mentions @osstack/cli@${match[1]} but packages/cli/package.json is ${npmVersion}`);
      }
    }
    // npm channel: npm and source-tag link targets must equal package.json too.
    for (const match of text.matchAll(/\/package\/@osstack\/cli\/v\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)|%40osstack%2Fcli%40(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)) {
      const linked = match[1] ?? match[2];
      if (linked !== npmVersion) {
        problems.push(`${name}: links to @osstack/cli ${linked} but packages/cli/package.json is ${npmVersion}`);
      }
    }
    // npm channel: the `osstack X.Y.Z` --version sample must equal package.json.
    for (const match of text.matchAll(/^osstack (\d+\.\d+\.\d+)$/gm)) {
      if (match[1] !== npmVersion) {
        problems.push(`${name}: "osstack --version" sample shows ${match[1]} but packages/cli/package.json is ${npmVersion}`);
      }
    }
    // binary channel: collect every binary-flavored version reference.
    for (const match of text.matchAll(/osstack-(\d+\.\d+\.\d+)-darwin-arm64/g)) binaryVersions.add(match[1]);
    for (const match of text.matchAll(/releases\/tag\/v(\d+\.\d+\.\d+)/g)) binaryVersions.add(match[1]);
    for (const match of text.matchAll(/gh release view v(\d+\.\d+\.\d+)/g)) binaryVersions.add(match[1]);
  }

  if (binaryVersions.size > 1) {
    problems.push(`READMEs reference more than one single-binary version: ${[...binaryVersions].sort().join(", ")} — the binary channel must be internally consistent`);
  }

  return { problems, binaryVersion: [...binaryVersions][0] };
}

function remoteChecks({ npmVersion, binaryVersion }) {
  const problems = [];
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  try {
    const live = run("npm", ["view", "@osstack/cli", "version"]);
    if (live !== npmVersion) problems.push(`npm dist-tag latest is ${live} but packages/cli/package.json is ${npmVersion}`);
  } catch {
    problems.push("could not query npm for @osstack/cli (network or registry error)");
  }

  try {
    run("gh", ["release", "view", `@osstack/cli@${npmVersion}`, "--json", "tagName"]);
  } catch {
    problems.push(`GitHub release @osstack/cli@${npmVersion} not found`);
  }

  if (binaryVersion !== undefined) {
    try {
      run("gh", ["release", "view", `v${binaryVersion}`, "--json", "tagName"]);
    } catch {
      problems.push(`GitHub single-binary release v${binaryVersion} not found (README references it)`);
    }
  }

  return problems;
}

function selfTest() {
  const fixtures = [
    {
      name: "consistent facts pass",
      npmVersion: "1.2.3",
      readme: "| npm | `@osstack/cli@1.2.3` |\nosstack 1.2.3\n[bin](https://x/releases/tag/v1.0.0)\nosstack-1.0.0-darwin-arm64.tar.gz\n",
      expectProblems: 0,
    },
    {
      name: "stale npm mention fails",
      npmVersion: "1.2.3",
      readme: "`@osstack/cli@1.0.0`\n",
      expectProblems: 1,
    },
    {
      name: "stale npm and tag links fail",
      npmVersion: "1.2.3",
      readme: "[`@osstack/cli@1.2.3`](https://npm/package/@osstack/cli/v/1.0.0) [t](https://g/tree/%40osstack%2Fcli%401.0.0)\n",
      expectProblems: 2,
    },
    {
      name: "prerelease link to a stable version fails",
      npmVersion: "1.2.3",
      readme: "[n](https://npm/package/@osstack/cli/v/1.2.3-rc.1)\n",
      expectProblems: 1,
    },
    {
      name: "matching prerelease links pass",
      npmVersion: "1.2.3-rc.1",
      readme: "[n](https://npm/package/@osstack/cli/v/1.2.3-rc.1) [t](https://g/tree/%40osstack%2Fcli%401.2.3-rc.1)\n",
      expectProblems: 0,
    },
    {
      name: "stale --version sample fails",
      npmVersion: "1.2.3",
      readme: "osstack 1.0.0\n",
      expectProblems: 1,
    },
    {
      name: "mixed binary versions fail",
      npmVersion: "1.2.3",
      readme: "osstack-1.0.0-darwin-arm64\nosstack-1.1.0-darwin-arm64\n",
      expectProblems: 1,
    },
  ];

  let failed = 0;
  for (const fixture of fixtures) {
    const { problems } = checkReleaseFacts({
      npmVersion: fixture.npmVersion,
      readmes: [{ name: "fixture.md", text: fixture.readme }],
    });
    const ok = problems.length === fixture.expectProblems;
    if (!ok) {
      failed += 1;
      console.error(`self-test FAIL: ${fixture.name} — expected ${fixture.expectProblems} problem(s), got ${problems.length}: ${JSON.stringify(problems)}`);
    } else {
      console.log(`self-test ok: ${fixture.name}`);
    }
  }
  return failed === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }

  const npmVersion = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf-8")).version;
  const readmes = READMES.map((name) => ({ name, text: readFileSync(join(ROOT, name), "utf-8") }));

  const { problems, binaryVersion } = checkReleaseFacts({ npmVersion, readmes });
  if (args.includes("--remote")) {
    problems.push(...remoteChecks({ npmVersion, binaryVersion }));
  }

  const report = {
    npm_version: npmVersion,
    binary_version: binaryVersion ?? null,
    remote_checked: args.includes("--remote"),
    consistent: problems.length === 0,
    problems,
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`npm channel:    @osstack/cli@${npmVersion} (packages/cli/package.json)`);
    console.log(`binary channel: ${binaryVersion !== undefined ? `v${binaryVersion}` : "(no binary references found)"}`);
    if (problems.length === 0) {
      console.log("release facts: CONSISTENT");
    } else {
      console.error(`release facts: DRIFT (${problems.length})`);
      for (const problem of problems) console.error(`  - ${problem}`);
    }
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(`release-facts: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
