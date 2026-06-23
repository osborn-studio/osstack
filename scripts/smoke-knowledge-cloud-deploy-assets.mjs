#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dockerfile = await read("Dockerfile.knowledge-cloud");
const edgeone = await read("deploy/knowledge-cloud/edgeone.json");
const render = await read("deploy/knowledge-cloud/render.yaml");
const workflow = await read(".github/workflows/knowledge-cloud-deploy.yml");
const edgeOneFunction = await read("cloud-functions/[[default]].js");
const edgeOneHealthFunction = await read("cloud-functions/healthz.js");
const edgeOneFunctionPackage = await read("cloud-functions/package.json");
const edgeOneOfficialPacks = await read("cloud-functions/official-packs.js");

assertIncludes(dockerfile, "EXPOSE 8787", "Dockerfile must expose the Knowledge Cloud port");
assertIncludes(dockerfile, "FROM node:22-slim", "Dockerfile must use Node 22 for pnpm and node:sqlite support");
assertIncludes(dockerfile, "tsconfig.base.json", "Dockerfile must copy the root TypeScript config used by package builds");
assertIncludes(dockerfile, "/healthz", "Dockerfile must include the health endpoint");
assertIncludes(dockerfile, "packages/knowledge-cloud/dist/bin.js", "Dockerfile must start the Knowledge Cloud executable");

assertIncludes(edgeone, '"provider": "tencent-edgeone"', "EdgeOne deploy config must identify Tencent EdgeOne");
assertIncludes(edgeone, '"mode": "pages-functions"', "EdgeOne deploy config must use Pages Functions mode");
assertIncludes(edgeone, '"healthcheck_path": "/healthz"', "EdgeOne deploy config must healthcheck /healthz");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_CLOUD_HOST": "0.0.0.0"', "EdgeOne deploy config must bind externally");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_AUDIT_LOG": "/data/audit/knowledge-cloud-audit.jsonl"', "EdgeOne deploy config must persist Knowledge Cloud audit JSONL");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_FEEDBACK_LOG": "/data/feedback/feedback.jsonl"', "EdgeOne deploy config must persist Knowledge Cloud feedback JSONL");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR": "/data/published-packs"', "EdgeOne deploy config must persist published Knowledge Cloud packs");
assertIncludes(edgeone, '"knowledge-packs/official/**"', "EdgeOne deploy config must include official knowledge packs");
assertIncludes(edgeone, '"deploy_secret": "EDGEONE_API_TOKEN"', "EdgeOne deploy config must declare the EdgeOne API token secret");
assertIncludes(edgeone, '"fallback_deploy_secret": "EDGEONE_DEPLOY_HOOK_URL"', "EdgeOne deploy config must retain the deploy hook fallback secret");
assertIncludes(edgeone, '"project_name": "osstack-knowledge-cloud"', "EdgeOne deploy config must declare the Makers project name");
assertIncludes(edgeOneFunction, "export default async function onRequest", "EdgeOne Cloud Function must export an onRequest handler");
assertIncludes(edgeOneFunction, 'from "./official-packs.js"', "EdgeOne Cloud Function must load official packs from the function bundle");
assertIncludes(edgeOneFunction, 'url.pathname === "/healthz"', "EdgeOne Cloud Function must serve /healthz");
assertIncludes(edgeOneFunction, 'url.pathname === "/v1/search"', "EdgeOne Cloud Function must serve /v1/search");
assertIncludes(edgeOneFunction, "function searchPacks", "EdgeOne Cloud Function must include self-contained search");
assertIncludes(edgeOneHealthFunction, "osstack-knowledge-cloud", "EdgeOne /healthz function must return Knowledge Cloud service metadata");
assertIncludes(edgeOneFunctionPackage, '"type": "module"', "EdgeOne Cloud Function package must opt into ESM");
assertIncludes(edgeOneOfficialPacks, "proof-checksum-pack", "EdgeOne function bundle must include official proof knowledge pack data");
assertIncludes(edgeOneOfficialPacks, "architecture-control-plane", "EdgeOne function bundle must include official architecture knowledge pack data");
assertIncludes(edgeOneOfficialPacks, "contract-validation-proof", "EdgeOne function bundle must include official contract validation knowledge pack data");
assertIncludes(edgeOneOfficialPacks, "testing-eval-gates", "EdgeOne function bundle must include official testing/eval knowledge pack data");
assertIncludes(edgeOneOfficialPacks, "operations-release-runbook", "EdgeOne function bundle must include official operations knowledge pack data");

