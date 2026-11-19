import { createHash, type KeyObject } from "node:crypto";
import { canonicalJson, parseStoredGrant, RevisionGrantError, type RevisionGrant } from "./revision-grant.js";
import {
  parseLocalFailureRevisionGrant,
  verifyLocalFailureRevisionGrantSignature,
  type LocalFailureOptIn,
} from "./revision-local-failure-grant.js";
import { localFailureEligibility, type LocalFailureBinding, type LocalVerificationReceipt } from "./local-failure.js";

export type DiagnosisProfile = Pick<LocalFailureOptIn, "profile_id" | "profile_digest" | "trusted_source">;
export type DiagnosisBinding = Pick<
  RevisionGrant,
  "repository" | "pr_number" | "branch" | "base_ref" | "base_sha" | "head_sha" | "root_mission_id"
>;
type Principal = {
  principal_id: string;
  client_session_id: string;
  write_scopes: readonly string[];
};
type Authority = Pick<RevisionGrant, "principal_id" | "client_session_id" | "scope_id" | "issued_at" | "expires_at" | "budget">;
export function checkGrantPrincipal(grant: Authority, principal: Principal) {
  if (
    principal.principal_id !== grant.principal_id ||
    principal.client_session_id !== grant.client_session_id ||
    !principal.write_scopes.includes(grant.scope_id)
  )
    throw new RevisionGrantError("grant_invalid");
}
export function checkGrantWindow(grant: Authority, now: number, maxValidity: number, budgetJson: string | null) {
  if (!Number.isSafeInteger(now) || grant.expires_at - grant.issued_at > maxValidity) throw new RevisionGrantError("grant_invalid");
  if (now >= grant.expires_at) throw new RevisionGrantError("grant_expired");
  let origin = grant.issued_at;
  if (budgetJson !== null) {
    try {
      origin = JSON.parse(budgetJson).origin;
    } catch {
      throw new RevisionGrantError("grant_invalid");
    }
    if (!Number.isSafeInteger(origin) || origin < 0) throw new RevisionGrantError("grant_invalid");
  }
  if (now >= origin + grant.budget.max_wall_clock_hours * 3_600_000) throw new RevisionGrantError("budget_exhausted");
}
export interface DiagnosisGrantInput {
  grant_json: string;
  keys: ReadonlyMap<string, { public_key: KeyObject; max_validity_ms: number }>;
  principal: Principal;
  now: number;
  budget_json: string | null;
  request: DiagnosisBinding & DiagnosisProfile;
  installed: DiagnosisProfile;
  timeout_seconds: number;
  tree_sha: string;
  candidate: DiagnosisBinding & { tree_sha: string };
}
export function verifyDiagnosisGrant(input: DiagnosisGrantInput) {
  const invalid = { ok: false, reason: "verify_grant_invalid" } as const;
  let grant: ReturnType<typeof parseLocalFailureRevisionGrant>;
  try {
    grant = parseLocalFailureRevisionGrant(input.grant_json);
  } catch {
    try {
      parseStoredGrant(input.grant_json);
      return { ok: false, reason: "verify_grant_missing" } as const;
    } catch {
      return invalid;
    }
  }
  const key = input.keys.get(grant.key_id);
  if (!key || !verifyLocalFailureRevisionGrantSignature(grant, key.public_key)) return invalid;
  try {
    checkGrantPrincipal(grant, input.principal);
    checkGrantWindow(grant, input.now, key.max_validity_ms, input.budget_json);
    if (
      input.now < grant.issued_at ||
      !Number.isSafeInteger(input.timeout_seconds) ||
      input.timeout_seconds < 1 ||
      input.timeout_seconds > grant.local_failure.diagnostic_timeout_seconds
    )
      return invalid;
    for (const field of ["root_mission_id", "repository", "pr_number", "branch", "base_ref", "base_sha", "head_sha"] as const)
      if (input.request[field] !== grant[field] || input.candidate[field] !== grant[field]) return invalid;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.tree_sha) || input.candidate.tree_sha !== input.tree_sha) return invalid;
    for (const pin of [input.request, input.installed])
      if (
        pin.profile_id !== grant.local_failure.profile_id ||
        pin.profile_digest !== grant.local_failure.profile_digest ||
        canonicalJson(pin.trusted_source) !== canonicalJson(grant.local_failure.trusted_source)
      )
        return invalid;
  } catch {
    return invalid;
  }
  return {
    ok: true,
    grant,
    grant_digest: createHash("sha256").update(input.grant_json).digest("hex"),
  } as const;
}
export type DiagnosisReason =
  | "verify_grant_invalid"
  | "verify_grant_missing"
  | "verify_budget_exhausted"
  | "verify_chain_busy"
  | "verify_chain_depth_limit"
  | "verify_chain_lineage_unknown"
  | "verify_duplicate"
  | "verify_withdrawn"
  | "verify_infrastructure_error"
  | "verify_stop_unproven"
  | "verify_receipt_binding_invalid"
  | "verify_profile_unavailable"
  | "verify_not_reproduced";
export type DiagnosisVerdict =
  | { state: "eligible"; reason: null }
  | {
      state: "diagnostic_closed" | "awaiting_decision";
      reason: DiagnosisReason;
    };
export interface ExpectedFailure {
  check_id: string;
  failure_code: string;
}
export interface ClassificationInput {
  receipt: LocalVerificationReceipt;
  binding: LocalFailureBinding;
  profileChecks: readonly {
    check_id: string;
    category: string;
    failure_exit_codes: readonly number[];
  }[];
  expected_failures: readonly ExpectedFailure[];
  allowed_failure_codes: readonly string[];
  termination: "exited" | "timeout" | "cancelled" | "runtime_error" | "namespace_rejected" | "output_limit";
  oomKilled: boolean;
}
export function classifyDiagnosis(i: ClassificationInput): DiagnosisVerdict {
  const unavailable = {
    state: "awaiting_decision",
    reason: "verify_profile_unavailable",
  } as const;
  const missed = {
    state: "diagnostic_closed",
    reason: "verify_not_reproduced",
  } as const;
  if (i.termination !== "exited" || i.oomKilled || ["timeout", "cancelled", "infrastructure_error"].includes(i.receipt.outcome))
    return {
      state: "awaiting_decision",
      reason: "verify_infrastructure_error",
    };
  const predicate = localFailureEligibility(i.receipt, i.binding, i.profileChecks);
  if (!predicate.eligible) {
    switch (predicate.reason) {
      case "invalid_binding":
      case "binding_mismatch":
      case "invalid_receipt":
        return {
          state: "awaiting_decision",
          reason: "verify_receipt_binding_invalid",
        };
      case "invalid_profile_checks":
        return unavailable;
      case "checks_mismatch":
      case "failure_not_reproduced":
      case "outcome_ineligible":
        return missed;
    }
  }
  if (i.expected_failures.some((f) => !i.receipt.checks.some((c) => c.check_id === f.check_id && c.exit_code !== 0))) return missed;
  if (i.profileChecks.length !== 1 || i.allowed_failure_codes.length !== 1 || !i.expected_failures.length) return unavailable;
  if (
    !i.expected_failures.every((f) => f.check_id === i.profileChecks[0]!.check_id && f.failure_code === i.allowed_failure_codes[0])
  )
    return missed;
  return { state: "eligible", reason: null };
}
