#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-release-plan-smoke-"));
const output = join(tempRoot, "release-plan.md");

try {
  const result = run(process.execPath, [
    "packages/cli/dist/bin.js",
    "release",
    "plan",
    "--target",
    "all",
    "--output",
    output,
    "--json",
  ], {
    cwd: root,
    capture: true,
    env: releasePlanEnv(),
  });
  const plan = JSON.parse(result.stdout);
  assert(plan.ready === true, "release plan smoke expects all target to be ready under controlled overrides");
  assert(plan.safe_to_execute === true, "release plan smoke expects publish/deploy commands to be safe under controlled overrides");
  assertArrayIncludes(plan.validation_commands, "pnpm smoke:release-plan", "validation commands must include release plan smoke");
  assertArrayIncludes(plan.validation_commands, "pnpm smoke:npm-install", "validation commands must include npm install smoke");
  assertArrayIncludes(plan.validation_commands, "pnpm smoke:knowledge-cloud:deploy", "validation commands must include Knowledge Cloud deploy smoke");
  assertArrayIncludes(plan.validation_commands, "pnpm smoke:single-binary-release-pack", "validation commands must include single-binary pack smoke");
  assertArrayIncludes(plan.publish_commands, "npm install -g @osstack/cli", "publish commands must include registry install verification");
  assertArrayIncludes(plan.deploy_commands, "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true", "deploy commands must include Knowledge Cloud deploy workflow");
  assertArrayIncludes(plan.post_release_validation_commands, "osstack release doctor --target npm --json", "post-release commands must include npm doctor");
  assertArrayIncludes(
    plan.post_release_validation_commands,
    "osstack release doctor --target knowledge-cloud --cloud-url https://knowledge.osstack.ai --json",
    "post-release commands must include deployed Knowledge Cloud doctor",
  );
  assertArrayIncludes(plan.post_release_validation_commands, "shasum -a 256 -c sha256sums.txt", "post-release commands must include release checksum verification");

  const markdown = await readFile(output, "utf-8");
  assertIncludes(markdown, "# Osstack Release Action Plan", "markdown plan must render a title");
  assertIncludes(markdown, "## Validation Commands", "markdown plan must render validation commands");
  assertIncludes(markdown, "## Publish Commands", "markdown plan must render publish commands");
  assertIncludes(markdown, "## Deploy Commands", "markdown plan must render deploy commands");
  assertIncludes(markdown, "## Post-Release Validation Commands", "markdown plan must render post-release validation commands");
  assertIncludes(markdown, "pnpm smoke:release-plan", "markdown validation commands must include release plan smoke");
  assertIncludes(markdown, "osstack release doctor --target knowledge-cloud --cloud-url https://knowledge.osstack.ai --json", "markdown post-release commands must include Knowledge Cloud doctor");

  console.log(JSON.stringify({
    ok: true,
    kind: "release-plan-smoke",
    output,
    target: plan.target,
    validation_commands: plan.validation_commands.length,
    publish_commands: plan.publish_commands.length,
    deploy_commands: plan.deploy_commands.length,
    post_release_validation_commands: plan.post_release_validation_commands.length,
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_RELEASE_PLAN_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept release plan smoke dir: ${tempRoot}`);
  }
}

function releasePlanEnv() {
  return {
    ...process.env,
    OSSTACK_TEST_RELEASE_GITHUB_AUTH: "ok",
    OSSTACK_TEST_RELEASE_GITHUB_ACTIONS: "ok",
    OSSTACK_TEST_RELEASE_SECRETS: [
      "NPM_TOKEN",
      "FLY_API_TOKEN",
      "APPLE_ID",
      "APPLE_TEAM_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "DEVELOPER_ID_APPLICATION",
      "MACOS_CERTIFICATE_P12",
      "MACOS_CERTIFICATE_PASSWORD",
    ].join(","),
    OSSTACK_TEST_RELEASE_NPM_AUTH: "ok",
    OSSTACK_TEST_RELEASE_FLY_AUTH: "ok",
    OSSTACK_TEST_RELEASE_VERSION_PR: "none",
    OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW: "ok",
    OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW: "ok",
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf-8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}${output ? `\n${output}` : ""}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertArrayIncludes(items, expected, message) {
  assert(Array.isArray(items), `${message}: command list is not an array`);
  assert(items.includes(expected), `${message}: missing ${JSON.stringify(expected)}`);
}

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)}`);
  }
}
