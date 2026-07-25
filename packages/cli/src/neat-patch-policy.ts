import { PolicyProfile } from "@osstack/core";

export type NeatPatchPolicyDecision =
  | { allow: true }
  | { allow: false; reason: string };

export function evaluateNeatPatchPolicy(
  rawProfile: unknown,
): NeatPatchPolicyDecision {
  if (rawProfile === undefined) {
    return {
      allow: false,
      reason: "policy profile is required for neat patch apply",
    };
  }
  const parsed = PolicyProfile.safeParse(rawProfile);
  if (!parsed.success) {
    return {
      allow: false,
      reason: `invalid policy profile: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }
  const profile = parsed.data;
  if (profile.mode !== "execute") {
    return {
      allow: false,
      reason: `policy mode ${profile.mode} refuses neat patch apply`,
    };
  }
  if (!profile.auto_apply) {
    return {
      allow: false,
      reason: "policy auto_apply must be true for neat patch apply",
    };
  }
  if (profile.forbidden?.includes("docs")) {
    return { allow: false, reason: "policy forbids docs changes" };
  }
  if (profile.requires_approval?.includes("docs")) {
    return {
      allow: false,
      reason: "docs changes require recorded approval; --yes is confirmation, not approval evidence",
    };
  }
  if (!profile.allowed_auto_changes?.includes("docs")) {
    return {
      allow: false,
      reason: "policy does not allow docs in allowed_auto_changes",
    };
  }
  return { allow: true };
}
