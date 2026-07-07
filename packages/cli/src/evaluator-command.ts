// `osstack evaluator list|challenge|promote` — the Red Queen surface. challenge
// scores a challenger against anchor cases (advisory). promote is dry-run by
// default, requires --yes, blocks with no anchor cases, blocks a challenger
// that fails the threshold, and quarantines the displaced evaluator on success.

import { randomUUID } from "node:crypto";
import {
  createEvaluatorEpoch,
  insertScoreQuarantine,
  listAnchorCases,
  listEvaluatorVersions,
  upsertEvaluatorVersion,
} from "@osstack/core";
import { decideEvaluatorPromotion } from "@osstack/supervisor";
import { flag, hasFlag, openStateDb, printJson } from "./supervisor-cli-support.js";

interface ChallengeInput {
  repo_id: string;
  incumbent: string;
  challenger: string;
  incumbent_correct: number;
  incumbent_total: number;
  challenger_correct: number;
  challenger_total: number;
}

export async function handleEvaluatorCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "list") return await evaluatorList(rest);
  if (sub === "challenge") return await evaluatorChallenge(rest);
  if (sub === "promote") return await evaluatorPromote(rest);
  if (sub === "help" || sub === "--help" || sub === "-h" || sub === undefined) {
    console.log(`osstack evaluator — versioned evaluators and epoch promotion

  evaluator list --repo <id> [--json]
  evaluator challenge --repo <id> --incumbent A --challenger B \\
      --incumbent-correct N --incumbent-total N \\
      --challenger-correct N --challenger-total N [--json]
  evaluator promote <same flags as challenge> [--yes] [--json]   (dry-run by default)
`);
    return 0;
  }
  console.error(`osstack: unknown evaluator subcommand "${sub}"`);
  return 1;
}

