import { describe, expect, it, vi } from "vitest";
import { buildDecisionRequest } from "@osstack/core/decision-advice";
import { createTypeSafeDecisionClient } from "./typesafe-client.js";

const request = buildDecisionRequest({
  schemaVersion: 1,
  scopeId: "test",
  taskId: "t1",
  taskRevision: 0,
  purpose: "failure_label",
  state: "Test assertion failed",
});
const body = {
  model: "jev-1.13.0",
  answers: {
    decision: {
      type: "choice",
      choice: "abstain",
      confidence: 1,
      probabilities: {
        assertion: 0,
        environment: 0,
        context: 0,
        output_contract: 0,
        other: 0,
        abstain: 1,
      },
    },
  },
  usage: { input_tokens: 100, output_tokens: 50 },
};

describe("TypeSafe bounded decision client", () => {
  it("sends the pinned request once to the fixed endpoint without redirects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
    const result = await createTypeSafeDecisionClient({
      apiKey: "test-key",
      fetch: fetcher,
    }).advise(request);
    expect(result.status).toBe("answered");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request.body),
        redirect: "error",
      }),
    ]);
  });
  it("never retries HTTP errors or reveals provider body/credentials", async () => {
    const fetcher = vi.fn(
      async () => new Response("test-key private error", { status: 429 }),
    );
    const result = await createTypeSafeDecisionClient({
      apiKey: "test-key",
      fetch: fetcher,
    }).advise(request);
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "http_error",
      httpStatus: 429,
    });
    expect(JSON.stringify(result)).not.toContain("test-key");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds the whole operation even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const pending = createTypeSafeDecisionClient({
        apiKey: "test-key",
        timeoutMs: 100,
        fetch: () => new Promise(() => {}),
      }).advise(request);
      await vi.advanceTimersByTimeAsync(101);
      expect(await pending).toMatchObject({
        status: "unavailable",
        reason: "timeout",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("applies the same deadline to a stalled body and cancels its reader", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    try {
      const fetcher = async () =>
        new Response(new ReadableStream({ cancel: cancelled }));
      const pending = createTypeSafeDecisionClient({
        apiKey: "test-key",
        timeoutMs: 100,
        fetch: fetcher,
      }).advise(request);
      await vi.advanceTimersByTimeAsync(101);
      expect(await pending).toMatchObject({
        status: "unavailable",
        reason: "timeout",
      });
      expect(cancelled).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds actual body bytes and rejects malformed UTF-8 or model drift", async () => {
    for (const bytes of [
      new Uint8Array(65_537).fill(65),
      new Uint8Array([0xc3, 0x28]),
      new TextEncoder().encode(
        JSON.stringify({ ...body, model: "jev-latest" }),
      ),
    ]) {
      const result = await createTypeSafeDecisionClient({
        apiKey: "test-key",
        fetch: async () => new Response(bytes),
      }).advise(request);
      expect(result.status).toBe("unavailable");
      expect(result).not.toHaveProperty("answer");
    }
  });
  it("does not trust forged request objects and rejects credentials in state before dispatch", async () => {
    const fetcher = vi.fn();
    const client = createTypeSafeDecisionClient({
      apiKey: "test-key",
      fetch: fetcher,
    });
    expect((await client.advise({ ...request, digest: "bad" })).status).toBe(
      "unavailable",
    );
    const leaked = buildDecisionRequest({
      ...request.input,
      state: "test-key",
    });
    expect((await client.advise(leaked)).status).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects JSON-escaped credentials before fetch", async () => {
    const apiKey = 'test-"key\\credential';
    const fetcher = vi.fn();
    const client = createTypeSafeDecisionClient({ apiKey, fetch: fetcher });
    const leaked = buildDecisionRequest({ ...request.input, state: apiKey });
    expect(await client.advise(leaked)).toMatchObject({ status: "unavailable", reason: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

});
