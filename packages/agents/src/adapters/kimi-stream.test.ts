import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KimiStreamAccumulator } from "./kimi-stream.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/kimi");

function validResult(subjectRunId = "run_1_verify_1"): Record<string, unknown> {
  return {
    schema_version: 1,
    review_id: "review_1",
    subject_run_id: subjectRunId,
    reviewer: {
      adapter: "kimi-code",
      provider: "kimi",
      model: "k3-256k",
    },
    verdict: "approved",
    risk: "low",
    markdown: "# Review",
    evaluation_judgments: [],
    findings: [],
    recommended_actions: [],
  };
}

function sentinelEvent(
  result: Record<string, unknown> = validResult(),
): string {
  return JSON.stringify({
    role: "assistant",
    content: `Review complete.\nOSSTACK_REVIEW_RESULT=${JSON.stringify(result)}`,
  });
}

describe("KimiStreamAccumulator", () => {
  it("parses the sanitized real probe shape", () => {
    const accumulator = new KimiStreamAccumulator(64_000);
    const messages = accumulator.pushChunk(readFileSync(
      join(fixturesDir, "probe.stream.jsonl"),
      "utf8",
    ));
    accumulator.finish();

    expect(messages.map((message) => message.type)).toEqual([
      "assistant",
      "session.resume_hint",
    ]);
    expect(accumulator.text()).toBe("OSSTACK_KIMI_PROBE_OK");
    expect(accumulator.unknownTypes()).toEqual([]);
  });

  it("buffers an incomplete JSON line until a newline arrives", () => {
    const accumulator = new KimiStreamAccumulator(64_000);

    expect(accumulator.pushChunk('{"role":"assistant","content":"hel')).toEqual([]);
    expect(accumulator.pushChunk('lo"}\n')).toHaveLength(1);
    expect(accumulator.text()).toBe("hello");
  });

  it("preserves unknown event types without treating them as approval", () => {
    const accumulator = new KimiStreamAccumulator(64_000);
    accumulator.pushLine('{"type":"future.event","payload":{"value":1}}');

    expect(accumulator.unknownTypes()).toEqual(["future.event"]);
    expect(() => accumulator.reviewResult("run_1_verify_1")).toThrow(
      /missing OSSTACK_REVIEW_RESULT/,
    );
  });

  it("fails on malformed JSONL", () => {
    const accumulator = new KimiStreamAccumulator(64_000);

    expect(() => accumulator.pushChunk(readFileSync(
      join(fixturesDir, "malformed.stream.jsonl"),
      "utf8",
    ))).toThrow(/invalid Kimi stream JSON/);
  });

  it("extracts one strict result sentinel and hides it from display text", () => {
    const accumulator = new KimiStreamAccumulator(64_000);
    accumulator.pushLine(sentinelEvent());

    expect(accumulator.reviewResult("run_1_verify_1").verdict).toBe("approved");
    expect(accumulator.text()).toBe("Review complete.");
  });

  it("rejects duplicate result sentinels", () => {
    const accumulator = new KimiStreamAccumulator(64_000);
    accumulator.pushLine(sentinelEvent());
    accumulator.pushLine(sentinelEvent());

    expect(() => accumulator.reviewResult("run_1_verify_1")).toThrow(
      /duplicate OSSTACK_REVIEW_RESULT/,
    );
  });

  it("rejects a mismatched subject run id", () => {
    const accumulator = new KimiStreamAccumulator(64_000);
    accumulator.pushLine(sentinelEvent(validResult("different_run")));

    expect(() => accumulator.reviewResult("run_1_verify_1")).toThrow(
      /subject_run_id/,
    );
  });

  it("bounds total stream bytes across multiple complete lines", () => {
    const accumulator = new KimiStreamAccumulator(30);
    accumulator.pushLine('{"role":"assistant"}');

    expect(() => accumulator.pushLine('{"role":"assistant"}')).toThrow(
      /byte limit/,
    );
  });

  it("rejects a truncated final line on finish", () => {
    const accumulator = new KimiStreamAccumulator(64_000);
    accumulator.pushChunk(readFileSync(
      join(fixturesDir, "truncated.stream.jsonl"),
      "utf8",
    ).trimEnd());

    expect(() => accumulator.finish()).toThrow(/invalid Kimi stream JSON/);
  });
});
