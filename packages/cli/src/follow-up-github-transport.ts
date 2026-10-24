import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { FollowUpDeliveryEnvelope, FollowUpDeliveryReceipt } from "@osstack/protocol";
import type { FollowUpTransport } from "@osstack/core";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** Included in the human preview. Correlation is not itself proof: author, target and exact body must match. */
export function githubDeliveryBody(envelope: FollowUpDeliveryEnvelope): string {
  return `${envelope.body}\n\n<!-- osstack-delivery:${envelope.attempt_id}:${envelope.envelope_digest} -->`;
}
export interface GithubDeliveryTransportOptions {
  qualification: FollowUpTransport["qualification"];
  /** Host-owned resolver rechecks current registration and reads a private credential for each operation. */
  credential(envelope: FollowUpDeliveryEnvelope): Promise<string>;
  /** Host synchronous private credential fence; no I/O awaits after grant consumption. */
  assertCredential?(envelope: FollowUpDeliveryEnvelope, token: string): void;
  /** Only local HTTP fixtures are accepted, and only under test_only qualification. */
  fixtureBaseUrl?: string;
}
interface JsonResponse {
  value: unknown;
  requestId: string;
  hasNext: boolean;
}
/** No redirects, retry middleware, shell, proxy environment, or provider error bodies are used. */
export function createGithubDeliveryTransport(options: GithubDeliveryTransportOptions): FollowUpTransport {
  const base = options.fixtureBaseUrl ? new URL(options.fixtureBaseUrl) : new URL("https://api.github.com");
  if (
    options.fixtureBaseUrl &&
    (options.qualification !== "test_only" ||
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash)
  )
    throw Error("invalid_delivery_fixture");
  const api = async (
    path: string,
    token: string,
    signal: AbortSignal,
    body?: string,
  ): Promise<JsonResponse> => {
    if (signal.aborted || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw Error("github_delivery_unavailable");
    const url = new URL(path, base);
    return new Promise((resolve, reject) => {
      const fail = () => reject(Error("github_delivery_unconfirmed"));
      const request = (base.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: body === undefined ? "GET" : "POST",
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2026-03-10",
            "user-agent": "osstack-follow-up-delivery",
            ...(body === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(body),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4_194_304) {
              response.destroy();
              request.destroy();
              fail();
            } else chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => {
            try {
              if (response.statusCode !== (body === undefined || path === "/graphql" ? 200 : 201))
                throw Error();
              const requestId = response.headers["x-github-request-id"];
              if (typeof requestId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(requestId)) throw Error();
              resolve({
                value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
                requestId,
                hasNext: /rel="next"/.test(String(response.headers.link ?? "")),
              });
            } catch {
              fail();
            }
          });
        },
      );
      request.on("error", fail);
      request.setTimeout(5000, () => request.destroy(Error("github_delivery_timeout")));
      request.end(body);
    });
  };
  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("github_delivery_invalid_response");
    return value as Record<string, unknown>;
  }
  const targetPath = (e: FollowUpDeliveryEnvelope) =>
    `/repos/${encodeURIComponent(e.destination.owner)}/${encodeURIComponent(e.destination.repository)}/issues/${e.destination.issue_number}`;
  const targetUrl = (e: FollowUpDeliveryEnvelope) => `https://api.github.com${targetPath(e)}`;
  async function preflight(
    e: FollowUpDeliveryEnvelope,
    signal: AbortSignal,
    forSend = true,
  ): Promise<string> {
    if (
      e.destination.host !== "github.com" ||
      e.destination.provider_id !== "github_comment" ||
      sha(e.body) !== e.body_sha256
    )
      throw Error("github_delivery_invalid_envelope");
    const token = await options.credential(e);
    const actor = record((await api("/user", token, signal)).value);
    if (actor.node_id !== e.destination.actor_node_id) throw Error("github_delivery_actor_mismatch");
    const issue = record((await api(targetPath(e), token, signal)).value);
    if (
      issue.node_id !== e.destination.target_node_id ||
      issue.url !== targetUrl(e) ||
      issue.number !== e.destination.issue_number ||
      (forSend && issue.locked === true)
    )
      throw Error("github_delivery_target_mismatch");
    return token;
  }
  function receipt(e: FollowUpDeliveryEnvelope, value: unknown, requestId: string): FollowUpDeliveryReceipt {
    const comment = record(value),
      user = record(comment.user);
    if (
      !Number.isSafeInteger(comment.id) ||
      Number(comment.id) < 1 ||
      comment.issue_url !== targetUrl(e) ||
      user.node_id !== e.destination.actor_node_id ||
      comment.body !== githubDeliveryBody(e)
    )
      throw Error("github_delivery_receipt_mismatch");
    return {
      provider_id: "github_comment",
      account_id: e.destination.account_id,
      target_node_id: e.destination.target_node_id,
      author_node_id: e.destination.actor_node_id,
      destination_digest: e.destination_digest,
      body_sha256: e.body_sha256,
      attempt_id: e.attempt_id,
      provider_message_id: String(comment.id),
      provider_request_id: requestId,
    };
  }
  const tickets = new Map<string, { token: string; expiresAt: number }>();
  let preflights = 0;
  const ticketKey = (e: FollowUpDeliveryEnvelope) => `${e.attempt_id}:${e.envelope_digest}`;
  return {
    qualification: options.qualification,
    automatic_retries: false,
    lookup_receipt: true,
    async preflight(e, signal) {
      for (const [key, ticket] of tickets) if (ticket.expiresAt <= performance.now()) tickets.delete(key);
      if (tickets.size + preflights >= 64) throw Error("github_delivery_busy");
      preflights++;
      try {
        const token = await preflight(e, signal);
        if (signal.aborted) throw Error("github_delivery_cancelled");
        tickets.set(ticketKey(e), { token, expiresAt: performance.now() + 30000 });
      } finally {
        preflights--;
      }
    },
    assertReady(e) {
      const ticket = tickets.get(ticketKey(e));
      if (!ticket || ticket.expiresAt <= performance.now()) {
        tickets.delete(ticketKey(e));
        throw Error("github_delivery_preflight_required");
      }
      options.assertCredential?.(e, ticket.token);
    },
    async sendOnce(e, signal) {
      const ticket = tickets.get(ticketKey(e));
      tickets.delete(ticketKey(e));
      if (!ticket) throw Error("github_delivery_preflight_required");
      const token = ticket.token;
      // Readiness, credential and configuration fences ran synchronously before consume.
      // No awaited work precedes the sole POST.
      // Once durably started, all exceptions remain unknown; never infer non-delivery from HTTP errors.
      const response = await api(
        "/graphql",
        token,
        signal,
        JSON.stringify({
          query:
            "mutation OSStackFollowUp($input:AddCommentInput!){addComment(input:$input){clientMutationId subject{id} commentEdge{node{databaseId body author{... on User{id} ... on Bot{id}}}}}}",
          variables: {
            input: {
              subjectId: e.destination.target_node_id,
              body: githubDeliveryBody(e),
              clientMutationId: e.attempt_id,
            },
          },
        }),
      );
      const result = record(response.value);
      if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length))
        throw Error("github_delivery_graphql_error");
      const payload = record(record(result.data).addComment),
        subject = record(payload.subject),
        comment = record(record(payload.commentEdge).node),
        author = record(comment.author);
      if (payload.clientMutationId !== e.attempt_id || subject.id !== e.destination.target_node_id)
        throw Error("github_delivery_receipt_mismatch");
      // The mutation is addressed by immutable subject ID, not a mutable owner/repository URL.
      return receipt(
        e,
        { id: comment.databaseId, body: comment.body, user: { node_id: author.id }, issue_url: targetUrl(e) },
        response.requestId,
      );
    },
    async lookup(e, signal, context) {
      const token = await preflight(e, signal, false);
      let found: FollowUpDeliveryReceipt | undefined;
      // Old busy threads do not hide a new attempt behind historical pages. Context comes from the durable ledger.
      const since =
        context && Number.isSafeInteger(context.createdAtMs) && context.createdAtMs >= 0
          ? `&since=${encodeURIComponent(new Date(Math.max(0, context.createdAtMs - 300000)).toISOString())}`
          : "";
      // Fixed bounded pages, never follow a provider-supplied URL. Incomplete enumeration remains unknown.
      for (let page = 1; page <= 20; page++) {
        const response = await api(
          `${targetPath(e)}/comments?per_page=10&page=${page}${since}`,
          token,
          signal,
        );
        if (!Array.isArray(response.value) || response.value.length > 10)
          throw Error("github_delivery_invalid_list");
        for (const raw of response.value) {
          const comment = record(raw);
          // A public marker copied by another author is not a candidate receipt and cannot veto one.
          if (
            !comment.user ||
            typeof comment.user !== "object" ||
            Array.isArray(comment.user) ||
            (comment.user as Record<string, unknown>).node_id !== e.destination.actor_node_id ||
            comment.issue_url !== targetUrl(e)
          )
            continue;
          if (typeof comment.body !== "string" || !comment.body.includes(`osstack-delivery:${e.attempt_id}:`))
            continue;
          const match = receipt(e, raw, response.requestId);
          if (found) throw Error("github_delivery_duplicate_correlation");
          found = match;
        }
        if (!response.hasNext && response.value.length < 10) {
          if ((await options.credential(e)) !== token || signal.aborted)
            throw Error("github_delivery_registration_changed");
          return found ?? null;
        }
      }
      throw Error("github_delivery_lookup_incomplete");
    },
  };
}
