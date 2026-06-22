import type { BranchCandidate, BranchStewardConfig } from "./types.js";

export function scoreBranchCandidate(
  candidate: BranchCandidate,
  config: BranchStewardConfig,
): BranchCandidate {
  let score = 50;
  const reasons: string[] = [];

  const allowedPrefix = config.branchPrefixAllowlist.some((prefix) =>
    candidate.head.startsWith(prefix),
  );
  if (allowedPrefix) {
    score += 20;
    reasons.push("branch prefix is allowlisted");
  } else {
    score -= 30;
    reasons.push("branch prefix is not allowlisted");
  }

  if (candidate.aheadBy > 0) {
    score += 10;
    reasons.push("branch is ahead of base");
  } else {
    score -= 25;
    reasons.push("branch has no unique commits");
  }

  if (candidate.behindBy <= config.maxBehindBy) {
    score += 10;
    reasons.push("branch is not far behind base");
  } else {
    score -= 20;
    reasons.push("branch is far behind base");
  }

  if (candidate.changedFiles <= config.maxChangedFiles) {
    score += 10;
    reasons.push("diff size is within limit");
  } else {
    score -= 25;
    reasons.push("diff size is too large");
  }

  if (candidate.checksState === "success") {
    score += 15;
    reasons.push("checks are passing");
  } else if (candidate.checksState === "failure") {
    score -= 35;
    reasons.push("checks are failing");
  } else if (candidate.checksState === "pending") {
    score -= 10;
    reasons.push("checks are pending");
  } else {
    score -= 5;
    reasons.push("checks are unknown");
  }

  if (candidate.hasOpenPr) {
    score -= 15;
    reasons.push("branch already has an open PR");
  }

  if (candidate.isDraft === true) {
    score -= 20;
    reasons.push("existing PR is draft");
  }

  if (candidate.sensitivePaths.length > 0) {
    score -= 40;
    reasons.push("sensitive paths changed");
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const action = decideAction(boundedScore, candidate, config);

  return {
    ...candidate,
    score: boundedScore,
    action,
    reasons,
  };
}

function decideAction(
  score: number,
  candidate: BranchCandidate,
  config: BranchStewardConfig,
): BranchCandidate["action"] {
  if (candidate.sensitivePaths.length > 0) return "escalate";
  if (candidate.checksState === "failure") return "report";
  if (candidate.hasOpenPr) return "report";
  if (
    score >= config.prThreshold &&
    score >= config.autoMergeThreshold &&
    candidate.checksState === "success"
  ) {
    return "enable_auto_merge";
  }
  if (score >= config.prThreshold) return "create_pr";
  return "report";
}
