import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  docsLinkViolations,
  instructionBoundaryViolations,
  gitWriteFindings,
  gitWriteViolations,
  secretFindings,
  secretViolations,
  machinePathFindings,
  machinePathViolations,
  packageContractViolations,
  scratchViolations,
  startupGraphViolations,
  vitestConfigViolations,
} from "./check-deterministic-rules.mjs";

function fixture(files, run) {
  const root = join("/tmp", `osstack-rule-test-${randomUUID()}`);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("scratch check rejects direct calls and accepts helper use; stale exceptions fail", () => {
  fixture({ "packages/demo/src/a.ts": 'import { mkdtemp } from "node:fs/promises"; mkdtemp("/tmp/a-");' }, (root) => {
    assert.match(scratchViolations(root, []).join("\n"), /createScratchDir \/ scratchPath/);
    const entry = { file: "packages/demo/src/a.ts", expression: 'mkdtemp("/tmp/a-")', count: 1, reason: "legacy fixture" };
    assert.deepEqual(scratchViolations(root, [entry]), []);
    assert.match(scratchViolations(root, [{ ...entry, count: 2 }]).join("\n"), /stale scratch allowlist/);
  });
  fixture({ "packages/demo/src/a.ts": 'import * as os from "node:os"; os.tmpdir();' }, (root) => {
    assert.match(scratchViolations(root, []).join("\n"), /scratchPath/);
  });
  fixture({ "scripts/run.mjs": 'import { tmpdir } from "node:os"; tmpdir();' }, (root) => {
    assert.match(scratchViolations(root, []).join("\n"), /scripts\/run\.mjs::tmpdir\(\)/);
  });
  fixture({ "packages/demo/src/a.ts": 'import { createScratchDir } from "@osstack/core"; createScratchDir("tests", "a");' }, (root) => {
    assert.deepEqual(scratchViolations(root, []), []);
  });
  fixture({
    "packages/demo/src/a.test.ts": 'import { mkdtemp } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path"; mkdtemp(join(tmpdir(), "fixture-"));',
    "packages/demo/src/a.property.test.ts": 'mkdtemp(join(tmpdir(), "property-"));',
    "packages/demo/src/a.integration.test.ts": 'mkdtemp(join(tmpdir(), "integration-"));',
    "packages/demo/src/a.test.mts": 'mkdtemp(join(tmpdir(), "mts-"));',
    "packages/demo/src/a.testkit.ts": 'mkdtemp(join(tmpdir(), "kit-"));',
    "packages/demo/src/test-helper.ts": 'mkdtemp(join(tmpdir(), "helper-"));',
    "packages/demo/src/fixtures/example.ts": 'mkdtemp(join(tmpdir(), "fixture-"));',
    "scripts/a.test.mjs": 'mkdtemp(join(tmpdir(), "script-test-"));',
  }, (root) => {
    assert.deepEqual(scratchViolations(root, []), []);
  });
});

test("vitest setup check covers missing setup and missing config for tested packages", () => {
  fixture({
    "packages/good/src/a.test.ts": "test('ok', () => {});",
    "packages/good/vitest.config.ts": 'export default { test: { setupFiles: ["../../scripts/vitest-setup-scratch.ts"] } };',
    "packages/bad/src/a.test.ts": "test('bad', () => {});",
    "packages/missing/src/a.test.ts": "test('missing', () => {});",
  }, (root) => {
    const errors = vitestConfigViolations(root);
    assert.equal(errors.length, 2);
    assert.match(errors.join("\n"), /test\.setupFiles/);
    assert.match(errors.join("\n"), /add a config/);
  });
});

test("docs check ignores code fences, anchors, and URLs; rejects broken relative links", () => {
  fixture({
    "docs/a.md": '[good](b.md)\n[bad](missing.md)\n[anchor](#part)\n[web](https://example.com)\n```md\n[ignored](absent.md)\n```\n',
    "docs/b.md": "present",
  }, (root) => {
    assert.deepEqual(docsLinkViolations(root, []), [
      "docs/a.md::missing.md (line 2): point the relative Markdown link to an existing repository file, or add that file",
    ]);
    const entry = { file: "docs/a.md", target: "missing.md", count: 1, reason: "old reference" };
    assert.deepEqual(docsLinkViolations(root, [entry]), []);
    assert.match(docsLinkViolations(root, [{ ...entry, count: 2 }]).join("\n"), /stale docs link allowlist/);
  });
});

test("startup graph follows static imports but not dynamic imports, and enforces both limits", () => {
  fixture({
    "packages/cli/src/cli-entry.ts": 'import "./version.js"; await import("./bin.js");',
    "packages/cli/src/version.ts": 'import "./version-data.js"; export const VERSION = "1";',
    "packages/cli/src/version-data.ts": "export const data = 1;",
    "packages/cli/src/bin.ts": 'import "./helper.js"; await import("./command.js");',
    "packages/cli/src/helper.ts": "export const helper = 1;",
    "packages/cli/src/command.ts": "export const command = 1;",
  }, (root) => {
    assert.deepEqual(startupGraphViolations(root, { entry: 3, bin: 2 }).errors, []);
    assert.match(startupGraphViolations(root, { entry: 2, bin: 1 }).errors.join("\n"), /use await import\(\)/);
    writeFileSync(join(root, "packages/cli/src/cli-entry.ts"), 'import "./command.js";');
    assert.match(startupGraphViolations(root, { entry: 2, bin: 2 }).errors.join("\n"), /statically loads command module/);
  });
});

test("git writes reject unmanaged array, wrapper, and shell calls but ignore reads and tests", () => {
  fixture({
    "packages/demo/src/a.ts": `execFileSync("git", ["push", "origin"]); runGit(root, ["-c", "x=y", "commit", "-m", "x"]); execSync("git checkout -B topic"); run(["worktree", "remove", path]); git(root, "update-ref", "HEAD", sha); runner.run("git", ["branch", "--show-current"]); git(root, ["tag", "--list"]); git();`,
    "packages/demo/src/a.test.ts": 'execFileSync("git", ["push"]);',
  }, (root) => {
    const calls = gitWriteFindings(root);
    assert.equal(calls.length, 5);
    assert.match(gitWriteViolations(root, []).join("\n"), /managed Git location/);
    const entries = [{ file: "packages/demo/src/a.ts", count: calls.length, reason: "test managed boundary" }];
    assert.deepEqual(gitWriteViolations(root, entries), []);
    assert.match(gitWriteViolations(root, [{ ...entries[0], count: 6 }]).join("\n"), /stale git write allowlist/);
    writeFileSync(join(root, "packages/demo/src/a.ts"), "");
    assert.match(gitWriteViolations(root, entries).join("\n"), /remove or narrow/);
  });
});

test("git writes cover ref, index, remote and worktree mutation commands with global options", () => {
  const commands = ["push", "commit", "merge", "rebase", "reset", "checkout -B", "branch -D", "update-ref", "worktree add", "worktree remove", "tag v1", "add", "fetch", "cherry-pick", "stash push", "read-tree", "update-index", "apply --cached", "switch -C", "remote add", "init", "clone", "restore --staged"];
  fixture({ "packages/demo/src/a.ts": commands.map(command => `spawn("git", ["-C", root, ${command.split(" ").map(value => JSON.stringify(value)).join(",")}]);`).join("\n") }, root => {
    assert.equal(gitWriteFindings(root).length, commands.length);
  });
});

test("secrets scan every tracked text file; machine paths scan shipped content only", () => {
  const token = "gh" + "p_fake";
  const path = "/" + "Users/alice/project/";
  const files = {
    "docs/history.md": path,
    "docs/secret.md": token,
    "other/secret.txt": token,
    "AGENTS.md": path,
    "package.json": path,
    ".npmrc": path,
    ".gitignore": path,
    "packages/demo/src/a.ts": path,
    "scripts/a.mjs": path,
    ".github/workflows/a.yml": path,
    "hermes-skill/SKILL.md": path,
    "loop-engineering/SKILL.md": path,
    "binary.bin": `\0${token}`,
    "untracked.txt": token,
  };
  fixture(files, root => {
    const tracked = Object.keys(files).filter(file => file !== "untracked.txt");
    assert.deepEqual(secretFindings(root, tracked).map(x => x.file), ["docs/secret.md", "other/secret.txt"]);
    assert.equal(secretViolations(root, [], tracked).length, 2);
    assert.equal(machinePathFindings(root, tracked).length, 8);
    assert.ok(machinePathViolations(root, [], tracked).some(x => x.includes("packages/demo/src/a.ts")));
    assert.ok(!machinePathViolations(root, [], tracked).some(x => x.includes("docs/")));
    const entries = [{ file: "docs/secret.md", count: 1, reason: "fake token in audit example" }, { file: "other/secret.txt", count: 1, reason: "fake token fixture" }];
    assert.deepEqual(secretViolations(root, entries, tracked), []);
    writeFileSync(join(root, "docs/secret.md"), `${token} ${token}`);
    assert.match(secretViolations(root, entries, tracked).join("\n"), /stale secret allowlist/);
    writeFileSync(join(root, "docs/secret.md"), "");
    assert.match(secretViolations(root, entries, tracked).join("\n"), /remove or narrow/);
    assert.match(secretViolations(root, [entries[1], entries[1]], tracked).join("\n"), /stale secret allowlist/);
    const paths = machinePathFindings(root, tracked).map(({ file }) => ({ file, count: 1, reason: "synthetic path fixture" }));
    assert.deepEqual(machinePathViolations(root, paths, tracked), []);
    writeFileSync(join(root, "packages/demo/src/a.ts"), `${path} ${path}`);
    assert.match(machinePathViolations(root, paths, tracked).join("\n"), /stale machine path allowlist/);
    writeFileSync(join(root, "packages/demo/src/a.ts"), "");
    assert.match(machinePathViolations(root, paths, tracked).join("\n"), /remove or narrow/);
  });
});

test("package contracts require scripts and base tsconfig inheritance, including indirect inheritance", () => {
  fixture({
    "tsconfig.base.json": "{}",
    "packages/good/package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
    "packages/good/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
    "packages/bad/package.json": JSON.stringify({ scripts: {} }),
    "packages/bad/tsconfig.json": "{}",
    "packages/bad/src/a.test.ts": "",
  }, root => {
    const errors = packageContractViolations(root);
    assert.equal(errors.length, 3);
    assert.match(errors.join("\n"), /typecheck script/);
    assert.match(errors.join("\n"), /test script/);
    assert.match(errors.join("\n"), /inherit tsconfig.base.json/);
    writeFileSync(join(root, "packages/bad/package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run" } }));
    writeFileSync(join(root, "packages/bad/tsconfig.json"), '{"extends":"../good/tsconfig.json",}');
    assert.deepEqual(packageContractViolations(root), []);
    writeFileSync(join(root, "packages/bad/tsconfig.json"), '{"extends":"./tsconfig.json"}');
    assert.match(packageContractViolations(root).join("\n"), /inherit tsconfig.base.json/);
  });
});

