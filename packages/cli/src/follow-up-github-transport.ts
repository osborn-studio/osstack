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
            if (bytes > 1_048_576) {
              response.destroy();
              request.destroy();
              fail();
            } else chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => {
            try {
              if (response.statusCode !== (body === undefined ? 200 : 201)) throw Error();
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
  async function preflight(e: FollowUpDeliveryEnvelope, signal: AbortSignal): Promise<string> {
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
      issue.number !== e.destination.issue_number
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
  return {
    qualification: options.qualification,
    automatic_retries: false,
    lookup_receipt: true,
    async sendOnce(e, signal) {
      const token = await preflight(e, signal);
      // Revocation or credential rotation during preflight closes admission before the sole POST.
      if ((await options.credential(e)) !== token || signal.aborted)
        throw Error("github_delivery_registration_changed");
      const response = await api(
        `${targetPath(e)}/comments`,
        token,
        signal,
        JSON.stringify({ body: githubDeliveryBody(e) }),
      );
      return receipt(e, response.value, response.requestId);
    },
    async lookup(e, signal) {
      const token = await preflight(e, signal);
      let found: FollowUpDeliveryReceipt | undefined;
      // Fixed bounded pages, never follow a provider-supplied URL. Incomplete enumeration remains unknown.
      for (let page = 1; page <= 5; page++) {
        const response = await api(`${targetPath(e)}/comments?per_page=100&page=${page}`, token, signal);
        if (!Array.isArray(response.value) || response.value.length > 100)
          throw Error("github_delivery_invalid_list");
        for (const raw of response.value) {
          const comment = record(raw);
          if (typeof comment.body !== "string" || !comment.body.includes(`osstack-delivery:${e.attempt_id}:`))
            continue;
          const match = receipt(e, raw, response.requestId);
          if (found) throw Error("github_delivery_duplicate_correlation");
          found = match;
        }
        if (!response.hasNext && response.value.length < 100) {
          if ((await options.credential(e)) !== token || signal.aborted)
            throw Error("github_delivery_registration_changed");
          return found ?? null;
        }
      }
      throw Error("github_delivery_lookup_incomplete");
    },
  };
}
