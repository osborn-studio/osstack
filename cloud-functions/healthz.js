const KNOWLEDGE_KV_BINDING = "osstack_knowledge_kv";
const KNOWLEDGE_BLOB_BINDING = "osstack_knowledge_blob";
const KNOWLEDGE_BLOB_STORE = "osstack-knowledge-cloud-packs";

function knowledgeKv(env = {}) {
  const candidates = [
    env?.[KNOWLEDGE_KV_BINDING],
    env?.OSSTACK_KNOWLEDGE_KV,
    globalThis[KNOWLEDGE_KV_BINDING],
    globalThis.OSSTACK_KNOWLEDGE_KV,
  ];
  return candidates.find((candidate) => (
    typeof candidate === "object"
    && candidate !== null
    && typeof candidate.put === "function"
    && typeof candidate.get === "function"
    && typeof candidate.list === "function"
  ));
}

async function knowledgeBlobStore(env = {}) {
  const candidates = [
    env?.[KNOWLEDGE_BLOB_BINDING],
    env?.OSSTACK_KNOWLEDGE_BLOB,
    globalThis[KNOWLEDGE_BLOB_BINDING],
    globalThis.OSSTACK_KNOWLEDGE_BLOB,
  ];
  const injected = candidates.find((candidate) => (
    typeof candidate === "object"
    && candidate !== null
    && typeof candidate.get === "function"
    && typeof candidate.list === "function"
    && (typeof candidate.set === "function" || typeof candidate.setJSON === "function")
  ));
  if (injected !== undefined) return injected;
  try {
    const blob = await import("@edgeone/pages-blob");
    if (typeof blob.getStore !== "function") return undefined;
    return blob.getStore(KNOWLEDGE_BLOB_STORE, { consistency: "strong" });
  } catch {
    return undefined;
  }
}

export default async function onRequest({ env = {} } = {}) {
  const kv = knowledgeKv(env);
  const blob = kv === undefined ? await knowledgeBlobStore(env) : undefined;
  const publishStorage = kv !== undefined ? "edgeone-kv" : blob !== undefined ? "edgeone-blob" : "edgeone-function-memory";
  const storageBinding = kv !== undefined ? KNOWLEDGE_KV_BINDING : blob !== undefined ? KNOWLEDGE_BLOB_STORE : "missing";
  return new Response(JSON.stringify({
    ok: true,
    service: "osstack-knowledge-cloud",
    runtime: "edgeone-cloud-functions",
    publish_storage: publishStorage,
    storage_binding: storageBinding,
    kv_binding: kv === undefined ? "missing" : KNOWLEDGE_KV_BINDING,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
