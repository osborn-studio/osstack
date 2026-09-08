import { describe, expect, it } from "vitest";
import { ContinuationGrantBody, OutputCheck, SignedContinuationGrant } from "./session-continuation-grant.js";

const body = {
  version: 1,
  grant_id: "grant_1",
  session_id: "session_1",
  runtime_id: "codex_cli",
  runtime_policy_sha256: "a".repeat(64),
  repo_path: "/repos/osstack",
  initial_turn_id: "turn_1",
  initial_version: 1,
  issued_at: "2026-09-08T10:00:00.000Z",
  expires_at: "2026-09-08T11:00:00.000Z",
  max_resumes: 3,
  max_checks: 6,
  turn_timeout_ms: 30_000,
  steps: [{
    phase: "verification",
    instruction: "Run the frozen acceptance checks.\nPreserve this instruction exactly.",
    checks: [{ kind: "text_equals", expected: "implementation complete" }],
  }],
};

describe("session continuation grant protocol", () => {
  it("parses a strict bounded grant and defaults retries without rewriting instructions", () => {
    expect(ContinuationGrantBody.parse(body)).toEqual({
      ...body, steps: [{ ...body.steps[0], max_retries: 0 }],
    });
    expect(SignedContinuationGrant.parse({
      body, key_id: "owner_1", signature: Buffer.alloc(64).toString("base64"),
    }).body.steps[0]?.max_retries).toBe(0);
  });

  it.each([
    { kind: "text_equals", expected: "" },
    { kind: "json_value_equals", path: [], expected: null },
    { kind: "json_value_equals", path: ["result", "passed"], expected: true },
    { kind: "json_value_equals", path: ["count"], expected: 0 },
    { kind: "json_value_equals", path: ["message"], expected: "done" },
  ])("supports deterministic persisted-output equality: %j", (check) => {
    expect(OutputCheck.parse(check)).toEqual(check);
  });

  it.each([
    { kind: "shell", command: "true" },
    { kind: "file_exists", path: "/tmp/proof" },
    { kind: "model_score", expected: 1 },
    { kind: "text_equals", expected: "x".repeat(4001) },
    { kind: "text_equals", expected: "ok", trim: true },
    { kind: "json_value_equals", path: Array(9).fill("key"), expected: true },
    { kind: "json_value_equals", path: ["x".repeat(257)], expected: true },
    { kind: "json_value_equals", path: [], expected: "x".repeat(4001) },
    { kind: "json_value_equals", path: [], expected: {} },
    { kind: "json_value_equals", path: [], expected: [] },
    { kind: "json_value_equals", path: [], expected: Number.POSITIVE_INFINITY },
  ])("rejects scripts, external evidence and ambiguous output checks: %j", (check) => {
    expect(() => OutputCheck.parse(check)).toThrow();
  });

  it.each([
    { version: 2 }, { grant_id: "" }, { runtime_policy_sha256: "bad" },
    { repo_path: "relative/repo" }, { repo_path: "~/repo" }, { repo_path: "/repo\u0000other" },
    { repo_path: `/${"x".repeat(4096)}` },
    { initial_version: 0 }, { initial_version: 1.5 },
    { issued_at: "yesterday" }, { expires_at: "2026-02-30T00:00:00Z" },
    { max_resumes: 0 }, { max_resumes: 33 }, { max_checks: 0 }, { max_checks: 65 },
    { turn_timeout_ms: 99 }, { turn_timeout_ms: 300001 },
    { steps: [] }, { steps: Array(17).fill(body.steps[0]) },
    { approved: true },
  ])("rejects an invalid or expanded grant body: %j", (change) => {
    expect(() => ContinuationGrantBody.parse({ ...body, ...change })).toThrow();
  });

  it.each([
    { phase: "" }, { instruction: "" }, { instruction: " \n\t " }, { instruction: "x".repeat(16001) },
    { checks: [] }, { checks: Array(17).fill({ kind: "text_equals", expected: "ok" }) },
    { max_retries: -1 }, { max_retries: 4 }, { max_retries: 0.5 },
    { retry_instruction: "" }, { retry_instruction: " \n\t " }, { retry_instruction: "x".repeat(16001) },
    { command: "true" },
  ])("rejects an invalid or expanded step: %j", (change) => {
    expect(() => ContinuationGrantBody.parse({ ...body, steps: [{ ...body.steps[0], ...change }] })).toThrow();
  });

  it("accepts inclusive budget boundaries and absolute paths on supported platforms", () => {
    for (const repo_path of ["/", "/repos/my repo", "C:\\repos\\osstack", "\\\\server\\share\\repo"]) {
      expect(ContinuationGrantBody.parse({ ...body, repo_path }).repo_path).toBe(repo_path);
    }
    expect(ContinuationGrantBody.parse({
      ...body, max_resumes: 32, max_checks: 64, turn_timeout_ms: 300_000,
      steps: Array(16).fill({ ...body.steps[0], max_retries: 3, retry_instruction: "Repair the declared output contract." }),
    }).steps).toHaveLength(16);
    expect(ContinuationGrantBody.parse({ ...body, repo_path: `/${"x".repeat(4095)}` }).repo_path).toHaveLength(4096);
    expect(OutputCheck.parse({ kind: "json_value_equals", path: ["x".repeat(256)], expected: "y".repeat(4000) })).toMatchObject({ expected: "y".repeat(4000) });
    const frozenText = " \nCheck precisely.\t ";
    expect(ContinuationGrantBody.parse({
      ...body, steps: [{ ...body.steps[0], instruction: frozenText, retry_instruction: frozenText }],
    }).steps[0]).toMatchObject({ instruction: frozenText, retry_instruction: frozenText });
  });

  it("rejects malformed signatures and envelope fields without adding R3 approval authority", () => {
    const signed = { body, key_id: "owner_1", signature: Buffer.alloc(64).toString("base64") };
    for (const signature of ["", "invalid", Buffer.alloc(63).toString("base64"), signed.signature.replace(/=/g, ""), ` ${signed.signature}`]) {
      expect(() => SignedContinuationGrant.parse({ ...signed, signature })).toThrow();
    }
    expect(() => SignedContinuationGrant.parse({ ...signed, key_id: "" })).toThrow();
    expect(() => SignedContinuationGrant.parse({ ...signed, approval: "R3" })).toThrow();
  });
});