assertIncludes(render, "dockerfilePath: ./Dockerfile.knowledge-cloud", "Render deploy config must use the Knowledge Cloud Dockerfile");
assertIncludes(render, "healthCheckPath: /healthz", "Render deploy config must healthcheck /healthz");
assertIncludes(render, "value: 8787", "Render deploy config must set the Knowledge Cloud port");
assertIncludes(render, "OSSTACK_KNOWLEDGE_AUDIT_LOG", "Render deploy config must persist Knowledge Cloud audit JSONL");
assertIncludes(render, "OSSTACK_KNOWLEDGE_FEEDBACK_LOG", "Render deploy config must persist Knowledge Cloud feedback JSONL");
assertIncludes(render, "OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR", "Render deploy config must persist published Knowledge Cloud packs");

assertIncludes(workflow, "workflow_dispatch:", "Knowledge Cloud deploy workflow must be manually triggerable");
assertIncludes(workflow, "cancel-in-progress: true", "Knowledge Cloud deploy workflow must cancel older in-progress deploy runs");
assertIncludes(workflow, "cloud_url:", "Knowledge Cloud deploy workflow must accept a deployed cloud URL for validation");
assertIncludes(workflow, "pnpm smoke:knowledge-cloud", "Knowledge Cloud deploy workflow must run service smoke");
assertIncludes(workflow, "pnpm smoke:knowledge-cloud:deploy", "Knowledge Cloud deploy workflow must run deploy asset smoke");
assertIncludes(workflow, "docker build -f Dockerfile.knowledge-cloud", "Knowledge Cloud deploy workflow must build the Docker image");
assertIncludes(workflow, "secrets.EDGEONE_API_TOKEN", "Knowledge Cloud deploy workflow must gate EdgeOne CLI deploy on EDGEONE_API_TOKEN");
assertIncludes(workflow, "edgeone@latest makers deploy . -n osstack-knowledge-cloud", "Knowledge Cloud deploy workflow must deploy with the EdgeOne Makers CLI");
assertIncludes(workflow, "timeout-minutes: 10", "Knowledge Cloud deploy workflow must bound the EdgeOne CLI step runtime");
assertIncludes(workflow, "timeout --foreground --kill-after=30s 8m npx edgeone@latest", "Knowledge Cloud deploy workflow must kill a hung EdgeOne CLI deploy command before the job timeout");
assertIncludes(workflow, "EdgeOne CLI deploy exceeded the 8 minute command timeout", "Knowledge Cloud deploy workflow must explain EdgeOne CLI timeout failures");
assertIncludes(workflow, "Deploy Success", "Knowledge Cloud deploy workflow must tolerate EdgeOne post-success status lookup failures");
assertIncludes(workflow, "EDGEONE_DEPLOY_HOOK_URL", "Knowledge Cloud deploy workflow must retain the deploy hook fallback");
assertIncludes(workflow, "deploy=true requires repository secret EDGEONE_API_TOKEN or EDGEONE_DEPLOY_HOOK_URL", "Knowledge Cloud deploy=true must fail when no EdgeOne deploy credential is configured");
assertIncludes(workflow, 'curl -fsS -X POST "$EDGEONE_DEPLOY_HOOK_URL"', "Knowledge Cloud deploy workflow must trigger the EdgeOne deploy hook fallback");
assertIncludes(workflow, "release doctor --target knowledge-cloud --cloud-url", "Knowledge Cloud deploy workflow must validate the deployed health/search/audit gates when cloud_url is supplied");
assertIncludes(workflow, 'knowledge sync --cloud-url "${{ inputs.cloud_url }}" --json', "Knowledge Cloud deploy workflow must sync from the deployed cloud URL when supplied");
assertIncludes(workflow, 'knowledge search "proof pack checksum" --cloud-url "${{ inputs.cloud_url }}" --json', "Knowledge Cloud deploy workflow must search the deployed cloud URL when supplied");
assertIncludes(workflow, "OSSTACK_TEST_RELEASE_GITHUB_AUTH: ok", "Knowledge Cloud deploy workflow must keep post-deploy validation focused on the deployed URL inside CI");
assertIncludes(workflow, "OSSTACK_TEST_RELEASE_SECRETS: EDGEONE_API_TOKEN", "Knowledge Cloud deploy workflow must provide release doctor CI secret evidence after the deploy gate has passed");

