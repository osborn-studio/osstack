import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { deliveryCanonical } from "@osstack/core";
import type { FollowUpDeliveryEnvelope } from "@osstack/protocol";
import { createGithubDeliveryTransport, githubDeliveryBody } from "./follow-up-github-transport.js";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function envelope(): FollowUpDeliveryEnvelope {
  const target = {
    destination_ref: "issue",
    repo_path: "/repo",
    provider_id: "github_comment" as const,
    account_id: "account",
    host: "github.com" as const,
    owner: "owner",
    repository: "repo",
    issue_number: 1,
    target_node_id: "ISSUE",
    actor_node_id: "ACTOR",
  };
  const payload = {
    repo_path: "/repo",
    default_tenant: true as const,
    attempt_id: randomUUID(),
    obligation_id: randomUUID(),
    obligation_revision: 1,
    destination: target,
    destination_digest: hash(deliveryCanonical(target)),
    body: "Exact message",
    body_sha256: hash("Exact message"),
  };
  return { ...payload, envelope_digest: hash(deliveryCanonical(payload)) };
}
async function fixture(handler?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const e = envelope();
  let posts = 0,
    reads = 0;
  const comments: unknown[] = [];
  const server = createServer((req, res): void => {
    res.setHeader("x-github-request-id", "REQUEST");
    if (req.method === "POST") posts++;
    if (handler?.(req, res)) return;
    res.setHeader("content-type", "application/json");
    if (req.url === "/user") {
      res.end(JSON.stringify({ node_id: "ACTOR" }));
      return;
    }
    if (req.url === "/repos/owner/repo/issues/1") {
      res.end(
        JSON.stringify({
          node_id: "ISSUE",
          number: 1,
          url: "https://api.github.com/repos/owner/repo/issues/1",
        }),
      );
      return;
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()).body;
        const comment = {
          id: posts,
          body,
          user: { node_id: "ACTOR" },
          issue_url: "https://api.github.com/repos/owner/repo/issues/1",
        };
        comments.push(comment);
        res.statusCode = 201;
        res.end(JSON.stringify(comment));
      });
      return;
    }
    reads++;
    res.end(JSON.stringify(comments));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  const transport = createGithubDeliveryTransport({
    qualification: "test_only",
    fixtureBaseUrl: `http://127.0.0.1:${address.port}`,
    credential: async () => "fixture-token",
  });
  return { e, transport, comments, posts: () => posts, reads: () => reads };
}
it("sends one exact correlated comment then verifies it by author, target and exact wire body", async () => {
  const f = await fixture();
  const receipt = await f.transport.sendOnce(f.e, AbortSignal.timeout(3000));
  expect(f.posts()).toBe(1);
  expect(f.comments).toEqual([expect.objectContaining({ body: githubDeliveryBody(f.e) })]);
  expect(await f.transport.lookup(f.e, AbortSignal.timeout(3000))).toEqual(receipt);
});
it.each([
  "author",
  "target",
  "body",
  "id",
])("rejects corrupt %s receipts without resending", async (field) => {
  const f = await fixture((req, res) => {
    if (req.method !== "POST") return false;
    const value = {
      id: 1,
      body: githubDeliveryBody(f.e),
      user: { node_id: "ACTOR" },
      issue_url: "https://api.github.com/repos/owner/repo/issues/1",
    };
    if (field === "author") value.user.node_id = "OTHER";
    if (field === "target") value.issue_url += "2";
    if (field === "body") value.body += "!";
    if (field === "id") value.id = 0;
    res.statusCode = 201;
    res.end(JSON.stringify(value));
    return true;
  });
  await expect(f.transport.sendOnce(f.e, AbortSignal.timeout(3000))).rejects.toThrow();
  expect(f.posts()).toBe(1);
});
it.each(["actor", "target"])("preflight %s mismatch forbids POST", async (field) => {
  const f = await fixture((req, res) => {
    if (req.url !== (field === "actor" ? "/user" : "/repos/owner/repo/issues/1")) return false;
    res.end(JSON.stringify({ node_id: "OTHER" }));
    return true;
  });
  await expect(f.transport.sendOnce(f.e, AbortSignal.timeout(3000))).rejects.toThrow();
  expect(f.posts()).toBe(0);
});
it.each([
  "redirect",
  "server_error",
  "truncated",
  "oversized",
  "timeout",
])("%s response remains unconfirmed and never retries POST", async (mode) => {
  const f = await fixture((req, res) => {
    if (req.method !== "POST") return false;
    if (mode === "redirect") {
      res.statusCode = 307;
      res.setHeader("location", "http://127.0.0.1:1/leak");
      res.end();
    }
    if (mode === "server_error") {
      res.statusCode = 503;
      res.end("fixture-token should not surface");
    }
    if (mode === "truncated") {
      res.statusCode = 201;
      res.end('{"id":');
    }
    if (mode === "oversized") {
      res.statusCode = 201;
      res.end("x".repeat(4_194_305));
    }
    return true;
  });
  await expect(
    f.transport.sendOnce(f.e, AbortSignal.timeout(mode === "timeout" ? 100 : 3000)),
  ).rejects.toThrow("github_delivery_unconfirmed");
  expect(f.posts()).toBe(1);
});
it("duplicate correlation or a changed body cannot become delivered by lookup", async () => {
  const f = await fixture();
  await f.transport.sendOnce(f.e, AbortSignal.timeout(3000));
  f.comments.push(f.comments[0]);
  await expect(f.transport.lookup(f.e, AbortSignal.timeout(3000))).rejects.toThrow("duplicate");
  f.comments.pop();
  (f.comments[0] as { body: string }).body += "edited";
  await expect(f.transport.lookup(f.e, AbortSignal.timeout(3000))).rejects.toThrow("mismatch");
  expect(f.posts()).toBe(1);
});
it("bounded enumeration fails closed if pages remain; ignores untrusted next URL", async () => {
  let pages = 0;
  const f = await fixture((req, res) => {
    if (!req.url?.includes("per_page")) return false;
    pages++;
    res.setHeader("link", '<http://attacker.invalid>; rel="next"');
    res.end("[]");
    return true;
  });
  await expect(f.transport.lookup(f.e, AbortSignal.timeout(3000))).rejects.toThrow("incomplete");
  expect(pages).toBe(20);
  expect(f.posts()).toBe(0);
});
it("never exposes a network fixture under production qualification", () => {
  expect(() =>
    createGithubDeliveryTransport({
      qualification: "production_qualified",
      fixtureBaseUrl: "http://127.0.0.1:1234",
      credential: async () => "token",
    }),
  ).toThrow();
});
it("real HTTP lost POST response stays unknown across service reconstruction; lookup resolves without a second POST", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto"),
    fs = await import("node:fs"),
    { join } = await import("node:path");
  const { createScratchDirSync, openDb, FollowUpObligationService, FollowUpDeliveryService } = await import(
    "@osstack/core"
  );
  const f = await fixture((req, res) => {
    if (req.method !== "POST") return false;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      f.comments.push({
        id: 1,
        body: JSON.parse(Buffer.concat(chunks).toString()).body,
        user: { node_id: "ACTOR" },
        issue_url: "https://api.github.com/repos/owner/repo/issues/1",
      });
      res.destroy();
    });
    return true;
  });
  const root = fs.realpathSync(createScratchDirSync("tests", "delivery-wire-ledger")),
    repo = join(root, "repo");
  fs.mkdirSync(repo);
  const path = join(root, "state.db"),
    db = openDb({ path });
  try {
    db.exec(
      "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','test','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)",
    );
    db.prepare(
      "INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','codex-cli',?,?,'idle',1,1,1)",
    ).run("a".repeat(64), repo);
    const scope = { repo_path: repo, default_tenant: true };
    const ob = new FollowUpObligationService(db, path).create({
      ...scope,
      source_session_id: "s",
      expected_source_version: 1,
      idempotency_key: "ob",
      actor: "operator",
      promise: "Reply",
      destination_ref: "local_operator",
      resolution_condition: "manual",
    }).obligation;
    const keys = generateKeyPairSync("ed25519"),
      target = { ...f.e.destination, repo_path: repo };
    const options = {
      targets: new Map([[target.destination_ref, target]]),
      trustedKeys: new Map([
        [
          "key",
          {
            publicKey: keys.publicKey,
            purpose: "follow_up_delivery" as const,
            repo_path: repo,
            provider_id: "github_comment" as const,
            destination_refs: [target.destination_ref],
            max_validity_ms: 60000,
          },
        ],
      ]),
      transports: new Map([["github_comment", f.transport]]),
      allowTestTransports: true,
    };
    let service = new FollowUpDeliveryService(db, path, options);
    const prepared = service.prepare({
      ...scope,
      obligation_id: ob.obligation_id,
      expected_obligation_revision: 1,
      destination_ref: target.destination_ref,
      body: "One public reply",
      idempotency_key: "once",
    }).attempt;
    const now = Date.now(),
      body = {
        ...prepared.authorization_subject,
        grant_id: randomUUID(),
        issued_at_ms: now,
        expires_at_ms: now + 60000,
        max_calls: 1,
      };
    const authorized = service.authorize({
      ...scope,
      attempt_id: prepared.attempt_id,
      expected_revision: prepared.revision,
      grant: {
        body,
        key_id: "key",
        signature: sign(null, Buffer.from(deliveryCanonical(body)), keys.privateKey).toString("base64"),
      },
    }).attempt;
    const failed = await service.dispatch({
      ...scope,
      attempt_id: prepared.attempt_id,
      expected_revision: authorized.revision,
    });
    expect(failed.attempt.state).toBe("delivery_unknown");
    expect(f.posts()).toBe(1);
    service = new FollowUpDeliveryService(db, path, options);
    const repeated = await service.dispatch({
      ...scope,
      attempt_id: prepared.attempt_id,
      expected_revision: failed.attempt.revision,
    });
    expect(repeated.attempt.state).toBe("delivery_unknown");
    expect(f.posts()).toBe(1);
    const recovered = await service.reconcile({
      ...scope,
      attempt_id: prepared.attempt_id,
      expected_revision: failed.attempt.revision,
    });
    expect(recovered.attempt.state).toBe("delivered");
    expect(recovered.attempt.qualification).toBe("test_only");
    expect(f.posts()).toBe(1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it("credential rotation between identity preflight and POST prevents admission", async () => {
  const f = await fixture();
  let calls = 0;
  // Reuse a fixture server address without letting any production config select a base URL.
  const address = servers[servers.length - 1]!.address();
  if (!address || typeof address === "string") throw Error();
  const transport = createGithubDeliveryTransport({
    qualification: "test_only",
    fixtureBaseUrl: `http://127.0.0.1:${address.port}`,
    credential: async () => (++calls === 1 ? "first-token" : "rotated-token"),
  });
  await expect(transport.sendOnce(f.e, AbortSignal.timeout(3000))).rejects.toThrow("registration_changed");
  expect(f.posts()).toBe(0);
});
it("a foreign author copying the public marker cannot veto the real receipt", async () => {
  const f = await fixture();
  const sent = await f.transport.sendOnce(f.e, AbortSignal.timeout(3000));
  f.comments.unshift({
    id: 999,
    body: githubDeliveryBody(f.e),
    user: { node_id: "FOREIGN" },
    issue_url: "https://api.github.com/repos/owner/repo/issues/1",
  });
  expect(await f.transport.lookup(f.e, AbortSignal.timeout(3000))).toEqual(sent);
});
it("uses durable creation context so 600 historical comments cannot hide the new receipt", async () => {
  const createdAtMs = Date.now();
  let observedSince: string | null = null;
  const f = await fixture((req, res) => {
    if (!req.url?.includes("per_page")) return false;
    const url = new URL(req.url, "http://fixture.invalid");
    observedSince = url.searchParams.get("since");
    const historical = Array.from({ length: 600 }, (_, id) => ({
      id: id + 1,
      body: "old",
      user: { node_id: "ACTOR" },
      issue_url: "https://api.github.com/repos/owner/repo/issues/1",
    }));
    const filtered = observedSince ? f.comments : historical;
    const page = Number(url.searchParams.get("page"));
    const items = filtered.slice((page - 1) * 10, page * 10);
    if (page * 10 < filtered.length) res.setHeader("link", '<https://api.github.com>; rel="next"');
    res.end(JSON.stringify(items));
    return true;
  });
  const sent = await f.transport.sendOnce(f.e, AbortSignal.timeout(3000));
  expect(await f.transport.lookup(f.e, AbortSignal.timeout(3000), { createdAtMs })).toEqual(sent);
  expect(observedSince).toBe(new Date(createdAtMs - 300000).toISOString());
  expect(f.posts()).toBe(1);
});
it("allows a page of ten large legitimate neighboring comments within a finite response cap", async () => {
  const f = await fixture();
  const sent = await f.transport.sendOnce(f.e, AbortSignal.timeout(3000));
  for (let i = 0; i < 8; i++)
    f.comments.unshift({
      id: 100 + i,
      body: "🙂".repeat(65536),
      user: { node_id: "ACTOR" },
      issue_url: "https://api.github.com/repos/owner/repo/issues/1",
    });
  expect(await f.transport.lookup(f.e, AbortSignal.timeout(3000))).toEqual(sent);
});
