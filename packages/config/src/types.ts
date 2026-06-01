// Osstack agent-configuration schema (Zod). Single source of truth for "which
// agent plays which role on this machine, and what to fall back to if it isn't
// installed".
//
// Three roles, mapped onto the capability kinds the orchestrator already knows:
//   coding      → code.write / code.refactor / code.debug
//   test-verify → code.test / code.review / release.verify / release.check
//   design      → design.prd / design.architecture / design.review

import { z } from "zod";
import type { CapabilityKind } from "@osstack/core";

export const AgentRole = z.enum(["coding", "test-verify", "design"]);
export type AgentRole = z.infer<typeof AgentRole>;

/** A role's preferred agent plus an ordered fallback list. */
export const RoleBinding = z.object({
  primary: z.string(),
  fallback: z.array(z.string()).default([]),
});
export type RoleBinding = z.infer<typeof RoleBinding>;

export const RoleMap = z.object({
  coding: RoleBinding,
  "test-verify": RoleBinding,
  design: RoleBinding,
});
export type RoleMap = z.infer<typeof RoleMap>;

/** A per-machine profile: which hostnames it matches + its role bindings. */
export const Profile = z.object({
  match: z.object({ hostnames: z.array(z.string()).default([]) }).default({ hostnames: [] }),
  roles: RoleMap,
});
export type Profile = z.infer<typeof Profile>;

export const OsstackConfig = z.object({
  version: z.literal(1).default(1),
  /** "auto" = pick by hostname; otherwise a profile name to force. */
  active_profile: z.string().default("auto"),
  profiles: z.record(z.string(), Profile).default({}),
  /** Used when no profile matches (or a pinned profile is missing). */
  defaults: z.object({ roles: RoleMap }),
});
export type OsstackConfig = z.infer<typeof OsstackConfig>;

/** Capability kinds each role is allowed to be served by. */
export const ROLE_KINDS: Record<AgentRole, readonly CapabilityKind[]> = {
  coding: ["code.write", "code.refactor", "code.debug"],
  "test-verify": ["code.test", "code.review", "release.verify", "release.check"],
  design: ["design.prd", "design.architecture", "design.review"],
};

export const ALL_ROLES: readonly AgentRole[] = ["coding", "test-verify", "design"];
