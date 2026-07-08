// Pure routing-hint logic for `osstack stack recommend` — decides which
// agent/role should pick up a kanban card, whether it needs browser QA and
// the full test suite, based only on the card's type/meta plus an optional
// memory-learned agent preference. No I/O: the CLI layer (stack-cli.ts)
// is responsible for loading the card and facts and printing the result.

export interface RoutingHint {
  agent: "claude-code" | "codex-cli";
  role: "code" | "review" | "merge-manager";
  browserQa: boolean;
  tests: "targeted" | "full";
  reasons: string[];
}

export interface RoutingFact {
  fact_type: string;
  fact_text: string;
}

const VALID_AGENTS = new Set<RoutingHint["agent"]>(["claude-code", "codex-cli"]);

export function recommendRouting(
  card: { card_type: string; meta: { migration?: boolean; ui?: boolean } | null },
  facts?: RoutingFact[],
): RoutingHint {
  const reasons: string[] = [];

  let role: RoutingHint["role"];
  if (card.card_type === "pr" || card.card_type === "merge") {
    role = "merge-manager";
    reasons.push("pr/merge card → merge-manager");
  } else if (card.card_type === "review") {
    role = "review";
  } else {
    role = "code";
  }

  const migration = card.meta?.migration === true;
  const tests: RoutingHint["tests"] = migration ? "full" : "targeted";
  reasons.push(migration ? "migration-bearing → full suite" : "no migration → targeted tests");

  const ui = card.meta?.ui === true;
  const browserQa = ui;
  if (ui) {
    reasons.push("UI card → browser QA");
  }

  let agent: RoutingHint["agent"] = "claude-code";
  let learnedAgent: RoutingHint["agent"] | undefined;
  for (const fact of facts ?? []) {
    if (fact.fact_type !== "prefer_agent") continue;
    if (!VALID_AGENTS.has(fact.fact_text as RoutingHint["agent"])) continue;
    learnedAgent = fact.fact_text as RoutingHint["agent"];
  }
  if (learnedAgent !== undefined) {
    agent = learnedAgent;
    reasons.push(`learned preference from memory: ${agent}`);
  }

  return { agent, role, browserQa, tests, reasons };
}
