#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["packages/knowledge-cloud/dist/bin.js", "--port", "0"],
  {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
let resolved = false;

try {
  const url = await waitForStartup();
  const packs = await fetchJson(`${url}/v1/packs`);
  assert(Array.isArray(packs.packs), "/v1/packs must return packs");
  assert(packs.packs.length >= 6, "/v1/packs must expose official packs");

  const search = await fetchJson(`${url}/v1/search`, {
    query: "proof pack checksum manifest",
    limit: 2,
  });
  assert(Array.isArray(search.results), "/v1/search must return results");
  assert(
    search.results.some((item) => item.pack_id === "osstack-core/proof-and-scorecard"
      && item.chunk_id === "proof-checksum-pack"),
    "/v1/search must find official proof guidance",
  );

  console.log(JSON.stringify({
    ok: true,
    url,
    packs: packs.packs.length,
    top_result: search.results[0]?.chunk_id ?? null,
  }, null, 2));
} finally {
  child.kill("SIGTERM");
}

function waitForStartup() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`knowledge cloud did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/^knowledge_cloud=(.+)$/m);
      if (match !== null && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`knowledge cloud exited before startup with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

async function fetchJson(url, body) {
  const response = await fetch(url, body === undefined
    ? undefined
    : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
