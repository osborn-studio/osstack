export default async function onRequest() {
  return new Response(JSON.stringify({
    ok: true,
    service: "osstack-knowledge-cloud",
    runtime: "edgeone-cloud-functions",
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
