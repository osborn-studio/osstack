import { canonicalJson } from "@osstack/core";
import type { VerificationHarnessRecord } from "@osstack/core/verification-publish";
import { expect, expectTypeOf, it } from "vitest";
import { acceptRun, buildRecord, type HarnessRecord, type StoppedResult } from "./record.js";
import { binding, digest, entry, hash, id, observation, prepared, recordInput } from "./testkit/fixtures.js";

it("keeps the harness record and kit record types equal", () => {
  expectTypeOf<HarnessRecord>().toEqualTypeOf<VerificationHarnessRecord>();
});

const cases: [Partial<StoppedResult>, string, number | null][] = [
  [{}, "passed", 0], [{ exitCode: 12 }, "failed", 12], [{ exitCode: 255 }, "blocked", 255],
  [{ exitCode: -1 }, "blocked", null], [{ exitCode: 256 }, "blocked", null], [{ exitCode: null }, "blocked", null],
  [{ started: false }, "blocked", null], [{ oomKilled: true, exitCode: 12 }, "blocked", null],
];
for (const termination of ["timeout", "cancelled", "output_limit", "namespace_rejected", "runtime_error"] as const)
  cases.push([{ termination, exitCode: 12 }, "blocked", null]);
it.each(cases)("maps %j to %s with exit %s", (change, outcome, exit) => {
  const input = recordInput(change);
  const record = buildRecord(input);
  const { result } = input;
  const resultDigest = hash(canonicalJson({ exit: result.exitCode, stdout: result.stdout.sha256,
    stderr: result.stderr.sha256, termination: result.termination, oomKilled: result.oomKilled, started: result.started }));
  const failure_code = outcome === "failed" ? entry.failure_code : null;
  expect(record).toEqual({ invocation_id: id, started_at: "2026-11-24T12:00:01Z", finished_at: "2026-11-24T12:00:01Z",
    outcome, failure_code, checks: [{ check_id: "check", exit, failure_code, result_digest: resultDigest }],
    evidence_digest: hash(canonicalJson({ resultDigest, stop: result.evidence })), evidence_refs: [],
    runtime_provenance: { runtime_id: "contained-docker", runtime_digest: "d".repeat(64), source_manifest_digest: digest },
    summary: `stdout: ${result.stdout.observedBytes} bytes; stderr: ${result.stderr.observedBytes} bytes` });
});

it("reports observed stream counts when the capture is truncated", () => {
  const input = recordInput({ termination: "output_limit" });
  input.result.stdout.observedBytes = 300;
  input.result.stderr.observedBytes = 512;
  expect(buildRecord(input).summary).toBe("stdout: 300 bytes; stderr: 512 bytes");
});

it("accepts matching identity and stop proof", () => {
  expect(acceptRun(prepared, binding, id, observation())).toBe(true);
});
it.each([
  ["identity", "invocationId", "other"], ["identity", "version", 2], ["identity", "kind", "other"],
  ["identity", "command", "other"], ["identity", "argv_digest", "other"], ["identity", "timeoutMs", 1],
  ["identity", "image", { ...prepared.image, contentDigest: "other" }],
  ["identity", "outputLimits", { stdoutBytes: 1, stderrBytes: 128 }], ["identity", "binding", { ...binding, profile_id: "other" }],
  ["result", "status", "stop_unknown"], ["result", "stopReceipt", null], ["result", "evidence", "other"],
  ["receipt", "kind", "other"], ["launch", "invocationId", "other"], ["launch", "daemonId", "other"],
] as const)("refuses a single changed %s.%s", (part, key, value) => {
  const obs = observation();
  const { stopReceipt } = obs.result;
  const fields = { identity: obs.identity, result: obs.result, receipt: stopReceipt, launch: stopReceipt.launch };
  Object.assign(fields[part], { [key]: value });
  if (part === "receipt" || part === "launch") obs.result.evidence = "docker-removed:" + hash(JSON.stringify(stopReceipt));
  expect(acceptRun(prepared, binding, id, obs)).toBe(false);
});
