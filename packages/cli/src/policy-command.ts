// `osstack policy check` — read-only validation of the workspace policy files
// (`.osstack/repo.yaml` + `.osstack/policy.yaml`). Prints mode/budgets/category
// lists or the precise fail-closed validation errors. Exit 0 = both valid (or
// both absent => legacy mode); exit 1 = any file present-but-invalid. This
// command never writes — it is the onboarding/inspection surface for the policy
// profile loader (POLICY_PROFILE_V1).

import { isAbsolute, join } from "node:path";
import {
  loadPolicyProfile,
  loadRepoConfig,
  type PolicyChangeCategory,
  type PolicyProfile,
  type RepoConfig,
} from "@osstack/core";
import { flag, hasFlag, printJson } from "./supervisor-cli-support.js";

export async function handlePolicyCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "check") return await policyCheck(rest);
  if (sub === "help" || sub === "--help" || sub === "-h" || sub === undefined) {
    printPolicyHelp();
    return 0;
  }
  console.error(`osstack: unknown policy subcommand "${sub}"`);
  return 1;
}

async function policyCheck(args: string[]): Promise<number> {
  const repoPathRaw = flag(args, "--repo-path") ?? process.cwd();
  const repoPath = isAbsolute(repoPathRaw) ? repoPathRaw : join(process.cwd(), repoPathRaw);
  const json = hasFlag(args, "--json");

  let repoConfig: RepoConfig | undefined;
  let policyProfile: PolicyProfile | undefined;
  let repoError: string | undefined;
  let policyError: string | undefined;
  try {
    repoConfig = await loadRepoConfig(repoPath);
  } catch (err) {
    repoError = errMessage(err);
  }
  try {
    policyProfile = await loadPolicyProfile(repoPath);
  } catch (err) {
    policyError = errMessage(err);
  }

  const valid = repoError === undefined && policyError === undefined;
  const legacyMode = valid && repoConfig === undefined && policyProfile === undefined;

  if (json) {
    printJson({
      repo_path: repoPath,
      valid,
      legacy_mode: legacyMode,
      repo_config: repoConfig ?? null,
      policy_profile: policyProfile ?? null,
      ...(repoError !== undefined ? { repo_error: repoError } : {}),
      ...(policyError !== undefined ? { policy_error: policyError } : {}),
    });
    return valid ? 0 : 1;
  }

  if (repoError !== undefined) console.error(`osstack: ${repoError}`);
  if (policyError !== undefined) console.error(`osstack: ${policyError}`);
  if (!valid) return 1;

  if (legacyMode) {
    console.log(`${repoPath}: no policy files (legacy mode)`);
    return 0;
  }

  if (repoConfig !== undefined) {
    console.log(
      `repo: product=${repoConfig.product} role=${repoConfig.role} default_branch=${repoConfig.default_branch}`,
    );
    console.log(`  verify_command: ${repoConfig.verify_command}`);
  } else {
    console.log("repo: (no .osstack/repo.yaml)");
  }

  if (policyProfile !== undefined) {
    console.log(`policy: mode=${policyProfile.mode} auto_apply=${policyProfile.auto_apply}`);
    console.log(`  allowed_auto_changes: ${formatCategories(policyProfile.allowed_auto_changes)}`);
    console.log(`  requires_approval: ${formatCategories(policyProfile.requires_approval)}`);
    console.log(`  forbidden: ${formatCategories(policyProfile.forbidden)}`);
    if (policyProfile.budgets !== undefined) {
      const b = policyProfile.budgets;
      console.log(
        `  budgets: max_iterations=${b.max_iterations ?? "-"} max_runtime_minutes=${b.max_runtime_minutes ?? "-"} max_cost_usd=${b.max_cost_usd ?? "-"}`,
      );
    }
  } else {
    console.log("policy: (no .osstack/policy.yaml)");
  }
  return 0;
}

function formatCategories(categories: PolicyChangeCategory[] | undefined): string {
  return categories === undefined || categories.length === 0 ? "(none)" : categories.join(", ");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printPolicyHelp(): void {
  console.log(`osstack policy — inspect the workspace policy profile (read-only)

  policy check [--repo-path P] [--json]
      Validate .osstack/repo.yaml + .osstack/policy.yaml and print
      mode/budgets/category lists, or the precise validation errors.
      Exit 0 = both valid (or both absent => legacy mode); exit 1 = any invalid.
`);
}