test("git scan handles constant options, templates and remote branch deletion without counting observations", () => {
  fixture({ "packages/demo/src/a.ts": `
const hardening = ["-c", "core.hooksPath=/dev/null"] as const;
runGit(root, [...hardening, "merge", "--ff-only", sha]);
execSync(\`git push origin \${branch}\`);
runner.run("git", ["branch", "-r", "-D", branch]);
git("tag", "v1"); git("worktree", "add", path);
runGit(root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
// execSync("git push");
const example = "git push";
` }, root => {
    assert.deepEqual(gitWriteFindings(root).map(x => x.command), ["merge", "push", "branch", "tag", "worktree add"]);
  });
});

test("separate rules cover cloud shapes, token prefixes, Linux and Windows paths", () => {
  const contents = ["gh" + "o_fake", "gh" + "s_fake", "github" + "_pat_fake", "AI" + "za" + "x".repeat(35), "LT" + "AI" + "a".repeat(16), "-----BEGIN " + "PRIVATE KEY-----", "/" + "home/alice/work/", "C:" + "\\Users\\alice\\work\\"];
  fixture({ "scripts/a.txt": contents.join("\n") }, root => {
    assert.equal(secretFindings(root, ["scripts/a.txt"]).length, 6);
    assert.equal(machinePathFindings(root, ["scripts/a.txt"]).length, 2);
  });
});

