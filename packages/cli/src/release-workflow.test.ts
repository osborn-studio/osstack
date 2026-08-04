import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trustedPublishingWorkflowViolations } from "./bin.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("trustedPublishingWorkflowViolations", () => {
  it("accepts a tokenless Changesets publish step", () => {
    const workflow = `
      - name: Version PR / Publish
        uses: changesets/action@v1
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
    `;

    expect(trustedPublishingWorkflowViolations(workflow)).toEqual([]);
  });

  it.each(["NPM_TOKEN", "NODE_AUTH_TOKEN"])("rejects %s in the publish step", (tokenName) => {
    const workflow = `
      - name: Version PR / Publish
        uses: changesets/action@v1
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ${tokenName}: legacy-token
    `;

    expect(trustedPublishingWorkflowViolations(workflow)).toEqual([
      "Release publish step must not expose long-lived npm tokens when using Trusted Publishing.",
    ]);
  });

  it("keeps generated release artifacts and version-branch CI automatic", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const ciWorkflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(manifest.scripts["version:packages"]).toBe("node scripts/version-packages.mjs");
    expect(manifest.scripts.release).toContain("publish-packages-safely.mjs");
    expect(manifest.scripts["smoke:npm-publish-order"]).toBe(
      "node scripts/smoke-npm-publish-order.mjs",
    );
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("version: pnpm version:packages");
    expect(workflow).toContain("pnpm smoke:npm-publish-order");
    expect(workflow).toContain("id: changesets");
    expect(workflow).toContain("gh workflow run ci.yml --ref changeset-release/main");
    expect(ciWorkflow).toContain("workflow_dispatch:");
    expect(ciWorkflow).toContain("pnpm smoke:npm-publish-order");
  });
});

describe("CLI-backed root scripts", () => {
  it.each([
    "smoke:release-plan",
    "smoke:neat",
    "eval:neat-goldens",
    "eval:neat-parity:offline",
  ])("builds workspace dependencies before running %s", (scriptName) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(manifest.scripts[scriptName]).toContain("pnpm --filter @osstack/cli... build");
  });
});

describe("paid semantic provider CI boundary", () => {
  it("exposes credentials only to explicitly selected manual smoke jobs", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const checkStart = workflow.indexOf("  check:");
    const deepSeekStart = workflow.indexOf("  paid_deepseek_semantic:");
    const qwenStart = workflow.indexOf("  paid_qwen_semantic:");

    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("semantic_provider:");
    expect(workflow).toContain("- deepseek-no-tools");
    expect(workflow).toContain("- qwen-no-tools");
    expect(deepSeekStart).toBeGreaterThan(checkStart);
    expect(qwenStart).toBeGreaterThan(deepSeekStart);

    const checkJob = workflow.slice(checkStart, deepSeekStart);
    const deepSeekJob = workflow.slice(deepSeekStart, qwenStart);
    const qwenJob = workflow.slice(qwenStart);

    expect(checkJob).not.toContain("DEEPSEEK_API_KEY");
    expect(checkJob).not.toContain("DASHSCOPE_API_KEY");
    expect(deepSeekJob).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.semantic_provider == 'deepseek-no-tools'",
    );
    expect(deepSeekJob).toContain(`DEEPSEEK_API_KEY: \${{ secrets.DEEPSEEK_API_KEY }}`);
    expect(deepSeekJob).toContain(
      `OSSTACK_NEAT_DEEPSEEK_MODEL: \${{ vars.OSSTACK_NEAT_DEEPSEEK_MODEL }}`,
    );
    expect(deepSeekJob).not.toContain("DASHSCOPE_API_KEY");
    expect(qwenJob).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.semantic_provider == 'qwen-no-tools'",
    );
    expect(qwenJob).toContain(`DASHSCOPE_API_KEY: \${{ secrets.DASHSCOPE_API_KEY }}`);
    expect(qwenJob).toContain(
      `OSSTACK_NEAT_QWEN_MODEL: \${{ vars.OSSTACK_NEAT_QWEN_MODEL }}`,
    );
    expect(qwenJob).not.toContain("DEEPSEEK_API_KEY");
  });
});

describe("npm install acceptance smoke", () => {
  it("runs the CLI-daemon version handshake self-test before the full install smoke", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(manifest.scripts["smoke:npm-install"]).toBe(
      "node scripts/smoke-npm-install.mjs --self-test && node scripts/smoke-npm-install.mjs",
    );
  });
});

describe("npm Trusted Publisher recovery", () => {
  it("keeps configuration non-mutating unless the operator explicitly executes it", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(manifest.scripts["configure:npm-trust"]).toBe(
      "node scripts/configure-npm-trusted-publishers.mjs",
    );
    expect(manifest.scripts["smoke:npm-trust"]).toBe(
      "node scripts/smoke-npm-trusted-publishers.mjs && node scripts/smoke-npm-trust-configuration.mjs",
    );
  });
});

describe("broken npm release recovery", () => {
  it("keeps exact-version deprecation non-mutating unless explicitly executed", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const ciWorkflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(manifest.scripts["deprecate:npm-broken"]).toBe(
      "node scripts/deprecate-broken-npm-versions.mjs",
    );
    expect(manifest.scripts["smoke:npm-deprecation"]).toBe(
      "node scripts/smoke-npm-broken-deprecation.mjs",
    );
    expect(workflow).toContain("pnpm smoke:npm-deprecation");
    expect(ciWorkflow).toContain("pnpm smoke:npm-deprecation");
  });
});
