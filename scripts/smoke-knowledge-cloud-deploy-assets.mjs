#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const dockerfile = await read("Dockerfile.knowledge-cloud");
const fly = await read("deploy/knowledge-cloud/fly.toml");
const render = await read("deploy/knowledge-cloud/render.yaml");
const workflow = await read(".github/workflows/knowledge-cloud-deploy.yml");

assertIncludes(dockerfile, "EXPOSE 8787", "Dockerfile must expose the Knowledge Cloud port");
assertIncludes(dockerfile, "/healthz", "Dockerfile must include the health endpoint");
assertIncludes(dockerfile, "packages/knowledge-cloud/dist/bin.js", "Dockerfile must start the Knowledge Cloud executable");

assertIncludes(fly, 'dockerfile = "Dockerfile.knowledge-cloud"', "Fly deploy config must use the Knowledge Cloud Dockerfile");
assertIncludes(fly, "internal_port = 8787", "Fly deploy config must route to port 8787");
assertIncludes(fly, 'path = "/healthz"', "Fly deploy config must healthcheck /healthz");
assertIncludes(fly, 'OSSTACK_KNOWLEDGE_CLOUD_HOST = "0.0.0.0"', "Fly deploy config must bind externally");

assertIncludes(render, "dockerfilePath: ./Dockerfile.knowledge-cloud", "Render deploy config must use the Knowledge Cloud Dockerfile");
assertIncludes(render, "healthCheckPath: /healthz", "Render deploy config must healthcheck /healthz");
assertIncludes(render, "value: 8787", "Render deploy config must set the Knowledge Cloud port");

assertIncludes(workflow, "workflow_dispatch:", "Knowledge Cloud deploy workflow must be manually triggerable");
assertIncludes(workflow, "pnpm smoke:knowledge-cloud", "Knowledge Cloud deploy workflow must run service smoke");
assertIncludes(workflow, "pnpm smoke:knowledge-cloud:deploy", "Knowledge Cloud deploy workflow must run deploy asset smoke");
assertIncludes(workflow, "docker build -f Dockerfile.knowledge-cloud", "Knowledge Cloud deploy workflow must build the Docker image");
assertIncludes(workflow, "secrets.FLY_API_TOKEN", "Knowledge Cloud deploy workflow must gate Fly deploy on FLY_API_TOKEN");
assertIncludes(workflow, "flyctl deploy --config deploy/knowledge-cloud/fly.toml", "Knowledge Cloud deploy workflow must deploy with the Fly config");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "Dockerfile.knowledge-cloud",
    "deploy/knowledge-cloud/fly.toml",
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