test("pure core rejects network APIs, imports and remote subprocesses", async () => {
  const { coreNetworkFindings, coreNetworkViolations } = await import("./check-deterministic-rules.mjs");
  const bad = [
    'fetch(url)', 'globalThis.fetch(url)', 'globalThis["fetch"](url)', 'const request = fetch; request(url)',
    'const { fetch: request } = globalThis; request(url)',
    'new WebSocket(url)', 'const Socket = WebSocket; new Socket(url)',
    ...["http", "https", "net", "tls", "dgram", "dns/promises"].map(name => `import x from "node:${name}"`),
    'await import("undici")', 'const client = require("axios")', 'export * from "https"',
    'import { execFileSync as run } from "node:child_process"; run("curl", [url])',
    'import * as cp from "node:child_process"; cp.spawn("gh", ["api", path])',
    'const cp = require("child_process"); cp.execSync("git -C repo fetch origin")',
    'import { execFileSync } from "child_process"; execFileSync("git", ["remote", "show", "origin"])',
    'import { spawn } from "child_process"; spawn("git", ["submodule", "update", "--init"])',
    'import { spawn } from "child_process"; spawn("git", ["archive", "--remote=origin", "HEAD"])',
    'import { spawn } from "node:child_process"; const command = "git"; const args = ["ls-remote", "origin"]; spawn(command, args)',
    `import { execSync } from "node:child_process"; execSync(\`curl \${url}\`)`,
  ];
  for (const content of bad) fixture({ "packages/core/src/state/a.ts": content }, root => {
    assert.ok(coreNetworkFindings(root).length > 0, content);
    assert.match(coreNetworkViolations(root, []).join("\n"), /adapter or CLI.*parameters/);
  });
  fixture({
    "packages/core/src/bridge/a.ts": 'export const decide = (result: boolean) => result; // fetch(url)',
    "packages/core/src/state/a.test.ts": 'fetch(url)',
    "packages/core/src/state/fixtures/a.ts": 'fetch(url)',
    "packages/agents/src/adapters/a.ts": 'fetch(url)',
    "packages/core/src/hermes/a.ts": 'fetch(url)',
    "packages/core/src/policy/a.ts": 'import { execFileSync } from "node:child_process"; execFileSync("git", ["status"]);',
  }, root => assert.deepEqual(coreNetworkViolations(root, []), []));
  for (const directory of ["bridge", "policy", "kanban", "privacy", "orchestrator", "graph"]) {
    fixture({ [`packages/core/src/${directory}/a.ts`]: 'fetch(url)' }, root => assert.equal(coreNetworkFindings(root).length, 1));
  }
  fixture({ "packages/core/src/state/a.ts": 'fetch(url); fetch(other)' }, root => {
    const entry = { file: "packages/core/src/state/a.ts", count: 2, reason: "legacy transport pending extraction" };
    assert.deepEqual(coreNetworkViolations(root, [entry]), []);
    for (const count of [1, 3]) assert.match(coreNetworkViolations(root, [{ ...entry, count }]).join("\n"), /remove or narrow/);
    writeFileSync(join(root, entry.file), "");
    assert.match(coreNetworkViolations(root, [entry]).join("\n"), /stale/);
  });
});

