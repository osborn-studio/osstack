import { createHash } from "node:crypto";
import type { InstalledVerificationProfile, PreparedContainedProfile } from "@osstack/agents/contained-profile";
import type { HarnessConfig } from "../config.js";
import type { RecordInput, StoppedResult } from "../record.js";

export const digest = "a".repeat(64);
export const head = "b".repeat(40);
export const base = "c".repeat(40);
export const id = "13507dbf-3426-4563-90de-4f528cea0428";
export const date = new Date("2026-11-24T12:00:01.999Z");
export const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const entry = { repository: "fixture/repo", repository_id: 101, skill_id: "skill", profile_id: "profile",
  profile_digest: digest, trusted_source: { repository: "fixture/trusted", commit_sha: base, artifact_digest: digest },
  base_image_id: "sha256:" + digest, allowed_argv: ["/bin/sh", "/osstack-trusted/test"], failure_code: "check-failed" };
export const config: HarnessConfig = { version: 1, docker: { socket_path: "/sock", daemon_id: "daemon" },
  profiles_root: "/profiles", entries: [entry] };
export const prBody = { state: "open", number: 3, base: { repo: { id: 101, full_name: entry.repository }, sha: base },
  head: { repo: { id: 101 }, sha: head } };
export const binding = { profile_id: entry.profile_id, profile_digest: digest,
  trusted_source: { repository: entry.trusted_source.repository, commit: base, artifact_digest: digest } };
export const check = { check_id: "check", category: "test" as const, failure_exit_codes: [1, 12] };
export const installed: InstalledVerificationProfile = {
  binding, profile: { version: 1, profile_id: entry.profile_id, checks: [check], argv: entry.allowed_argv,
    harness: { path: entry.allowed_argv[1]!, content: "exit 0" }, fixtures: [], image: "fixture@sha256:" + digest,
    limits: { timeout_seconds: 1, memory_mb: 128, cpus: 1, pids: 64, stdout_bytes: 128, stderr_bytes: 128 },
    network: "none", read_only_rootfs: true, no_new_privileges: true, working_directory: "candidate" },
  revalidateForLaunch: () => installed,
};
export const prepared: PreparedContainedProfile = {
  binding, command: "fixture", argv_digest: digest, timeoutMs: 1000, outputLimits: { stdoutBytes: 128, stderrBytes: 128 },
  runtimeBlockers: [], image: { version: 1, imageId: "sha256:" + "d".repeat(64), baseImageId: entry.base_image_id,
    contentDigest: digest, archiveDigest: digest, workingDirectory: "/osstack-candidate-" + id, daemonId: "daemon",
    trustedProfile: { baseImageReference: installed.profile.image, profileDigest: digest, artifactDigest: digest, contentDigest: digest } },
};
export const marker = "untrusted-output-marker";
function capture(stream: string) {
  const bytes = Buffer.from(stream + marker);
  return { bytes, sha256: hash(bytes), observedBytes: bytes.length };
}
export function observation(overrides: Partial<StoppedResult> = {}) {
  const stopReceipt: StoppedResult["stopReceipt"] = { version: 1, kind: "docker_removed", confirmedAt: 1,
    launch: { version: 1, invocationId: id, daemonId: "daemon", specDigest: digest, containerId: digest, nonce: id } };
  const result: StoppedResult = { status: "stopped", termination: "exited", started: true, exitCode: 0, oomKilled: false,
    reason: null, stdout: capture("out"), stderr: capture("err"), stopReceipt,
    evidence: "docker-removed:" + hash(JSON.stringify(stopReceipt)), ...overrides };
  const { command, argv_digest, timeoutMs, outputLimits, image } = prepared;
  return { identity: { version: 1 as const, kind: "contained_profile_run" as const, invocationId: id,
    command, argv_digest, timeoutMs, outputLimits, image, binding }, result };
}
export function recordInput(overrides?: Partial<StoppedResult>): RecordInput {
  return { result: observation(overrides).result, check, failure_code: entry.failure_code, image: prepared.image,
    invocation_id: id, started_at: date, finished_at: date };
}
