import { repository } from "./config.js";
import type { PullRequestPort } from "./pull-request.js";

export function createPullRequestPort(deps: {
  fetchImpl: typeof fetch;
  timeout?: (ms: number) => AbortSignal;
}): PullRequestPort {
  return {
    async get(path, options) {
      const match = /^repos\/([^/]+\/[^/]+)\/pulls\/([1-9][0-9]*)$/u.exec(path);
      if (!match || !repository.safeParse(match[1]).success || !Number.isSafeInteger(Number(match[2]))) return { ok: false };
      try {
        const signal = AbortSignal.any([options.signal, (deps.timeout ?? AbortSignal.timeout)(15000)]);
        signal.throwIfAborted();
        const response = await deps.fetchImpl("https://api.github.com/" + path, {
          method: "GET", redirect: "error", signal,
          headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        });
        if (response.status !== 200 || response.redirected || !response.body) {
          await response.body?.cancel();
          return { ok: false };
        }
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 1048576) {
              await reader.cancel();
              return { ok: false };
            }
            if (chunk.value.length) chunks.push(chunk.value);
          }
          signal.throwIfAborted();
          return { ok: true, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) };
        } finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      } catch {
        return { ok: false };
      }
    },
  };
}
