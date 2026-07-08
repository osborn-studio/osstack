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

function parsePrNumbers(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  const numbers = parts.map((s) => Number.parseInt(s, 10));
  if (numbers.some((n) => Number.isNaN(n))) return undefined;
  return numbers;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function stackIngest(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;

  const prNumbers = parsePrNumbers(flag(args, "--prs"));
  if (!prNumbers || prNumbers.length === 0) {
    console.error("osstack: stack ingest requires --prs <comma-separated PR numbers>");
    return 1;
  }

  const repoFlag = flag(args, "--repo");
  const board = flag(args, "--board") ?? "stack";

  if (!deps?.dbPath) {
    throw new Error(
      "stack-cli: handleStackCommand requires deps.dbPath (bin.ts must supply the resolved state DB path)",
    );
  }
  const dbPath = deps.dbPath;

  const model = await ingestStack(
    { prNumbers, ...(repoFlag !== undefined ? { repo: repoFlag } : {}) },
    deps?.runner,
  );

  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);

    const numberToNode = new Map(model.nodes.map((node) => [node.number, node]));
    const total = model.order.length;

    for (let i = 0; i < model.order.length; i++) {
      const number = model.order[i]!;
      const node = numberToNode.get(number);
      if (!node) continue;
      const cardId = `pr-${number}`;

      if (!repo.getCard(cardId)) {
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
      }

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
      repo.link(`pr-${edge.parent}`, `pr-${edge.child}`);
    }

    out(`ingested ${model.order.length} PRs into board "${board}" (order: ${model.order.join(",")})`);
    return 0;
  } finally {
    db.close();
  }
}