test("core product names check literals and identifier words, preserving adapter constant references", async () => {
  const { coreProductFindings, coreProductViolations } = await import("./check-deterministic-rules.mjs");
  for (const content of ['const agent = "codex-cli"', 'const claudeModel = value', 'const DEEPSEEK_MODEL = value',
    `const model = \`gemini-\${version}\``, 'const model = "gpt-5"', 'const model = "glm-4"',
    'const kimi = value', 'const name = "OpenAI"', 'const name = "anthropic"',
    'const name = "hermes"', 'const name = "opencode"', 'const name = "zcode"',
    'const name = "google-stitch"', 'const GoogleStitchAdapter = value', 'const DeepSeekAdapter = value', 'const OpenAIModel = value', 'const name = "ds-review"', 'const agent = { "claude-code": value }']) {
    fixture({ "packages/core/src/a.ts": content }, root => {
      assert.ok(coreProductFindings(root).length > 0, content);
      assert.match(coreProductViolations(root, []).join("\n"), /exported constants.*adapter/);
    });
  }
  fixture({ "packages/core/src/a.ts": 'import { CODEX_ID } from "@osstack/agents"; function choose() { const CODEX_ID = "generic"; return CODEX_ID; }' }, root => {
    assert.equal(coreProductFindings(root).length, 2);
  });
  for (const pkg of ["protocol", "loop", "autonomy", "contracts", "governance", "graph", "plugins"]) {
    fixture({ [`packages/${pkg}/src/engine.ts`]: 'const id = "codex-cli.code.write"' }, root => assert.equal(coreProductFindings(root).length, 1));
  }
  fixture({
    "packages/core/src/a.ts": `import { CODEX_AGENT_ID, type HermesEvent } from "@osstack/agents";
const agent = CODEX_AGENT_ID; type Event = HermesEvent;
import { CODEX_ID as AGENT_ID } from "@osstack/agents";
import * as adapters from "@osstack/agents";
const other = adapters.CODEX_ID;
export { CODEX_ID as DEFAULT_AGENT_ID } from "@osstack/agents";
const decoded = "clause", kimimic = "codexterity"; const regpt = "engpt-5";
// claude and codex are only comments
const fetchResult = input;`,
    "packages/core/src/a.test.ts": 'const agent = "claude"',
    "packages/core/src/fixtures/a.ts": 'const agent = "claude"',
    "packages/agents/src/adapters/a.ts": 'const agent = "claude"',
    "packages/hermes-adapter/src/a.ts": 'const agent = "hermes"',
    "packages/core/src/hermes/a.ts": 'const agent = "hermes"',
    "packages/core/src/kg/a.ts": 'const agent = "hermes"',
    "packages/governance/src/knowledge-hygiene/adapters/a.ts": 'const agent = "claude"',
  }, root => assert.deepEqual(coreProductViolations(root, []), []));
  fixture({ "packages/core/src/a.ts": 'const agent = "claude"; const model = "gpt-5"' }, root => {
    const entry = { file: "packages/core/src/a.ts", count: 2, reason: "legacy routing defaults" };
    assert.deepEqual(coreProductViolations(root, [entry]), []);
    for (const count of [1, 3]) assert.match(coreProductViolations(root, [{ ...entry, count }]).join("\n"), /remove or narrow/);
    assert.match(coreProductViolations(root, [entry, entry]).join("\n"), /stale/);
    writeFileSync(join(root, entry.file), "");
    assert.match(coreProductViolations(root, [entry]).join("\n"), /stale/);
  });
});

