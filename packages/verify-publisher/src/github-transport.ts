import { z } from "zod";
import { AppKeyUnavailable } from "./app-key.js";
import { repository, type PublisherAllowlist } from "./config.js";
import type { PublisherGithub } from "./publish.js";

export interface PublisherGithubDeps {
  readonly fetchImpl: typeof fetch;
  readonly signJwt: (nowMs: number) => Promise<string>;
  readonly now?: () => number;
  readonly timeout?: (ms: number) => AbortSignal;
  readonly anonymousReads?: boolean;
}
export interface PublisherGithubTransport extends PublisherGithub {
  readonly keyUnavailable: () => boolean;
}

const permissions = { checks: "write", metadata: "read" } as const;
const selected = {
  repository_selection: z.literal("selected"),
  permissions: z.object({ checks: z.literal(permissions.checks), metadata: z.literal(permissions.metadata) }).strict(),
};
const installation = z.object({ ...selected, id: z.number(), app_id: z.number(), suspended_at: z.null() });
const tokenReply = z.object({ ...selected, token: z.string().min(1).max(512).regex(/^\S+$/u),
  repositories: z.tuple([z.object({ id: z.number() })]) });
const pull = /^repos\/([a-z0-9-]+\/[a-z0-9._-]+)\/pulls\/[1-9]\d{0,15}$/u;
const list = /^repos\/([a-z0-9-]+\/[a-z0-9._-]+)\/commits\/[a-f0-9]{40}\/check-runs\?check_name=osstack%2Fverify-intake%2F([a-z][a-z0-9_-]{0,127})&filter=all&per_page=100$/u;
const detail = /^repos\/([a-z0-9-]+\/[a-z0-9._-]+)\/check-runs\/[1-9]\d{0,18}$/u;
const mib = 1048576;
const unavailable = () => new Error("unavailable");

// Also bound injected operations that do not observe their signal.
async function untilAbort<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(unavailable()); });
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([start(), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { cancel(); throw unavailable(); }
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createPublisherGithub(config: PublisherAllowlist, deps: PublisherGithubDeps): PublisherGithubTransport {
  interface Scope {
    id: number;
    skills: Set<string>;
    jwt?: string;
    token?: string;
    minting?: Promise<string>;
  }
  const repos = new Map<string, Scope>();
  const conflicts = new Set<string>();
  for (const entry of config.allow) {
    const name = entry.repository;
    if (name.includes("..") || !repository.safeParse(name).success || conflicts.has(name)) continue;
    const scope = repos.get(name);
    if (!scope) repos.set(name, { id: entry.repository_id, skills: new Set([entry.skill_id]) });
    else if (scope.id === entry.repository_id) scope.skills.add(entry.skill_id);
    else { conflicts.add(name); repos.delete(name); }
  }
  let keyUnavailable = false;

  async function send(path: string, signal: AbortSignal, ms: number, limit: number, status: number,
    credential: string | undefined, init: RequestInit) {
    const bounded = AbortSignal.any([signal, (deps.timeout ?? AbortSignal.timeout)(ms)]);
    const headers = new Headers({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
      "user-agent": "osstack-verify-publisher" });
    if (credential !== undefined) headers.set("authorization", "Bearer " + credential);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return untilAbort(bounded, async () => {
      const response = await deps.fetchImpl("https://api.github.com/" + path, { ...init, headers, redirect: "error", signal: bounded });
      bounded.throwIfAborted();
      if (response.redirected || response.status !== status) {
        void response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      return readBody(response, limit, bounded);
    });
  }
  function get(path: string, signal: AbortSignal, ms: number, limit: number, credential?: string) {
    return send(path, signal, ms, limit, 200, credential, { method: "GET" });
  }
  async function mint(name: string, scope: Scope, signal: AbortSignal) {
    let jwt: string;
    try { jwt = await deps.signJwt((deps.now ?? Date.now)()); }
    catch (e) { if (e instanceof AppKeyUnavailable) keyUnavailable = true; throw unavailable(); }
    scope.jwt = jwt;
    const proof = installation.parse(await get("repos/" + name + "/installation", signal, 5000, 65536, jwt));
    if (proof.id !== config.producer.installation_id || proof.app_id !== config.producer.app_id) throw unavailable();
    const body = JSON.stringify({ repository_ids: [scope.id], permissions });
    const reply = tokenReply.parse(await send("app/installations/" + proof.id + "/access_tokens",
      signal, 10000, 65536, 201, jwt, { method: "POST", body }));
    if (reply.repositories[0].id !== scope.id) throw unavailable();
    scope.token = reply.token;
    return reply.token;
  }
  function token(name: string, scope: Scope, signal: AbortSignal) {
    return untilAbort(signal, async () => {
      if (scope.token !== undefined) return scope.token;
      scope.minting ??= mint(name, scope, signal).finally(() => { delete scope.minting; });
      return scope.minting;
    });
  }
  function publicReply(body: unknown) {
    // A successful API response can echo a credential in a JSON field or field name.
    const text = JSON.stringify(body);
    for (const scope of repos.values()) {
      for (const secret of [scope.token, scope.jwt]) {
        if (secret && text.includes(JSON.stringify(secret).slice(1, -1))) throw unavailable();
      }
    }
    return { ok: true, body } as const;
  }
  return {
    keyUnavailable: () => keyUnavailable,
    async get(path, options) {
      try {
        const { signal } = options;
        if ("method" in options && options.method !== "GET") return { ok: false };
        const match = pull.exec(path) ?? detail.exec(path) ?? list.exec(path);
        if (!match || signal.aborted) return { ok: false };
        const name = match[1]!, skill = match[2];
        const scope = repos.get(name);
        if (!scope || (skill && !scope.skills.has(skill))) return { ok: false };
        const auth = deps.anonymousReads ? undefined : await token(name, scope, signal);
        const body = await get(path, signal, 15000, skill ? 4 * mib : mib, auth);
        return publicReply(body);
      } catch { return { ok: false }; }
    },
    async createCheckRun(name, run, { signal }) {
      try {
        const scope = repos.get(name);
        if (!scope || signal.aborted) return { ok: false };
        const body = JSON.stringify(run);
        if (Buffer.byteLength(body) > 65536) return { ok: false };
        const auth = await token(name, scope, signal);
        const path = "repos/" + name + "/check-runs";
        const result = await send(path, signal, 15000, mib, 201, auth, { method: "POST", body });
        return publicReply(result);
      } catch { return { ok: false }; }
    },
  };
}
