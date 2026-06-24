const KNOWLEDGE_KV_BINDING = "osstack_knowledge_kv";

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

export default async function onRequest({ env = {} } = {}) {
  const kv = knowledgeKv(env);
  return new Response(JSON.stringify({
    ok: true,
    service: "osstack-knowledge-cloud",
    runtime: "edgeone-cloud-functions",
    publish_storage: kv === undefined ? "edgeone-function-memory" : "edgeone-kv",
    kv_binding: kv === undefined ? "missing" : KNOWLEDGE_KV_BINDING,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
