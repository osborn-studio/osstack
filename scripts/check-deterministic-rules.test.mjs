import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  docsLinkViolations,
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
