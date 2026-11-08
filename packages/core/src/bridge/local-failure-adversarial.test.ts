import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { parseLocalFailureBinding } from "./local-failure.js";
import { samplePreview } from "./revision-grant-fixtures.js";
import { signLocalFailureRevisionGrant } from "./revision-local-failure-grant.js";

const optIn = (profileId: string) => ({
  ...samplePreview(), version: 2 as const,
  local_failure: {
    enabled: true as const, profile_id: profileId, profile_digest: "a".repeat(64),
    trusted_source: { repository: "o/trusted", commit: "b".repeat(40), artifact_digest: "c".repeat(64) },
    diagnostic_timeout_seconds: 60, max_diagnostics_per_head: 1 as const,
  },
});

it("refuses signing a profile identity that the receipt binding cannot represent", () => {
  const keys = generateKeyPairSync("ed25519");
  // The installed-profile loader also excludes spaces from profile IDs.
  expect(() => signLocalFailureRevisionGrant(optIn("bridge profile"), keys.privateKey)).toThrow("grant_invalid");
});

it("preserves a supported signed profile identity through the actual receipt binding parser", () => {
  const keys = generateKeyPairSync("ed25519");
  const grant = signLocalFailureRevisionGrant(optIn("bridge-profile"), keys.privateKey);
  expect(parseLocalFailureBinding({
    intake_id: "lfi_00000000-0000-4000-8000-000000000001", chain_id: "rc_fixture",
    root_mission_id: grant.root_mission_id, grant_id: grant.grant_id,
    repository: grant.repository, pr: grant.pr_number, branch: grant.branch, head: grant.head_sha,
    tree: "d".repeat(40), base_ref: grant.base_ref, base_sha: grant.base_sha,
    profile_id: grant.local_failure.profile_id, profile_digest: grant.local_failure.profile_digest,
    trusted_source_digest: grant.local_failure.trusted_source.artifact_digest, invocation_id: "fixture-diagnostic",
  }).profile_id).toBe("bridge-profile");
});
