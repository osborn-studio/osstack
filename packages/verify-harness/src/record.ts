import { createHash } from "node:crypto";
import type { ContainedImageReceipt, ContainedProfileRunResult } from "@osstack/agents";
import type { InstalledVerificationProfile, PreparedContainedProfile, runPreparedContainedProfile } from "@osstack/agents/contained-profile";
import { canonicalJson } from "@osstack/core";

export interface HarnessRecord {
  invocation_id: string;
  started_at: string;
  finished_at: string;
  outcome: "passed" | "failed" | "blocked" | "cancelled";
  failure_code: string | null;
  checks: readonly { check_id: string; failure_code: string | null; exit: number | null; result_digest: string }[];
  evidence_refs: readonly { artifact_id: string; sha256: string; size: number; type: string; retention: number }[];
  evidence_digest: string;
  runtime_provenance: { runtime_id: string; runtime_digest: string; source_manifest_digest: string };
  summary: string;
}

type Observation = Awaited<ReturnType<typeof runPreparedContainedProfile>>;
export type StoppedResult = Extract<ContainedProfileRunResult, { status: "stopped" }>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function acceptRun(prepared: PreparedContainedProfile, installedBinding: InstalledVerificationProfile["binding"],
  invocationId: string, observation: Observation): observation is Observation & { result: StoppedResult } {
  const { identity, result } = observation;
  return result.status !== "stop_unknown" && identity.invocationId === invocationId
    && identity.version === 1 && identity.kind === "contained_profile_run"
    && identity.command === prepared.command && identity.argv_digest === prepared.argv_digest
    && identity.timeoutMs === prepared.timeoutMs
    && canonicalJson(identity.image) === canonicalJson(prepared.image)
    && canonicalJson(identity.outputLimits) === canonicalJson(prepared.outputLimits)
    && canonicalJson(identity.binding) === canonicalJson(installedBinding)
    && !!result.stopReceipt && result.stopReceipt.kind === "docker_removed"
    && result.stopReceipt.launch.invocationId === invocationId && result.stopReceipt.launch.daemonId === identity.image.daemonId
    && result.evidence === `docker-removed:${hash(JSON.stringify(result.stopReceipt))}`;
}

export interface RecordInput {
  result: StoppedResult;
  check: InstalledVerificationProfile["profile"]["checks"][number];
  failure_code: string;
  image: ContainedImageReceipt;
  invocation_id: string;
  started_at: Date;
  finished_at: Date;
}
const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

export function buildRecord(input: RecordInput): HarnessRecord & { outcome: "passed" | "failed" | "blocked" } {
  const { result, image, check, invocation_id } = input;
  const { exitCode, stdout, stderr, termination, oomKilled, started } = result;
  const exit = termination === "exited" && started && !oomKilled && exitCode !== null
    && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null;
  const outcome = exit === 0 ? "passed" : exit !== null && check.failure_exit_codes.includes(exit) ? "failed" : "blocked";
  const failure_code = outcome === "failed" ? input.failure_code : null;
  const resultDigest = hash(canonicalJson({ exit: exitCode, stdout: stdout.sha256, stderr: stderr.sha256, termination, oomKilled, started }));
  return {
    invocation_id, started_at: stamp(input.started_at), finished_at: stamp(input.finished_at), outcome, failure_code,
    checks: [{ check_id: check.check_id, exit, failure_code, result_digest: resultDigest }],
    evidence_refs: [], evidence_digest: hash(canonicalJson({ resultDigest, stop: result.evidence })),
    runtime_provenance: { runtime_id: "contained-docker", runtime_digest: image.imageId.slice("sha256:".length),
      source_manifest_digest: image.contentDigest },
    summary: `stdout: ${stdout.observedBytes} bytes; stderr: ${stderr.observedBytes} bytes`,
  };
}
