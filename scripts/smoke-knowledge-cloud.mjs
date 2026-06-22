#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = join(tmpdir(), `osstack-knowledge-cloud-smoke-${process.pid}`);
await mkdir(tmp, { recursive: true });
const privatePackPath = join(tmp, "team-private-pack.json");
const feedbackLogPath = join(tmp, "feedback", "feedback.jsonl");
const publishedPackDir = join(tmp, "published-packs");
await mkdir(join(tmp, "feedback"), { recursive: true });
await writeFile(feedbackLogPath, `${JSON.stringify({
  chunk_id: "proof-checksum-pack",
  rating: "bad",
  status: "sent",
  created_at: "2026-06-21T00:00:00.000Z",
  tenant_id: "team_smoke",
  authorized: true,
})}\n`, "utf-8");
await writeFile(privatePackPath, JSON.stringify({
  id: "team/private-release",
  version: "2026.06.22-smoke",
  name: "Team Private Release",
  license: "Internal",
  source_kind: "internal",
  quality_score: 82,
  scope: "team",
  tenant_id: "team_smoke",
  taxonomy: ["agent-operations/private-release"],
  chunks: [{
    chunk_id: "private-release-approval",
    title: "Private release approval",
    body: "Private team releases require approval notes, proof pack paths, rollback owner, and tenant-scoped Knowledge Cloud search.",
    tags: ["private", "release", "approval"],
  }],
}, null, 2));

