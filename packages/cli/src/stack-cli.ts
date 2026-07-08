// `osstack stack` — ingest a chain of GitHub PRs into typed kanban cards with
// dependency links and a verification checklist, so the rest of the stack
// tooling (board/move/check/timeline, added in later tasks) has a substrate
// to work against.

import { KanbanRepository, openDb } from "@osstack/core";
import { ingestStack, type CommandRunner } from "@osstack/github";

export interface StackCliDeps {
  runner?: CommandRunner;
  dbPath?: string;
  now?: () => number;
  out?: (line: string) => void;
}

export const PR_CARD_CHECKLIST: readonly string[] = [
  "mergeable & clean",
  "CI green",
  "migration applied (if any)",
  "endpoint/UI smoke",
  "suite green",
];

export async function handleStackCommand(args: string[], deps?: StackCliDeps): Promise<number> {
  const sub = args[0];
  if (sub === "ingest") return await stackIngest(args.slice(1), deps);

  console.error(`osstack: unknown stack subcommand "${sub}"`);
  return 1;
}

/**
 * Parse the `--prs` comma list. Returns:
 * - `undefined` when the flag is absent or has no non-empty tokens (the caller
 *   treats this as "missing --prs").
 * - an `Error` naming the offending token when any token is non-numeric
 *   (e.g. "47abc" — `Number("47abc")` is NaN, so trailing garbage is rejected).
 * - a de-duplicated, order-preserving `number[]` otherwise.
 */
function parsePrNumbers(raw: string | undefined): number[] | undefined | Error {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;

  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = Number(part);
    if (!Number.isInteger(parsed)) {
      return new Error(part);
    }
    if (!seen.has(parsed)) {
      seen.add(parsed);
      numbers.push(parsed);
    }
  }
  return numbers;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function stackIngest(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;

  const parsed = parsePrNumbers(flag(args, "--prs"));
  if (parsed instanceof Error) {
    console.error(`osstack: --prs contains a non-numeric PR number: ${parsed.message}`);
    return 1;
  }
  if (!parsed || parsed.length === 0) {
    console.error("osstack: stack ingest requires --prs <comma-separated PR numbers>");
    return 1;
  }
  const prNumbers = parsed;

  const repoFlag = flag(args, "--repo");
  const board = flag(args, "--board") ?? "stack";

  if (!deps?.dbPath) {
    throw new Error(
      "stack-cli: handleStackCommand requires deps.dbPath (bin.ts must supply the resolved state DB path)",
    );
  }
  const dbPath = deps.dbPath;

  let model;
  try {
    model = await ingestStack(
      { prNumbers, ...(repoFlag !== undefined ? { repo: repoFlag } : {}) },
      deps?.runner,
    );
  } catch (error) {
    console.error(
      `osstack: stack ingest failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);

    const numberToNode = new Map(model.nodes.map((node) => [node.number, node]));
    const total = model.order.length;

    // Track which cards this run actually created. Re-ingest is idempotent:
    // we only seed checks / add a provenance comment for brand-new cards, and
    // only link an edge when at least one endpoint is newly created — so a
    // repeated `stack ingest` does not accumulate duplicate comments or flood
    // the event log with no-op check/linked events (which drive the notifier).
    const createdThisRun = new Set<number>();

    for (let i = 0; i < model.order.length; i++) {
      const number = model.order[i]!;
      const node = numberToNode.get(number);
      if (!node) continue;
      const cardId = `pr-${number}`;

      const isNewCard = !repo.getCard(cardId);
      if (!isNewCard) continue;
      createdThisRun.add(number);

      repo.createCard({
        card_id: cardId,
        board,
        title: `#${number} ${node.title}`,
        card_type: "pr",
        status: "ready",
        priority: total - i,
        meta: JSON.stringify({
          pr_number: number,
          base_ref: node.base,
          head_ref: node.head,
          ci_state: node.ciState,
          mergeable: node.mergeable,
          merge_state: node.mergeStateStatus,
          url: node.url,
        }),
      });

      PR_CARD_CHECKLIST.forEach((label, idx) => {
        repo.putCheck(cardId, idx, label);
      });

      repo.addComment(
        cardId,
        "osstack-stack-ingest",
        `ingested PR #${number} (${node.base} → ${node.head}), ci=${node.ciState}, mergeable=${node.mergeable}`,
      );
    }

    for (const edge of model.edges) {
      // Skip links whose BOTH endpoints already existed before this ingest —
      // re-linking them would emit redundant "linked" events every run.
      if (!createdThisRun.has(edge.parent) && !createdThisRun.has(edge.child)) {
        continue;
      }
      repo.link(`pr-${edge.parent}`, `pr-${edge.child}`);
    }

    out(`ingested ${model.order.length} PRs into board "${board}" (order: ${model.order.join(",")})`);
    return 0;
  } finally {
    db.close();
  }
}