const edgeOneHandler = await import(new URL("../cloud-functions/%5B%5Bdefault%5D%5D.js", import.meta.url));
const health = await edgeOneHandler.default({ request: new Request("https://knowledge.osstack.ai/healthz") });
if (health.status !== 200) throw new Error("EdgeOne Cloud Function /healthz smoke must return HTTP 200");
const healthBody = await health.json();
if (healthBody.ok !== true || healthBody.service !== "osstack-knowledge-cloud") {
  throw new Error("EdgeOne Cloud Function /healthz smoke returned invalid service metadata");
}
const search = await edgeOneHandler.default({
  request: new Request("https://knowledge.osstack.ai/v1/search", {
    method: "POST",
    body: JSON.stringify({ query: "proof pack checksum", limit: 5 }),
  }),
});
if (search.status !== 200) throw new Error("EdgeOne Cloud Function /v1/search smoke must return HTTP 200");
const searchBody = await search.json();
if (!Array.isArray(searchBody.results) || searchBody.results.length === 0) {
  throw new Error("EdgeOne Cloud Function /v1/search smoke must return matching knowledge chunks");
}

const tmp = await mkdtemp(join(tmpdir(), "osstack-knowledge-cloud-deploy-"));
const catalogPath = join(tmp, "catalog.json");
const catalogRun = spawnSync(process.execPath, [
  "scripts/build-knowledge-cloud-publish-catalog.mjs",
  "--output",
  catalogPath,
], { encoding: "utf-8" });
if (catalogRun.status !== 0) {
  throw new Error(`Knowledge Cloud publish catalog smoke failed:\n${catalogRun.stdout}\n${catalogRun.stderr}`);
}
const catalog = JSON.parse(await read(catalogPath));
if (catalog.artifact_kind !== "osstack_knowledge_publish_catalog") {
  throw new Error("Knowledge Cloud publish catalog must identify its artifact kind");
}
if (!Array.isArray(catalog.packs) || catalog.packs.length < 10) {
  throw new Error("Knowledge Cloud publish catalog must include the official pack set");
}
if (catalog.packs.some((pack) => pack?.publish_gate?.ok !== true)) {
  throw new Error("Knowledge Cloud publish catalog must only contain publish-gate passing official packs");
}
if (catalog.retrieval_eval?.failed !== 0 || catalog.retrieval_eval?.passed < 42) {
  throw new Error("Knowledge Cloud publish catalog must include passing retrieval eval evidence");
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    "Dockerfile.knowledge-cloud",
    "deploy/knowledge-cloud/edgeone.json",
    "deploy/knowledge-cloud/render.yaml",
    ".github/workflows/knowledge-cloud-deploy.yml",
    "cloud-functions/[[default]].js",
    "cloud-functions/healthz.js",
    "cloud-functions/official-packs.js",
    "cloud-functions/package.json",
    "knowledge-cloud publish catalog",
  ],
}, null, 2));

async function read(path) {
  return readFile(path, "utf-8");
}

function assertIncludes(text, needle, message) {
  if (!text.includes(needle)) throw new Error(message);
}
