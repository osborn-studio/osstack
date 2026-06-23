#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-release-plan-smoke-"));
const output = join(tempRoot, "release-plan.md");
const cacheDir = join(tempRoot, "knowledge-cache");
let cloud;

try {
  cloud = await startKnowledgeCloudHandoffServer();
  const cloudUrl = cloud.url;
  const result = await runAsync(process.execPath, [
    "packages/cli/dist/bin.js",
    "release",
    "plan",
    "--target",
    "all",
    "--cloud-url",
    cloudUrl,
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
  assertArrayIncludes(plan.deploy_commands, `osstack knowledge login --cloud-url ${cloudUrl}`, "deploy commands must login to the supplied Knowledge Cloud URL");
  assertArrayIncludes(plan.deploy_commands, `osstack knowledge sync --cloud-url ${cloudUrl} --json`, "deploy commands must sync from the supplied Knowledge Cloud URL");
  assertArrayIncludes(plan.deploy_commands, `osstack knowledge search "proof pack checksum" --cloud-url ${cloudUrl} --json`, "deploy commands must search the supplied Knowledge Cloud URL");
  assertArrayIncludes(plan.post_release_validation_commands, "npm view @osstack/cli version --json", "post-release commands must confirm @osstack/cli is visible in npm registry");
  assertArrayIncludes(plan.post_release_validation_commands, "osstack release doctor --target npm --json", "post-release commands must include npm doctor");
  assertArrayIncludes(
    plan.post_release_validation_commands,
    `osstack release doctor --target knowledge-cloud --cloud-url ${cloudUrl} --json`,
    "post-release commands must include deployed Knowledge Cloud doctor",
  );
  assertArrayIncludes(plan.post_release_validation_commands, "osstack release doctor --target single-binary --json", "post-release commands must include single-binary doctor");
  assertArrayIncludes(
    plan.post_release_validation_commands,
    "gh release download v<version> --repo gilosbornhello/osstack --pattern 'osstack-*.tar.gz' --pattern 'osstack-*.archive.json' --pattern 'osstack-*.sbom.spdx.json' --pattern 'sha256sums.txt'",
    "post-release commands must download all single-binary release evidence assets",
  );
  assertArrayIncludes(plan.post_release_validation_commands, "test -s osstack-*.archive.json && test -s osstack-*.sbom.spdx.json", "post-release commands must verify single-binary manifest and SBOM assets are present");
  assertArrayIncludes(plan.post_release_validation_commands, "tar -xzf osstack-*.tar.gz", "post-release commands must extract the release archive before checksum verification");
  assertArrayIncludes(plan.post_release_validation_commands, "shasum -a 256 -c sha256sums.txt", "post-release commands must include release checksum verification");

  const markdown = await readFile(output, "utf-8");
  assertIncludes(markdown, "# Osstack Release Action Plan", "markdown plan must render a title");
  assertIncludes(markdown, "## Validation Commands", "markdown plan must render validation commands");
  assertIncludes(markdown, "## Publish Commands", "markdown plan must render publish commands");
  assertIncludes(markdown, "## Deploy Commands", "markdown plan must render deploy commands");
  assertIncludes(markdown, "## Post-Release Validation Commands", "markdown plan must render post-release validation commands");
  assertIncludes(markdown, "pnpm smoke:release-plan", "markdown validation commands must include release plan smoke");
  assertIncludes(markdown, `osstack release doctor --target knowledge-cloud --cloud-url ${cloudUrl} --json`, "markdown post-release commands must include Knowledge Cloud doctor");

  const sync = JSON.parse((await runAsync(process.execPath, [
    "packages/cli/dist/bin.js",
    "knowledge",
    "sync",
    "--cloud-url",
    cloudUrl,
    "--cache-dir",
    cacheDir,
    "--json",
  ], {
    cwd: root,
    env: process.env,
  })).stdout);
  assert(sync.status === "synced", "post-release knowledge sync command must complete");
  assert(sync.packs?.some((pack) => pack.id === "osstack-core/proof-and-scorecard"), "post-release knowledge sync must cache proof pack guidance");

  const search = JSON.parse((await runAsync(process.execPath, [
    "packages/cli/dist/bin.js",
    "knowledge",
    "search",
    "proof pack checksum",
    "--cloud-url",
    cloudUrl,
    "--cache-dir",
    cacheDir,
    "--json",
  ], {
    cwd: root,
    env: process.env,
  })).stdout);
  assert(search.mode === "cloud", "post-release knowledge search command must use the cloud URL");
  assert(search.results?.some((result) => result.chunk_id === "proof-checksum-pack"), "post-release knowledge search must find proof checksum guidance");

  console.log(JSON.stringify({
    ok: true,
    kind: "release-plan-smoke",
    output,
    cloud_url: cloudUrl,
    target: plan.target,
    validation_commands: plan.validation_commands.length,
    publish_commands: plan.publish_commands.length,
    deploy_commands: plan.deploy_commands.length,
    post_release_validation_commands: plan.post_release_validation_commands.length,
    knowledge_sync: sync.status,
    knowledge_search: search.results[0]?.chunk_id ?? null,
  }, null, 2));
} finally {
  if (cloud !== undefined) await cloud.close();
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
      "EDGEONE_DEPLOY_HOOK_URL",
      "APPLE_ID",
      "APPLE_TEAM_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "DEVELOPER_ID_APPLICATION",
      "MACOS_CERTIFICATE_P12",
      "MACOS_CERTIFICATE_PASSWORD",
    ].join(","),
    OSSTACK_TEST_RELEASE_NPM_AUTH: "ok",
    OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS: "ok",
    OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK: "ok",
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

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (status) => {
      if (status !== 0) {
        const output = [stdout, stderr].filter(Boolean).join("\n");
        reject(new Error(`${command} ${args.join(" ")} failed with ${status}${output ? `\n${output}` : ""}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
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

function startKnowledgeCloudHandoffServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { ok: true, service: "osstack-knowledge-cloud", packs: 6 });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/search") {
      writeJson(response, 200, {
        packs: [{
          id: "osstack-core/proof-and-scorecard",
          version: "2026.06.22",
          license: "Osstack-native",
          source_kind: "osstack_native",
          quality_score: 95,
        }],
        results: [{
          chunk_id: "proof-checksum-pack",
          pack_id: "osstack-core/proof-and-scorecard",
          pack_version: "2026.06.22",
          title: "Proof checksum pack",
          score: 1,
          snippet: "Post-release Knowledge Cloud validation must find proof pack checksum guidance before handoff.",
          tags: ["proof", "checksum", "release"],
          source_refs: ["release-plan-smoke-proof"],
        }],
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sync") {
      writeJson(response, 200, { packs: [proofPack()] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/audit") {
      writeJson(response, 200, { filters: { action: "search", status: "ok", limit: 1 }, events: [] });
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("release plan smoke server did not bind a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => {
            if (error !== undefined) closeReject(error);
            else closeResolve();
          });
        }),
      });
    });
  });
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function proofPack() {
  return {
    id: "osstack-core/proof-and-scorecard",
    version: "2026.06.22",
    name: "Proof and Scorecard",
    license: "Osstack-native",
    source_kind: "osstack_native",
    quality_score: 95,
    scope: "official",
    last_reviewed_at: "2026-06-22T00:00:00.000Z",
    taxonomy: ["osstack-core/proof-and-scorecard"],
    review: {
      status: "approved",
      reviewer_id: "release-plan-smoke",
      reviewed_at: "2026-06-22T00:00:00.000Z",
      summary: "Release plan smoke pack for post-release Knowledge Cloud validation.",
    },
    source_attribution: ["osstack release plan smoke"],
    source_provenance: [{
      source_id: "release-plan-smoke-proof",
      path: "release-plan-smoke-proof.md",
      sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      license: "Osstack-native",
      scope: "official",
      imported_at: "2026-06-22T00:00:00.000Z",
    }],
    chunks: [{
      chunk_id: "proof-checksum-pack",
      title: "Proof checksum pack",
      body: "Post-release Knowledge Cloud validation must find proof pack checksum guidance before handoff.",
      tags: ["proof", "checksum", "release"],
      source_refs: ["release-plan-smoke-proof"],
    }],
  };
}
