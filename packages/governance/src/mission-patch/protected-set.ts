import { createHash } from "node:crypto";
import { compileMissionGlob } from "./path-rules.js";

export interface MissionProtectedRule {
  id: string;
  glob: string;
}

// Initial set: operating-model §1 plus contained-mission-path §6.2. Secret-bearing
// paths mirror `packages/autonomy/src/risk.ts` (risk.secret, risk.certificate) and
// the forbidden paths of `packages/loop/src/review-boundary.ts`; re-implemented
// here because governance must not depend on either package.
export const MISSION_PROTECTED_RULES: readonly MissionProtectedRule[] = Object.freeze([
  { id: "build.package-json", glob: "**/package.json" },
  { id: "build.pnpm-lock", glob: "**/pnpm-lock.yaml" },
  { id: "build.pnpm-workspace", glob: "**/pnpm-workspace.yaml" },
  { id: "build.npmrc", glob: "**/.npmrc" },
  { id: "build.tsconfig", glob: "**/tsconfig*.json" },
  { id: "build.vitest-config", glob: "**/vitest.config.*" },
  { id: "build.tsup-config", glob: "**/tsup.config.*" },
  { id: "build.biome", glob: "**/biome.json" },
  { id: "build.biome-jsonc", glob: "**/biome.jsonc" },
  { id: "ci.github", glob: ".github/**" },
  { id: "ci.changeset-config", glob: ".changeset/config.json" },
  { id: "ci.scripts", glob: "scripts/**" },
  { id: "compat.legacy-python", glob: "legacy-python/**" },
  { id: "policy.osstack", glob: ".osstack/**" },
  { id: "state.migrations", glob: "packages/core/src/state/migrations.ts" },
  { id: "state.ddl", glob: "**/*-ddl.ts" },
  { id: "state.db", glob: "packages/core/src/state/db.ts" },
  { id: "guard.policy-gate", glob: "packages/cli/src/policy-gate.ts" },
  { id: "guard.guarded-open-db", glob: "packages/cli/src/guarded-open-db.ts" },
  { id: "guard.control-plane", glob: "packages/cli/src/control-plane-guard.ts" },
  { id: "guard.mission-patch", glob: "packages/governance/src/mission-patch/**" },
  { id: "guard.autonomy-risk", glob: "packages/autonomy/src/risk.ts" },
  { id: "guard.loop-review-boundary", glob: "packages/loop/src/review-boundary.ts" },
  { id: "guard.governance-review-boundary", glob: "packages/governance/src/review-boundary.ts" },
  { id: "verify.graph-contained", glob: "packages/cli/src/graph-contained-*" },
  { id: "verify.contained-command", glob: "packages/agents/src/contained-command.ts" },
  { id: "verify.reviewer-isolation", glob: "packages/loop/src/reviewer-isolation.ts" },
  { id: "tool.codex", glob: "**/.codex/**" },
  { id: "tool.claude", glob: "**/.claude/**" },
  { id: "tool.cursor", glob: "**/.cursor/**" },
  { id: "tool.mcp", glob: "**/.mcp.json" },
  { id: "tool.vscode", glob: "**/.vscode/**" },
  { id: "tool.idea", glob: "**/.idea/**" },
  { id: "git.file", glob: "**/.git*" },
  { id: "git.dir", glob: "**/.git*/**" },
  { id: "secret.env", glob: "**/.env" },
  { id: "secret.env-variant", glob: "**/.env.*" },
  { id: "secret.ssh", glob: "**/.ssh/**" },
  { id: "secret.aws", glob: "**/.aws/**" },
  { id: "secret.config", glob: "**/.config/**" },
  { id: "secret.dir", glob: "**/secret/**" },
  { id: "secret.dirs", glob: "**/secrets/**" },
  { id: "secret.credential", glob: "**/credential/**" },
  { id: "secret.credentials", glob: "**/credentials/**" },
  { id: "secret.cert", glob: "**/cert/**" },
  { id: "secret.certs", glob: "**/certs/**" },
  { id: "secret.key", glob: "**/*.key" },
  { id: "secret.crt", glob: "**/*.crt" },
  { id: "secret.cer", glob: "**/*.cer" },
  { id: "secret.pem", glob: "**/*.pem" },
  { id: "secret.p12", glob: "**/*.p12" },
  { id: "secret.pfx", glob: "**/*.pfx" },
].map((rule) => Object.freeze(rule)));

/** Deduplicated rules sorted by id then glob; the digest is computed over this form. */
export function canonicalMissionProtectedRules(
  rules: readonly MissionProtectedRule[] = MISSION_PROTECTED_RULES,
): MissionProtectedRule[] {
  const byKey = new Map<string, MissionProtectedRule>();
  for (const rule of rules) {
    byKey.set(`${rule.id}\u0000${rule.glob}`, { id: rule.id, glob: rule.glob });
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, rule]) => rule);
}

/** sha256 hex over the canonical JSON `[{"glob":…,"id":…},…]` of the sorted rules. */
export function missionProtectedSetDigest(
  rules: readonly MissionProtectedRule[] = MISSION_PROTECTED_RULES,
): string {
  const canonical = canonicalMissionProtectedRules(rules)
    .map((rule) => `{"glob":${JSON.stringify(rule.glob)},"id":${JSON.stringify(rule.id)}}`)
    .join(",");
  return createHash("sha256").update(`[${canonical}]`).digest("hex");
}

/** Ids of the protected rules a path hits, sorted. Matching ignores case. */
export function matchMissionProtectedPath(
  path: string,
  rules: readonly MissionProtectedRule[] = MISSION_PROTECTED_RULES,
): string[] {
  const hits = new Set<string>();
  for (const rule of rules) {
    if (compileMissionGlob(rule.glob, { caseInsensitive: true }).test(path)) hits.add(rule.id);
  }
  return [...hits].sort();
}
