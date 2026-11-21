/** Pure recheck contract. This check has no admission, store, or launch authority by itself. */
import { createHash, type KeyObject } from "node:crypto";
import { checkGrantPrincipal, checkGrantWindow, type DiagnosisBinding, type DiagnosisProfile } from "./diagnosis-admission.js";
import { canonicalJson, parseStoredGrant } from "./revision-grant.js";
import {
  parseLocalFailureRevisionGrant, verifyLocalFailureRevisionGrantSignature, type LocalFailureRevisionGrant,
} from "./revision-local-failure-grant.js";

export interface RecheckGrantInput {
  grant_json: string;
  keys: ReadonlyMap<string, { public_key: KeyObject; max_validity_ms: number }>;
  principal: { principal_id: string; client_session_id: string; write_scopes: readonly string[] };
  now: number;
  budget_json: string | null;
  /** The run the host wants to start. */
  run: DiagnosisBinding & DiagnosisProfile;
  /** The chain's currently published head and base. */
  chain: { published_head: string; published_base: string };
  /** The recheck ledger row's chain and pinned head and base. */
  ledger: { chain_id: string; new_head_sha: string; base_sha: string };
  /** The profile installed on the host. */
  installed: DiagnosisProfile;
  /** The installed profile's own timeout. */
  timeout_seconds: number;
}

export type RecheckGrantVerdict =
  | { ok: true; grant: LocalFailureRevisionGrant; grant_digest: string; recheck_timeout_seconds: number }
  | { ok: false; reason: "verify_grant_missing" | "verify_grant_invalid" };

export function verifyRecheckGrant(input: RecheckGrantInput): RecheckGrantVerdict {
  const invalid = { ok: false, reason: "verify_grant_invalid" } as const;
  const missing = { ok: false, reason: "verify_grant_missing" } as const;
  try {
    const { grant_json } = input;
    let grant: LocalFailureRevisionGrant;
    try {
      grant = parseLocalFailureRevisionGrant(grant_json);
    } catch {
      parseStoredGrant(grant_json);
      return missing;
    }
    const key = input.keys.get(grant.key_id);
    if (!key || !verifyLocalFailureRevisionGrantSignature(grant, key.public_key)) return invalid;
    const { recheck } = grant.local_failure;
    if (!recheck) return missing;

    checkGrantPrincipal(grant, input.principal);
    checkGrantWindow(grant, input.now, key.max_validity_ms, input.budget_json);
    if (input.now < grant.issued_at) return invalid;
    if (!Number.isSafeInteger(input.timeout_seconds) || input.timeout_seconds < 1 || input.timeout_seconds > recheck.timeout_seconds)
      return invalid;

    const { run, chain, ledger } = input;
    for (const field of ["root_mission_id", "repository", "pr_number", "branch", "base_ref", "base_sha"] as const)
      if (run[field] !== grant[field]) return invalid;
    if (
      !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      chain.published_head !== run.head_sha || ledger.new_head_sha !== run.head_sha ||
      chain.published_base !== run.base_sha || ledger.base_sha !== run.base_sha ||
      (run.head_sha === grant.head_sha && (typeof ledger.chain_id !== "string" ||
        ledger.chain_id === "" || grant.renews?.chain_id !== ledger.chain_id))
    ) return invalid;
    for (const pin of [run, input.installed])
      if (
        pin.profile_id !== grant.local_failure.profile_id ||
        pin.profile_digest !== grant.local_failure.profile_digest ||
        canonicalJson(pin.trusted_source) !== canonicalJson(grant.local_failure.trusted_source)
      ) return invalid;
    return {
      ok: true, grant, grant_digest: createHash("sha256").update(grant_json).digest("hex"),
      recheck_timeout_seconds: recheck.timeout_seconds,
    };
  } catch {
    return invalid;
  }
}
