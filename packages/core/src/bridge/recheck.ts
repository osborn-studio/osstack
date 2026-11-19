import { createHash } from "node:crypto";
import { isHostRecheckProof, type HostRecheckProof } from "./recheck-host-proof.js";
import { canonicalJson } from "./revision-grant.js";
import { parseVerificationResultV1, type VerificationResultV1 } from "./verification-result.js";

export type { HostRecheckProof };
type SkillBinding = Pick<
  VerificationResultV1,
  "skill_id" | "skill_version" | "skill_blob" | "skill_manifest_digest" | "profile_id" | "profile_digest"
> & { trusted_source_digest: string };
export interface RecheckBinding extends SkillBinding {
  repository_id: number;
  pr_number: number;
  base_sha: string;
  new_head_sha: string;
  original_result_id: string;
  original_checks: readonly string[];
  failed_check_id: string;
}
export interface ActionsAttemptFact {
  head_sha: string;
  attempt: number;
  complete: boolean;
  conclusion: "success" | "failure" | "pending";
  digest: string;
}
const parsed = new WeakSet<RecheckResult>();
export type RecheckResult = Readonly<
  SkillBinding &
    Pick<
      VerificationResultV1,
      "result_id" | "repository" | "repository_id" | "pr" | "head_sha" | "base_sha" | "outcome"
    > & { checks: readonly Readonly<VerificationResultV1["checks"][number]>[] }
>;

export function parseRecheckResult(text: string): RecheckResult | null {
  const contract = parseVerificationResultV1(text);
  if (!contract.ok) return null;
  const {
    result_id,
    repository,
    repository_id,
    pr,
    head_sha,
    base_sha,
    outcome,
    skill_id,
    skill_version,
    skill_blob,
    skill_manifest_digest,
    profile_id,
    profile_digest,
    trusted_source,
    checks,
  } = contract.result;
  const result = Object.freeze({
    result_id,
    repository,
    repository_id,
    pr,
    head_sha,
    base_sha,
    outcome,
    skill_id,
    skill_version,
    skill_blob,
    skill_manifest_digest,
    profile_id,
    profile_digest,
    trusted_source_digest: createHash("sha256").update(canonicalJson(trusted_source)).digest("hex"),
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
  });
  parsed.add(result);
  return result;
}

export interface RecheckInputs {
  result: RecheckResult | null;
  actions: ActionsAttemptFact | null;
  host: HostRecheckProof | null;
}
export type RecheckMissing = "result" | "actions" | "host";
export type RecheckVerdict =
  | { state: "recheck_passed"; reason: null; missing: [] }
  | { state: "awaiting_decision"; reason: "verify_recheck_failed" | "verify_recheck_binding_changed"; missing: [] }
  | { state: "reverify_pending"; reason: "verify_recheck_missing"; missing: RecheckMissing[] };

export function classifyRecheck(pinned: RecheckBinding, inputs: RecheckInputs): RecheckVerdict {
  const { result, actions, host } = inputs;
  const missing: RecheckMissing[] = [];
  if (
    !result ||
    !parsed.has(result) ||
    result.repository_id !== pinned.repository_id ||
    result.pr !== pinned.pr_number ||
    result.base_sha !== pinned.base_sha ||
    result.head_sha !== pinned.new_head_sha ||
    result.result_id === pinned.original_result_id
  ) {
    missing.push("result");
  } else {
    const keys = [
      "skill_id",
      "skill_version",
      "skill_blob",
      "skill_manifest_digest",
      "profile_id",
      "profile_digest",
      "trusted_source_digest",
    ] as const;
    const ids = new Set(result.checks.map((c) => c.check_id));
    if (
      keys.some((k) => result[k] !== pinned[k]) ||
      !ids.has(pinned.failed_check_id) ||
      pinned.original_checks.some((id) => !ids.has(id))
    )
      return { state: "awaiting_decision", reason: "verify_recheck_binding_changed", missing: [] };
    if (
      result.outcome === "failed" ||
      (result.outcome === "passed" && result.checks.some((c) => c.failure_code !== null || c.exit !== 0))
    )
      return { state: "awaiting_decision", reason: "verify_recheck_failed", missing: [] };
    if (result.outcome !== "passed") missing.push("result");
  }
  if (
    !actions ||
    actions.head_sha !== pinned.new_head_sha ||
    actions.complete !== true ||
    actions.conclusion !== "success" ||
    !Number.isSafeInteger(actions.attempt) ||
    actions.attempt <= 0 ||
    typeof actions.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(actions.digest)
  )
    missing.push("actions");
  if (
    !isHostRecheckProof(host) ||
    host.outcome !== "passed" ||
    host.head_sha !== pinned.new_head_sha ||
    host.base_sha !== pinned.base_sha ||
    host.profile_digest !== pinned.profile_digest ||
    host.trusted_source_digest !== pinned.trusted_source_digest
  )
    missing.push("host");
  return missing.length
    ? { state: "reverify_pending", reason: "verify_recheck_missing", missing }
    : { state: "recheck_passed", reason: null, missing: [] };
}