async function evaluatorList(args: string[]): Promise<number> {
  const repoId = flag(args, "--repo");
  const { db } = await openStateDb();
  try {
    const versions = listEvaluatorVersions(db, {
      ...(repoId !== undefined ? { repo_id: repoId } : {}),
      limit: 200,
    });
    if (hasFlag(args, "--json")) {
      printJson({ evaluators: versions });
    } else if (versions.length === 0) {
      console.log("No evaluator versions.");
    } else {
      for (const v of versions) console.log(`${v.evaluator_id} v${v.version} [${v.kind}] ${v.status} — ${v.title}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function evaluatorChallenge(args: string[]): Promise<number> {
  const input = parseChallenge(args);
  if (input instanceof Error) {
    console.error(`osstack: ${input.message}`);
    return 1;
  }
  const decision = decideEvaluatorPromotion(toPromotionInput(input));
  if (hasFlag(args, "--json")) {
    printJson({ advisory: true, ...decision });
  } else {
    console.log(`challenge ${input.challenger} vs ${input.incumbent}: delta ${decision.anchor_accuracy_delta.toFixed(2)}`);
    console.log(`decision: ${decision.promoted ? "promotable" : "not promotable"} — ${decision.reason}`);
    console.log("(advisory only — use `evaluator promote --yes` to promote at an epoch boundary)");
  }
  return 0;
}

async function evaluatorPromote(args: string[]): Promise<number> {
  const input = parseChallenge(args);
  if (input instanceof Error) {
    console.error(`osstack: ${input.message}`);
    return 1;
  }
  const apply = hasFlag(args, "--yes");
  const json = hasFlag(args, "--json");

  const { db, dbPath } = await openStateDb();
  try {
    const anchors = listAnchorCases(db, { repo_id: input.repo_id, limit: 10_000 });
    const decision = decideEvaluatorPromotion(toPromotionInput(input));

    // Hard block: no anchor cases means no ground truth to promote against.
    if (anchors.length === 0) {
      const msg = "Cannot promote evaluator: no anchor cases. Create anchor cases from human-reviewed traces first.";
      if (json) printJson({ promoted: false, blocked: true, reason: msg });
      else console.error(msg);
      return 1;
    }

    if (!apply) {
      if (json) {
        printJson({ dry_run: true, ...decision, anchor_case_count: anchors.length });
      } else {
        console.log("DRY RUN: evaluator promotion");
        console.log(`Repo: ${input.repo_id}`);
        console.log(`Incumbent: ${input.incumbent} accuracy=${ratio(input.incumbent_correct, input.incumbent_total)}`);
        console.log(`Challenger: ${input.challenger} accuracy=${ratio(input.challenger_correct, input.challenger_total)}`);
        console.log(`Delta: ${signed(decision.anchor_accuracy_delta)}`);
        console.log(`Decision: ${decision.promoted ? "promotable" : "not promotable"} — ${decision.reason}`);
        console.log("No evaluator was promoted. Re-run with --yes to create a new epoch.");
      }
      return 0;
    }

    if (!decision.promoted) {
      if (json) printJson({ ...decision });
      else console.log(`not promoted: ${decision.reason}`);
      return 0;
    }

    // Promotion at an epoch boundary: freeze the challenger, open+close the
    // epoch with the decision, and quarantine the displaced incumbent's scores.
    upsertEvaluatorVersion(db, dbPath, {
      evaluator_id: input.challenger,
      repo_id: input.repo_id,
      kind: "llm_judge",
      version: "promoted",
      title: `promoted challenger ${input.challenger}`,
      rubric: "promoted at epoch boundary",
      status: "frozen",
    });
    upsertEvaluatorVersion(db, dbPath, {
      evaluator_id: input.incumbent,
      repo_id: input.repo_id,
      kind: "llm_judge",
      version: "retired",
      title: `retired incumbent ${input.incumbent}`,
      rubric: "displaced at epoch boundary",
      status: "retired",
    });
    const epoch = createEvaluatorEpoch(db, dbPath, {
      epoch_id: `epoch_${sanitize(input.repo_id)}_${randomUUID().slice(0, 8)}`,
      repo_id: input.repo_id,
      frozen_evaluator_id: input.challenger,
      anchor_case_ids: anchors.map((a) => a.case_id),
      challenger_evaluator_ids: [input.challenger],
    });
    insertScoreQuarantine(db, dbPath, {
      quarantine_id: `q_${sanitize(input.repo_id)}_${randomUUID().slice(0, 8)}`,
      repo_id: input.repo_id,
      score_id: `all:${input.incumbent}`,
      evaluator_id: input.incumbent,
      reason: `evaluator ${input.incumbent} displaced by promotion of ${input.challenger}`,
    });

    if (json) printJson({ epoch_id: epoch.epoch_id, promoted_evaluator_id: input.challenger, ...decision });
    else console.log(`promoted ${input.challenger} (epoch ${epoch.epoch_id}); quarantined scores from ${input.incumbent}`);
    return 0;
  } finally {
    db.close();
  }
}

function parseChallenge(args: string[]): ChallengeInput | Error {
  const repo = flag(args, "--repo");
  const incumbent = flag(args, "--incumbent");
  const challenger = flag(args, "--challenger");
  if (repo === undefined || incumbent === undefined || challenger === undefined) {
    return new Error("requires --repo, --incumbent, and --challenger");
  }
  const nums = {
    incumbent_correct: numFlag(args, "--incumbent-correct"),
    incumbent_total: numFlag(args, "--incumbent-total"),
    challenger_correct: numFlag(args, "--challenger-correct"),
    challenger_total: numFlag(args, "--challenger-total"),
  };
  for (const [name, value] of Object.entries(nums)) {
    if (value === undefined) return new Error(`requires numeric --${name.replace(/_/g, "-")}`);
  }
  return {
    repo_id: repo,
    incumbent,
    challenger,
    incumbent_correct: nums.incumbent_correct!,
    incumbent_total: nums.incumbent_total!,
    challenger_correct: nums.challenger_correct!,
    challenger_total: nums.challenger_total!,
  };
}

function toPromotionInput(input: ChallengeInput) {
  return {
    incumbent_evaluator_id: input.incumbent,
    challenger_evaluator_id: input.challenger,
    incumbent_correct: input.incumbent_correct,
    incumbent_total: input.incumbent_total,
    challenger_correct: input.challenger_correct,
    challenger_total: input.challenger_total,
  };
}

function numFlag(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function ratio(correct: number, total: number): string {
  return (total <= 0 ? 0 : correct / total).toFixed(2);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
