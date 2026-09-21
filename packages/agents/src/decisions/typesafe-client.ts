import {
  buildDecisionRequest,
  parseDecisionAnswer,
  type DecisionAnswer,
  type DecisionRequest,
} from "@osstack/core/decision-advice";

export type DecisionAdviceResult =
  | { status: "answered"; answer: DecisionAnswer }
  | {
      status: "unavailable";
      reason:
        | "invalid_request"
        | "timeout"
        | "http_error"
        | "network_error"
        | "invalid_response";
      httpStatus?: number;
    };

export interface TypeSafeDecisionClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Injection for hermetic tests; endpoints cannot be selected by task input. */
  fetch?: typeof globalThis.fetch;
}

/** Text-only observer. No tools, redirects, retries, or scheduler authority. */
export function createTypeSafeDecisionClient(
  options: TypeSafeDecisionClientOptions,
) {
  const key = options.apiKey;
  const timeoutMs = options.timeoutMs ?? 1500;
  if (
    !key ||
    /\s/.test(key) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000
  )
    throw Error("DECISION_CLIENT_CONFIG_INVALID");
  const fetcher = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    advise: async (request: DecisionRequest): Promise<DecisionAdviceResult> => {
      let payload: string;
      let snapshot: DecisionRequest;
      try {
        snapshot = buildDecisionRequest(request.input);
        payload = JSON.stringify(snapshot.body);
        if (
          snapshot.digest !== request.digest ||
          payload !== JSON.stringify(request.body) ||
          payload.includes(JSON.stringify(key).slice(1, -1))
        )
          throw Error();
      } catch {
        return { status: "unavailable", reason: "invalid_request" };
      }
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopReader = () => {
        if (reader) void reader.cancel().catch(() => {});
      };
      const timeout = new Promise<DecisionAdviceResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          stopReader();
          resolve({ status: "unavailable", reason: "timeout" });
        }, timeoutMs);
      });
      const operation = (async (): Promise<DecisionAdviceResult> => {
        let response: Response;
        try {
          response = await fetcher("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
            },
            body: payload,
          });
        } catch {
          return {
            status: "unavailable",
            reason: controller.signal.aborted ? "timeout" : "network_error",
          };
        }
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return { status: "unavailable", reason: "timeout" };
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return {
            status: "unavailable",
            reason: "http_error",
            httpStatus: response.status,
          };
        }
        try {
          if (!response.body) throw Error();
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const part = await reader.read();
            if (controller.signal.aborted)
              return { status: "unavailable", reason: "timeout" };
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 65_536) throw Error();
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          return {
            status: "answered",
            answer: parseDecisionAnswer(JSON.parse(raw), snapshot),
          };
        } catch {
          controller.abort();
          stopReader();
          return { status: "unavailable", reason: "invalid_response" };
        } finally {
          reader?.releaseLock();
          reader = undefined;
        }
      })();
      // Race also bounds test/custom transports that do not implement AbortSignal.
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
