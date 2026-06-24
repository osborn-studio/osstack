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
assertIncludes(edgeone, '"default_domain": "osstack-knowledge-cloud-1grycf4k.edgeone.cool"', "EdgeOne deploy config must use the reachable EdgeOne preset domain as the default domain");
assertIncludes(edgeone, '"custom_domain": "knowledge.osstack.ai"', "EdgeOne deploy config must record the intended branded custom domain");
assertIncludes(edgeone, '"healthcheck_path": "/healthz"', "EdgeOne deploy config must healthcheck /healthz");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_CLOUD_HOST": "0.0.0.0"', "EdgeOne deploy config must bind externally");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_AUDIT_LOG": "/data/audit/knowledge-cloud-audit.jsonl"', "EdgeOne deploy config must persist Knowledge Cloud audit JSONL");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_FEEDBACK_LOG": "/data/feedback/feedback.jsonl"', "EdgeOne deploy config must persist Knowledge Cloud feedback JSONL");
assertIncludes(edgeone, '"OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR": "/data/published-packs"', "EdgeOne deploy config must persist published Knowledge Cloud packs");
assertIncludes(edgeone, '"kv_bindings"', "EdgeOne deploy config must declare Knowledge Cloud KV bindings");
assertIncludes(edgeone, '"osstack_knowledge_kv"', "EdgeOne deploy config must declare the Osstack Knowledge KV binding name");
assertIncludes(edgeone, '"knowledge-packs/official/**"', "EdgeOne deploy config must include official knowledge packs");
assertIncludes(edgeone, '"deploy_secret": "EDGEONE_API_TOKEN"', "EdgeOne deploy config must declare the EdgeOne API token secret");
assertIncludes(edgeone, '"fallback_deploy_secret": "EDGEONE_DEPLOY_HOOK_URL"', "EdgeOne deploy config must retain the deploy hook fallback secret");
assertIncludes(edgeone, '"project_name": "osstack-knowledge-cloud"', "EdgeOne deploy config must declare the Makers project name");
assertIncludes(edgeOneFunction, "export default async function onRequest", "EdgeOne Cloud Function must export an onRequest handler");
assertIncludes(edgeOneFunction, 'from "./official-packs.js"', "EdgeOne Cloud Function must load official packs from the function bundle");
assertIncludes(edgeOneFunction, 'url.pathname === "/healthz"', "EdgeOne Cloud Function must serve /healthz");
assertIncludes(edgeOneFunction, 'url.pathname === "/v1/search"', "EdgeOne Cloud Function must serve /v1/search");
assertIncludes(edgeOneFunction, 'url.pathname === "/v1/publish"', "EdgeOne Cloud Function must serve /v1/publish");
assertIncludes(edgeOneFunction, 'url.pathname === "/v1/private-packs"', "EdgeOne Cloud Function must serve tenant private packs");
assertIncludes(edgeOneFunction, 'url.pathname === "/review"', "EdgeOne Cloud Function must serve the review queue UI");
assertIncludes(edgeOneFunction, "OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", "EdgeOne Cloud Function publish must require an explicit token");
assertIncludes(edgeOneFunction, "osstack_knowledge_kv", "EdgeOne Cloud Function must support the Osstack Knowledge KV binding");
assertIncludes(edgeOneFunction, "edgeone-kv", "EdgeOne Cloud Function must report durable EdgeOne KV publish persistence");
assertIncludes(edgeOneFunction, "function knowledgeKv", "EdgeOne Cloud Function must discover a bound KV namespace");
assertIncludes(edgeOneFunction, "function searchPacks", "EdgeOne Cloud Function must include self-contained search");
assertIncludes(edgeOneHealthFunction, "osstack-knowledge-cloud", "EdgeOne /healthz function must return Knowledge Cloud service metadata");
assertIncludes(edgeOneFunctionPackage, '"type": "module"', "EdgeOne Cloud Function package must opt into ESM");
assertIncludes(edgeOneOfficialPacks, "proof-checksum-pack", "EdgeOne function bundle must include official proof knowledge pack data");
assertIncludes(edgeOneHealthFunction, "publish_storage", "EdgeOne /healthz function must expose publish storage mode");
assertIncludes(edgeOneHealthFunction, "osstack_knowledge_kv", "EdgeOne /healthz function must expose the Knowledge KV binding name");
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
assertIncludes(workflow, "EDGEONE_DEPLOY_URL=https?://", "Knowledge Cloud deploy workflow must parse the EdgeOne deploy URL from CLI output");
assertIncludes(workflow, "deploy_url=$deploy_url", "Knowledge Cloud deploy workflow must expose the EdgeOne deploy URL as a step output");
assertIncludes(workflow, "VALIDATION_CLOUD_URL", "Knowledge Cloud deploy workflow must validate against the resolved deployed URL");
assertIncludes(workflow, "EdgeOne CLI deploy exceeded the 8 minute command timeout", "Knowledge Cloud deploy workflow must explain EdgeOne CLI timeout failures");
assertIncludes(workflow, "Deploy Success", "Knowledge Cloud deploy workflow must tolerate EdgeOne post-success status lookup failures");
assertIncludes(workflow, "EDGEONE_DEPLOY_HOOK_URL", "Knowledge Cloud deploy workflow must retain the deploy hook fallback");
assertIncludes(workflow, "OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", "Knowledge Cloud deploy workflow must configure the EdgeOne publish token when available");
assertIncludes(workflow, "makers link -n osstack-knowledge-cloud", "Knowledge Cloud deploy workflow must link the EdgeOne project before setting env vars");
assertIncludes(workflow, "makers env set OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", "Knowledge Cloud deploy workflow must set the EdgeOne publish token env var");
assertIncludes(workflow, "hook_available=true", "Knowledge Cloud deploy workflow must detect when the deploy hook fallback is available");
assertIncludes(workflow, "cli_failed=true", "Knowledge Cloud deploy workflow must mark failed EdgeOne CLI deploys for hook fallback");
assertIncludes(workflow, "triggering EDGEONE_DEPLOY_HOOK_URL fallback", "Knowledge Cloud deploy workflow must explain CLI-to-hook fallback");
assertIncludes(workflow, "deploy=true requires repository secret EDGEONE_API_TOKEN or EDGEONE_DEPLOY_HOOK_URL", "Knowledge Cloud deploy=true must fail when no EdgeOne deploy credential is configured");
assertIncludes(workflow, 'curl -fsS -X POST "$EDGEONE_DEPLOY_HOOK_URL"', "Knowledge Cloud deploy workflow must trigger the EdgeOne deploy hook fallback");
assertIncludes(workflow, "inputs.cloud_url != '' || steps.edgeone-cli-deploy.outputs.deploy_url != ''", "Knowledge Cloud deploy workflow must validate either an input cloud_url or the EdgeOne CLI deploy URL");
assertIncludes(workflow, "release doctor --target knowledge-cloud --cloud-url", "Knowledge Cloud deploy workflow must validate the deployed health/search/audit gates when cloud_url is supplied");
assertIncludes(workflow, 'knowledge sync --cloud-url "$VALIDATION_CLOUD_URL" --json', "Knowledge Cloud deploy workflow must sync from the resolved deployed cloud URL");
assertIncludes(workflow, 'knowledge search "proof pack checksum" --cloud-url "$VALIDATION_CLOUD_URL" --json', "Knowledge Cloud deploy workflow must search the resolved deployed cloud URL");
assertIncludes(workflow, "validation-only run completed against", "Knowledge Cloud deploy workflow must summarize validation-only runs that check a cloud URL");
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
const review = await edgeOneHandler.default({ request: new Request("https://knowledge.osstack.ai/review?status=approved") });
if (review.status !== 200) throw new Error("EdgeOne Cloud Function /review smoke must return HTTP 200");
const reviewHtml = await review.text();
if (!reviewHtml.includes("Osstack Knowledge Cloud Review Queue") || !reviewHtml.includes("Filter: approved")) {
  throw new Error("EdgeOne Cloud Function /review smoke returned invalid review queue HTML");
}
process.env.OSSTACK_KNOWLEDGE_PUBLISH_TOKEN = "kst_edgeone_publish_smoke";
const publish = await edgeOneHandler.default({
  request: new Request("https://knowledge.osstack.ai/v1/publish", {
    method: "POST",
    headers: {
      authorization: "Bearer kst_edgeone_publish_smoke",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      pack: {
        id: "team/edgeone-smoke",
        version: "2026.06.24",
        name: "Team EdgeOne Smoke",
        license: "Internal",
        source_kind: "internal",
        quality_score: 82,
        scope: "team",
        tenant_id: "team_alpha",
        taxonomy: ["operations/edgeone-smoke"],
        chunks: [{
          chunk_id: "team-edgeone-smoke-1",
          title: "Team EdgeOne smoke",
          body: "Osstack team knowledge published through EdgeOne should stay tenant scoped.",
          tags: ["team", "edgeone"],
        }],
      },
    }),
  }),
});
if (publish.status !== 200) throw new Error("EdgeOne Cloud Function /v1/publish smoke must return HTTP 200");
const publishBody = await publish.json();
if (publishBody.ok !== true || publishBody.private !== true || publishBody.tenant_id !== "team_alpha") {
  throw new Error("EdgeOne Cloud Function /v1/publish smoke returned invalid publish metadata");
}
const privateSearch = await edgeOneHandler.default({
  request: new Request("https://knowledge.osstack.ai/v1/search", {
    method: "POST",
    headers: {
      authorization: "Bearer kst_edgeone_publish_smoke",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "tenant scoped edgeone", tenant_id: "team_alpha", limit: 5 }),
  }),
});
if (privateSearch.status !== 200) throw new Error("EdgeOne Cloud Function private search smoke must return HTTP 200");
const privateSearchBody = await privateSearch.json();
if (!privateSearchBody.results?.some((result) => result.pack_id === "team/edgeone-smoke")) {
  throw new Error("EdgeOne Cloud Function private search smoke must include the published tenant pack");
}
const fakeKv = createFakeKv();
const kvEnv = {
  osstack_knowledge_kv: fakeKv,
  OSSTACK_KNOWLEDGE_PUBLISH_TOKEN: "kst_edgeone_kv_publish_smoke",
};
const kvPublish = await edgeOneHandler.default({
  request: new Request("https://knowledge.osstack.ai/v1/publish", {
    method: "POST",
    headers: {
      authorization: "Bearer kst_edgeone_kv_publish_smoke",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      pack: {
        id: "team/edgeone-kv-smoke",
        version: "2026.06.24",
        name: "Team EdgeOne KV Smoke",
        license: "Internal",
        source_kind: "internal",
        quality_score: 84,
        scope: "team",
        tenant_id: "team_kv_alpha",
        taxonomy: ["operations/edgeone-kv-smoke"],
        chunks: [{
          chunk_id: "team-edgeone-kv-smoke-1",
          title: "Team EdgeOne KV smoke",
          body: "Durable Osstack Knowledge Cloud packs should remain searchable across EdgeOne function instances.",
          tags: ["team", "edgeone", "kv"],
        }],
      },
    }),
  }),
  env: kvEnv,
});
if (kvPublish.status !== 200) throw new Error("EdgeOne Cloud Function KV /v1/publish smoke must return HTTP 200");
const kvPublishBody = await kvPublish.json();
if (kvPublishBody.persistence !== "edgeone-kv") {
  throw new Error(`EdgeOne Cloud Function KV publish must use edgeone-kv persistence: ${JSON.stringify(kvPublishBody)}`);
}
const freshEdgeOneHandler = await import(new URL(`../cloud-functions/%5B%5Bdefault%5D%5D.js?kv-smoke=${Date.now()}`, import.meta.url));
const kvSearch = await freshEdgeOneHandler.default({
  request: new Request("https://knowledge.osstack.ai/v1/search", {
    method: "POST",
    headers: {
      authorization: "Bearer kst_edgeone_kv_publish_smoke",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "durable function instances", tenant_id: "team_kv_alpha", limit: 5 }),
  }),
  env: kvEnv,
});
if (kvSearch.status !== 200) throw new Error("EdgeOne Cloud Function KV private search smoke must return HTTP 200");
const kvSearchBody = await kvSearch.json();
if (!kvSearchBody.results?.some((result) => result.pack_id === "team/edgeone-kv-smoke")) {
  throw new Error("EdgeOne Cloud Function KV private search smoke must include the published tenant pack across fresh module state");
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

function createFakeKv() {
  const values = new Map();
  return {
    async put(key, value) {
      values.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async get(key, options) {
      const value = values.get(key);
      if (value === undefined) return null;
      if (options === "json" || options?.type === "json") return JSON.parse(value);
      return value;
    },
    async list(options = {}) {
      const prefix = typeof options.prefix === "string" ? options.prefix : "";
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(options.limit)) : 256;
      const keys = Array.from(values.keys())
        .filter((key) => key.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, cursor: "" };
    },
  };
}