const child = spawn(
  process.execPath,
  [
    "packages/knowledge-cloud/dist/bin.js",
    "--port",
    "0",
    "--private-pack",
    privatePackPath,
    "--private-token",
    "kst_smoke_private",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OSSTACK_KNOWLEDGE_FEEDBACK_LOG: feedbackLogPath,
      OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR: publishedPackDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
let resolved = false;

try {
  const url = await waitForStartup();
  const health = await fetchJson(`${url}/healthz`);
  assert(health.ok === true, "/healthz must return ok=true");
  assert(health.service === "osstack-knowledge-cloud", "/healthz must identify the service");
  assert(health.private_packs === 1, "/healthz must count private packs");

  const packs = await fetchJson(`${url}/v1/packs`);
  assert(Array.isArray(packs.packs), "/v1/packs must return packs");
  assert(packs.packs.length >= 6, "/v1/packs must expose official packs");

  const sync = await fetchJson(`${url}/v1/sync`, { client: "osstack-smoke" });
  assert(Array.isArray(sync.packs), "/v1/sync must return pack manifests");
  assert(
    sync.packs.some((item) => item.id === "osstack-core/proof-and-scorecard"
      && Array.isArray(item.chunks)
      && item.chunks.some((chunk) => chunk.chunk_id === "proof-checksum-pack")),
    "/v1/sync must include official proof guidance manifest",
  );

  const unauthorizedPrivate = await fetch(`${url}/v1/private-packs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: "team_smoke" }),
  });
  assert(unauthorizedPrivate.status === 401, "/v1/private-packs must protect private packs when token is configured");

  const privatePacks = await fetchJson(
    `${url}/v1/private-packs`,
    { tenant_id: "team_smoke" },
    { authorization: "Bearer kst_smoke_private" },
  );
  assert(Array.isArray(privatePacks.packs), "/v1/private-packs must return packs");
  assert(
    privatePacks.packs.some((item) => item.id === "team/private-release" && item.scope === "team"),
    "/v1/private-packs must expose tenant-scoped team packs",
  );

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

  const publish = await fetchJson(`${url}/v1/publish`, {
    pack: {
      id: "osstack-core/smoke-published",
      version: "2026.06.22-smoke",
      name: "Smoke Published Pack",
      license: "Osstack-native",
      source_kind: "osstack_native",
      quality_score: 91,
      scope: "official",
      taxonomy: ["osstack-core/knowledge-cloud"],
      last_reviewed_at: "2026-06-22T00:00:00.000Z",
      review: {
        status: "approved",
        reviewer_id: "knowledge-reviewer",
        reviewed_at: "2026-06-22T00:00:00.000Z",
        summary: "Approved during Knowledge Cloud smoke.",
      },
      source_attribution: ["osstack-native smoke knowledge"],
      source_provenance: [{
        source_id: "smoke-published",
        path: "smoke-published.md",
        sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        license: "Osstack-native",
        scope: "official",
        imported_at: "2026-06-22T00:00:00.000Z",
      }],
      chunks: [{
        chunk_id: "smoke-published-review",
        title: "Smoke published review",
        body: "Osstack Knowledge Cloud smoke verifies approved publish persistence for restart-ready packs.",
        tags: ["smoke", "publish", "persistence"],
        source_refs: ["smoke-published"],
      }],
    },
  });
  assert(publish.ok === true, "/v1/publish must accept approved official packs");
  const publishedSearch = await fetchJson(`${url}/v1/search`, {
    query: "approved publish persistence restart-ready packs",
    limit: 1,
  });
  assert(
    publishedSearch.results.some((item) => item.pack_id === "osstack-core/smoke-published"
      && item.chunk_id === "smoke-published-review"),
    "/v1/search must find newly published official packs",
  );
  const publishedFiles = await readdir(join(publishedPackDir, "official"));
  assert(
    publishedFiles.includes("osstack-core%2Fsmoke-published.json"),
    "published pack storage must persist approved official manifests",
  );

  const privateSearch = await fetchJson(`${url}/v1/search`, {
    query: "private release approval rollback owner",
    limit: 3,
    tenant_id: "team_smoke",
  }, {
    authorization: "Bearer kst_smoke_private",
  });
  assert(
    privateSearch.results.some((item) => item.pack_id === "team/private-release"
      && item.chunk_id === "private-release-approval"),
    "/v1/search must include tenant/private packs loaded at startup",
  );

  const feedback = await fetchJson(`${url}/v1/feedback`, {
    chunk_id: "proof-checksum-pack",
    rating: "useful",
    tenant_id: "team_smoke",
  }, {
    authorization: "Bearer kst_smoke_private",
  });
  assert(feedback.ok === true, "/v1/feedback must accept useful/bad ratings");
  assert(feedback.feedback?.status === "sent", "/v1/feedback must return sent status");
  assert(feedback.feedback?.tenant_id === "team_smoke", "/v1/feedback must record tenant scope");

  const feedbackSummary = await fetchJson(`${url}/v1/feedback/summary`, {
    tenant_id: "team_smoke",
  });
  assert(feedbackSummary.total === 2, "/v1/feedback/summary must count preloaded and live tenant feedback");
  assert(feedbackSummary.useful === 1, "/v1/feedback/summary must count useful tenant feedback");
  assert(feedbackSummary.bad === 1, "/v1/feedback/summary must count bad tenant feedback");
  const feedbackLog = await readFile(feedbackLogPath, "utf-8");
  assert(feedbackLog.includes("\"chunk_id\":\"proof-checksum-pack\""), "feedback JSONL must record chunk ids");
  assert(feedbackLog.includes("\"tenant_id\":\"team_smoke\""), "feedback JSONL must record tenant scope");

  console.log(JSON.stringify({
    ok: true,
    url,
    health: health.service,
    packs: packs.packs.length,
    private_packs: health.private_packs,
    sync_packs: sync.packs.length,
    top_result: search.results[0]?.chunk_id ?? null,
    private_result: privateSearch.results[0]?.chunk_id ?? null,
    feedback: feedback.feedback?.status ?? null,
    feedback_summary_total: feedbackSummary.total,
    feedback_log: feedbackLogPath,
    published_pack_dir: publishedPackDir,
  }, null, 2));
} finally {
  child.kill("SIGTERM");
  await rm(tmp, { recursive: true, force: true });
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

async function fetchJson(url, body, headers = {}) {
  const response = await fetch(url, body === undefined
    ? undefined
    : {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
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
