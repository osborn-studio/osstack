export type AgentAuthMode =
  | "subprocess/login-reuse"
  | "sdk/api-key"
  | "connector/api-key"
  | "local";

export function rolesForCapabilityKinds(kinds: readonly string[]): string[] {
  const roles: string[] = [];
  const has = (prefixOrKind: string) => kinds.some((kind) => kind === prefixOrKind || kind.startsWith(`${prefixOrKind}.`));
  if (kinds.some((kind) => ["code.write", "code.refactor", "code.debug"].includes(kind))) roles.push("coding");
  if (kinds.some((kind) => ["code.test", "verify.alignment", "verify.acceptance", "release.verify", "release.check"].includes(kind))) roles.push("test-verify");
  if (kinds.some((kind) => ["code.review", "review.code", "design.review"].includes(kind))) roles.push("reviewer");
  if (has("design")) roles.push("designer");
  if (kinds.some((kind) => ["design.prd", "design.architecture", "research.ml"].includes(kind))) roles.push("product/planning");
  if (kinds.some((kind) => ["release.verify", "release.check", "code.review", "review.code"].includes(kind))) roles.push("release/proof");
  return roles;
}

export function agentAuthMode(agentId: string): AgentAuthMode {
  if (
    agentId === "claude-cli"
    || agentId === "codex-cli"
    || agentId === "opencode-cli"
    || agentId === "kimi-code"
  ) {
    return "subprocess/login-reuse";
  }
  if (agentId === "claude-code" || agentId === "claude-design") return "sdk/api-key";
  if (agentId === "google-stitch") return "connector/api-key";
  return "local";
}
