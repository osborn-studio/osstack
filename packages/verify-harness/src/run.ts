import type { ContainedCandidateFile } from "@osstack/agents";
import type { InstalledVerificationProfile, PreparedContainedProfile, loadInstalledVerificationProfile, prepareContainedProfileImage, runPreparedContainedProfile } from "@osstack/agents/contained-profile";
import { identifier, type HarnessConfig } from "./config.js";
import { readPullRequest, type PullRequestPort, type PullRequestRefusal } from "./pull-request.js";
import { acceptRun, buildRecord, type StoppedResult } from "./record.js";
import { writeEvidence, writeRequestFile } from "./request-file.js";

export interface HarnessInput {
  config: HarnessConfig;
  repository_id: number;
  pr: number;
  dropDir: string;
  evidenceDir: string;
  journalRoot: string;
  signal: AbortSignal;
}
export interface HarnessPorts {
  github: PullRequestPort;
  fetchSource(repository: string, headSha: string, signal: AbortSignal): Promise<{ tree: string; files: readonly ContainedCandidateFile[] }>;
  loadProfile: typeof loadInstalledVerificationProfile;
  prepare: typeof prepareContainedProfileImage;
  run: typeof runPreparedContainedProfile;
  now(): Date;
  uuid(): string;
  ownerUid(): number;
}
export type HarnessRefusal = PullRequestRefusal | "not_configured" | "source_unavailable" | "candidate_unsupported"
  | "profile_unavailable" | "isolation_unavailable" | "stop_unknown" | "request_write_failed";
export type HarnessOutcome =
  | { ok: true; invocation_id: string; file: string; outcome: ReturnType<typeof buildRecord>["outcome"] }
  | { ok: false; reason: HarnessRefusal };
const refuse = (reason: HarnessRefusal) => ({ ok: false, reason }) as const;
const limits = new Set(["CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED", "CONTAINED_CANDIDATE_LIMIT",
  "CONTAINED_CANDIDATE_FILE_LIMIT", "CONTAINED_CANDIDATE_SIZE_LIMIT", "CONTAINED_CANDIDATE_PATH_LIMIT"]);
export const candidateLimit = (error: unknown) => error instanceof Error && limits.has(error.message);
// The harness has no revocable grant. Each callback returns synchronously without a value.
const authorize = (): void => {};

export async function runHarness(input: HarnessInput, ports: HarnessPorts): Promise<HarnessOutcome> {
  const { config, repository_id, pr, signal, journalRoot } = input;
  const entry = config.entries.find(item => item.repository_id === repository_id);
  if (!entry) return refuse("not_configured");
  const pull = await readPullRequest(entry, pr, ports.github, { signal });
  if (!pull.ok) return pull;
  const { head_sha, base_sha } = pull;
  let source: Awaited<ReturnType<HarnessPorts["fetchSource"]>>;
  try {
    source = await ports.fetchSource(entry.repository, head_sha, signal);
  } catch (error) {
    return refuse(candidateLimit(error) ? "candidate_unsupported" : "source_unavailable");
  }

  let installed: InstalledVerificationProfile;
  try {
    const { repository, commit_sha, artifact_digest } = entry.trusted_source;
    installed = ports.loadProfile({
      installedRoot: config.profiles_root, ownerUid: ports.ownerUid(), allowedArgv: [entry.allowed_argv],
    }, { profile_id: entry.profile_id, profile_digest: entry.profile_digest,
      trusted_source: { repository, commit: commit_sha, artifact_digest } });
  } catch {
    return refuse("profile_unavailable");
  }
  const [check] = installed.profile.checks;
  if (installed.profile.checks.length !== 1 || !check || !identifier.safeParse(check.check_id).success)
    return refuse("profile_unavailable");

  const socketPath = config.docker.socket_path;
  let prepared: PreparedContainedProfile;
  try {
    prepared = await ports.prepare({ socketPath, daemonId: config.docker.daemon_id, baseImageId: entry.base_image_id },
      source.files, installed, authorize);
    if (prepared.runtimeBlockers.length) return refuse("profile_unavailable");
  } catch (error) {
    if (error instanceof Error && error.message === "CONTAINED_PROFILE_LIMITS_UNSUPPORTED") return refuse("profile_unavailable");
    return refuse(candidateLimit(error) ? "candidate_unsupported" : "isolation_unavailable");
  }

  let invocation_id: string;
  let started_at: Date;
  let result: StoppedResult;
  try {
    invocation_id = ports.uuid();
    started_at = ports.now();
    const observation = await ports.run(prepared, { socketPath, journalRoot, authorizeStop: authorize, authorizeRead: authorize },
      { invocationId: invocation_id, signal });
    if (!acceptRun(prepared, installed.binding, invocation_id, observation)) return refuse("stop_unknown");
    result = observation.result;
  } catch {
    return refuse("stop_unknown");
  }
  try {
    const record = buildRecord({ result, check, failure_code: entry.failure_code, image: prepared.image,
      invocation_id, started_at, finished_at: ports.now() });
    await writeEvidence(input.evidenceDir, invocation_id, result);
    const file = await writeRequestFile(input.dropDir, { version: 1, repository_id, pr, skill_id: entry.skill_id, head_sha, base_sha, record });
    return { ok: true, invocation_id, file, outcome: record.outcome };
  } catch {
    return refuse("request_write_failed");
  }
}
