#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const dockerfile = await read("Dockerfile.knowledge-cloud");
const edgeone = await read("deploy/knowledge-cloud/edgeone.json");
const render = await read("deploy/knowledge-cloud/render.yaml");
const workflow = await read(".github/workflows/knowledge-cloud-deploy.yml");

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
assertIncludes(edgeone, '"deploy_secret": "EDGEONE_DEPLOY_HOOK_URL"', "EdgeOne deploy config must declare the deploy hook secret");

assertIncludes(render, "dockerfilePath: ./Dockerfile.knowledge-cloud", "Render deploy config must use the Knowledge Cloud Dockerfile");
assertIncludes(render, "healthCheckPath: /healthz", "Render deploy config must healthcheck /healthz");
assertIncludes(render, "value: 8787", "Render deploy config must set the Knowledge Cloud port");
assertIncludes(render, "OSSTACK_KNOWLEDGE_AUDIT_LOG", "Render deploy config must persist Knowledge Cloud audit JSONL");
assertIncludes(render, "OSSTACK_KNOWLEDGE_FEEDBACK_LOG", "Render deploy config must persist Knowledge Cloud feedback JSONL");
assertIncludes(render, "OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR", "Render deploy config must persist published Knowledge Cloud packs");

assertIncludes(workflow, "workflow_dispatch:", "Knowledge Cloud deploy workflow must be manually triggerable");
assertIncludes(workflow, "pnpm smoke:knowledge-cloud", "Knowledge Cloud deploy workflow must run service smoke");
assertIncludes(workflow, "pnpm smoke:knowledge-cloud:deploy", "Knowledge Cloud deploy workflow must run deploy asset smoke");
assertIncludes(workflow, "docker build -f Dockerfile.knowledge-cloud", "Knowledge Cloud deploy workflow must build the Docker image");
assertIncludes(workflow, "secrets.EDGEONE_DEPLOY_HOOK_URL", "Knowledge Cloud deploy workflow must gate EdgeOne deploy on EDGEONE_DEPLOY_HOOK_URL");
assertIncludes(workflow, "deploy=true requires repository secret EDGEONE_DEPLOY_HOOK_URL", "Knowledge Cloud deploy=true must fail when EDGEONE_DEPLOY_HOOK_URL is missing");
assertIncludes(workflow, 'curl -fsS -X POST "$EDGEONE_DEPLOY_HOOK_URL"', "Knowledge Cloud deploy workflow must trigger the EdgeOne deploy hook");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "Dockerfile.knowledge-cloud",
    "deploy/knowledge-cloud/edgeone.json",
    "deploy/knowledge-cloud/render.yaml",
    ".github/workflows/knowledge-cloud-deploy.yml",
  ],
}, null, 2));

async function read(path) {
  return readFile(path, "utf-8");
}

function assertIncludes(text, needle, message) {
  if (!text.includes(needle)) throw new Error(message);
}