for (const [name, files] of Object.entries({
  direct: { "instruction-boundary.ts": 'import "./external-reference.js";', "external-reference.ts": "export {};" },
  transitive: { "instruction-boundary.ts": 'import "./helper.js";', "helper.ts": 'export * from "./reference-segment.js";', "reference-segment.ts": "export {};" },
  typeImport: { "instruction-boundary.ts": 'import type { Result } from "./verification-result.js";', "verification-result.ts": "export type Result = {};" },
  reader: { "instruction-boundary.ts": 'import "./source-reader.js";', "source-reader.ts": "export {};" },
  any: { "instruction-boundary.ts": "let data: any;" },
  cast: { "instruction-boundary.ts": "const data = value as unknown as Config;" },
  ignore: { "instruction-boundary.ts": "// @ts-ignore\nconst a = 1;" },
  expect: { "instruction-boundary.ts": "// @ts-expect-error\nconst a = 1;" },
  nocheck: { "instruction-boundary.ts": "// @ts-nocheck\nconst a = 1;" },
  callAny: { "caller.ts": "buildInstructionSegment(value as any);" },
  callUnknown: { "caller.ts": "buildInstructionSegment(value as unknown as Config);" },
  callAs: { "caller.ts": "buildInstructionSegment(value as Config);" },
  callAngle: { "caller.ts": "buildInstructionSegment(<Config>value);" },
  callNested: { "caller.ts": "buildInstructionSegment(wrap(value as Config));" },
})) {
  test(`instruction boundary rejects ${name}`, () => fixture(Object.fromEntries(Object.entries(files).map(([name, text]) => [`packages/demo/src/${name}`, text])), root => {
    assert.match(instructionBoundaryViolations(root).join("\n"), /packages\/demo\/src\/.*:\d+/);
  }));
}
test("instruction boundary accepts clean code and excludes test callers", () => fixture({
  "packages/demo/src/instruction-boundary.ts": 'import { createHash } from "node:crypto"; const text = "any as unknown as @ts-ignore";',
  "packages/demo/src/caller.ts": "buildInstructionSegment(config);",
  "packages/demo/src/caller.test.ts": "buildInstructionSegment(value as any);",
}, root => assert.deepEqual(instructionBoundaryViolations(root), [])));
