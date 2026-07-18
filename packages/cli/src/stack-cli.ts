// `osstack stack` — ingest a chain of GitHub PRs into typed kanban cards with
// dependency links and a verification checklist, so the rest of the stack
// tooling (board/move/check/timeline, added in later tasks) has a substrate
// to work against.

import {
  CardCheckNotFound,
  CardCycleError,
  CardNotFound,
  CardStatus,
  IllegalCardTransition,
  KanbanRepository,
  evaluateKanbanTransitionGuards,
  getBoard,
  openDb,
  readFactsForSubject,
  upsertImprovementProposal,
  writeFact,
  type KanbanTransitionGuard,
} from "@osstack/core";
import { ingestStack, type CommandRunner } from "@osstack/github";
import { renderStackRetro, type StackRetroInput } from "@osstack/loop";
import { recommendRouting, type RoutingFact } from "./stack-routing.js";
import { writeFileSync } from "node:fs";

export interface StackCliDeps {
  runner?: CommandRunner;
  dbPath?: string;
  now?: () => number;
  out?: (line: string) => void;
  workspacePath?: string;
  transitionGuards?: readonly KanbanTransitionGuard[];
}

export const PR_CARD_CHECKLIST: readonly string[] = [
  "mergeable & clean",
  "CI green",
  "migration applied (if any)",
  "endpoint/UI smoke",
  "suite green",
];

const USAGE = "osstack: usage: stack <ingest|board|move|check|timeline|runbook|recommend|retro> [...args]";

/**
 * Resolve a user-supplied card argument to a card id: a bare integer like
 * "47" is shorthand for "pr-47" (matching the ids ingest creates); anything
 * else is passed through unchanged so future non-PR card types still work.
 */
export function resolveCardId(arg: string): string {
  return /^\d+$/.test(arg) ? `pr-${arg}` : arg;
}

export async function handleStackCommand(args: string[], deps?: StackCliDeps): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "ingest":
      return await stackIngest(args.slice(1), deps);
    case "board":
      return await stackBoard(args.slice(1), deps);
    case "move":
      return await stackMove(args.slice(1), deps);
    case "check":
      return await stackCheck(args.slice(1), deps);
    case "timeline":
      return await stackTimeline(args.slice(1), deps);
    case "runbook":
      return await stackRunbook(args.slice(1), deps);
    case "recommend":
      return await stackRecommend(args.slice(1), deps);
    case "retro":
      return await stackRetro(args.slice(1), deps);
    default:
      console.error(USAGE);
      return 1;
  }
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

  let model: Awaited<ReturnType<typeof ingestStack>>;
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

function requireDbPath(deps: StackCliDeps | undefined): string {
  if (!deps?.dbPath) {
    throw new Error(
      "stack-cli: handleStackCommand requires deps.dbPath (bin.ts must supply the resolved state DB path)",
    );
  }
  return deps.dbPath;
}

async function stackBoard(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;
  const board = flag(args, "--board") ?? "stack";
  const dbPath = requireDbPath(deps);

  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);
    const view = getBoard(repo, { board, includeArchived: true });

    if (!view.changed) {
      // getBoard() only returns `changed: false` when a `since` cursor was
      // passed; we never pass one here, so this branch is unreachable in
      // practice but handled for type-safety.
      out(`[${view.board}] no changes`);
      return 0;
    }

    out(`== ${view.board} (${view.stats.total}) ==`);
    for (const column of view.columns) {
      if (column.cards.length === 0) continue;
      out(`== ${column.name.toUpperCase()} (${column.cards.length}) ==`);
      for (const card of column.cards) {
        const checks = repo.listChecks(card.card_id);
        const passCount = checks.filter((c) => c.state === "pass").length;
        out(
          `  ${card.card_id}  ${card.title}  [${passCount}/${checks.length} checks]  ${card.card_type}`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

async function stackMove(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;
  const cardArg = args[0];
  const statusArg = args[1];
  const reason = flag(args, "--reason");

  if (!cardArg || !statusArg) {
    console.error("osstack: stack move requires <cardArg> <status>");
    return 1;
  }

  const parsedStatus = CardStatus.safeParse(statusArg);
  if (!parsedStatus.success) {
    console.error(`osstack: invalid status "${statusArg}"`);
    return 1;
  }
  const status = parsedStatus.data;

  const dbPath = requireDbPath(deps);
  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);
    const cardId = resolveCardId(cardArg);
    try {
      const card = repo.getCard(cardId);
      if (card === undefined) throw new CardNotFound(cardId);
      const guardResult = await evaluateKanbanTransitionGuards(
        deps?.transitionGuards ?? [],
        {
          cardId,
          from: card.status,
          to: status,
          workspacePath: deps?.workspacePath ?? process.cwd(),
        },
      );
      if (!guardResult.allow) {
        for (const decision of guardResult.decisions.filter((entry) => !entry.allow)) {
          console.error(
            `osstack: transition denied by ${decision.guardId}: ${decision.reason}`,
          );
        }
        return 1;
      }
      const updated = repo.moveCard(cardId, status, {
        ...(reason !== undefined ? { blocked_reason: reason } : {}),
        actor: "cli",
      });
      out(`moved ${updated.card_id} -> ${status}`);
      return 0;
    } catch (error) {
      if (error instanceof CardNotFound || error instanceof IllegalCardTransition) {
        console.error(`osstack: ${error.message}`);
        return 1;
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

async function stackCheck(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;
  const cardArg = args[0];
  const idxArg = args[1];
  const detail = flag(args, "--detail");

  if (!cardArg || idxArg === undefined) {
    console.error("osstack: stack check requires <cardArg> <idx> (--pass|--fail|--pending)");
    return 1;
  }

  if (!/^\d+$/.test(idxArg)) {
    console.error(`osstack: check idx must be an integer, got "${idxArg}"`);
    return 1;
  }
  const idx = Number(idxArg);

  const flags = ["--pass", "--fail", "--pending"].filter((f) => args.includes(f));
  if (flags.length !== 1) {
    console.error("osstack: stack check requires exactly one of --pass, --fail, --pending");
    return 1;
  }
  const state = flags[0]!.slice(2) as "pass" | "fail" | "pending";

  const dbPath = requireDbPath(deps);
  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);
    const cardId = resolveCardId(cardArg);
    try {
      repo.setCheckState(cardId, idx, state, detail);
      out(`check ${cardId}#${idx} -> ${state}`);
      return 0;
    } catch (error) {
      if (error instanceof CardCheckNotFound) {
        console.error(`osstack: ${error.message}`);
        return 1;
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

async function stackTimeline(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;
  const board = flag(args, "--board");
  const cardArg = flag(args, "--card");

  const dbPath = requireDbPath(deps);
  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);
    const events = repo.eventsSince(0, {
      ...(board !== undefined ? { board } : {}),
      ...(cardArg !== undefined ? { card_id: resolveCardId(cardArg) } : {}),
    });

    for (const event of events) {
      const iso = new Date(event.created_at * 1000).toISOString();
      out(`${event.event_id}\t${iso}\t${event.card_id}\t${event.kind}\t${event.payload ?? ""}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

export interface RunbookCard {
  cardId: string;
  title: string;
  meta: {
    pr_number?: number;
    base_ref?: string;
    head_ref?: string;
    ci_state?: string;
    mergeable?: string;
  } | null;
  checks: { label: string; state: "pending" | "pass" | "fail" }[];
}

/**
 * Pure Markdown renderer for the merge runbook: a deterministic, human-readable
 * playbook listing the bottom-up merge order plus, per card, the base/head
 * context, the verification checklist as Markdown checkboxes, what retargets
 * after it merges, and a fixed rollback note.
 */
export function renderRunbook(board: string, ordered: RunbookCard[]): string {
  const lines: string[] = [];
  lines.push(`# Merge runbook — board "${board}"`);
  lines.push("");

  if (ordered.length === 0) {
    lines.push("No cards on this board.");
    return lines.join("\n");
  }

  lines.push("Bottom-up merge order");
  ordered.forEach((card, i) => {
    lines.push(`${i + 1}. ${card.cardId} — ${card.title}`);
  });
  lines.push("");

  ordered.forEach((card, i) => {
    const baseRef = card.meta?.base_ref ?? "?";
    const headRef = card.meta?.head_ref ?? "?";
    const ciState = card.meta?.ci_state ?? "?";
    const mergeable = card.meta?.mergeable ?? "?";

    lines.push(`## ${card.cardId} — ${card.title}`);
    lines.push(`base ${baseRef} ← head ${headRef}  (ci: ${ciState}, mergeable: ${mergeable})`);
    lines.push("");
    lines.push("Verify before merge:");
    for (const check of card.checks) {
      const box = check.state === "pass" ? "[x]" : check.state === "fail" ? "[!]" : "[ ]";
      lines.push(`- ${box} ${check.label}`);
    }
    lines.push("");

    const next = ordered[i + 1];
    if (next) {
      lines.push(`Retarget: ${next.cardId} auto-retargets onto this card's base after this merges.`);
    } else {
      lines.push("Retarget: none (top of stack).");
    }
    lines.push("Rollback: revert this merge commit; changes are additive/fail-safe.");
    lines.push("");
  });

  return lines.join("\n").replace(/\n+$/, "");
}

function parseRunbookMeta(raw: string | null): RunbookCard["meta"] {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunbookCard["meta"];
  } catch {
    return null;
  }
}

async function stackRunbook(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;
  const board = flag(args, "--board") ?? "stack";

  const dbPath = requireDbPath(deps);
  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);
    const cards = repo.topoOrder(board);

    const ordered: RunbookCard[] = cards.map((card) => ({
      cardId: card.card_id,
      title: card.title,
      meta: parseRunbookMeta(card.meta),
      checks: repo.listChecks(card.card_id).map((c) => ({ label: c.label, state: c.state })),
    }));

    out(renderRunbook(board, ordered));
    return 0;
  } finally {
    db.close();
  }
}

/** Guarded parse of a card's `meta` JSON blob down to the fields recommendRouting() cares about. */
function parseRoutingMeta(raw: string | null): { migration?: boolean; ui?: boolean } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { migration?: boolean; ui?: boolean };
    return parsed;
  } catch {
    return null;
  }
}

async function stackRecommend(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;
  const cardArg = args[0];
  const assign = args.includes("--assign");

  if (!cardArg) {
    console.error("osstack: stack recommend requires <cardArg>");
    return 1;
  }

  const dbPath = requireDbPath(deps);
  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);
    const cardId = resolveCardId(cardArg);
    const card = repo.getCard(cardId);
    if (!card) {
      console.error(`osstack: card not found: ${cardId}`);
      return 1;
    }

    const meta = parseRoutingMeta(card.meta);
    // memory_facts' fact_type is a fixed DB enum (preference/correction/
    // constraint/observation) — it has no "prefer_agent" value. The specific
    // "which agent do we prefer" signal is instead a "preference" fact whose
    // fact_text is exactly an agent id; remap that convention onto the
    // fine-grained fact_type recommendRouting() expects.
    //
    // Accepted S1 risk: a legitimate "preference" fact whose fact_text happens
    // to be exactly "claude-code"/"codex-cli" would be read as a routing
    // directive. Narrow (those two literals only) and accepted for S1 — this
    // command only recommends/assigns, it never auto-dispatches an agent.
    //
    // readFactsForSubject returns rows newest-first (created_at DESC), which is
    // exactly the ordering recommendRouting() expects: first valid fact wins.
    const facts: RoutingFact[] = readFactsForSubject(db, "workflow", card.card_type).map((f) => ({
      fact_type:
        f.fact_type === "preference" && (f.fact_text === "claude-code" || f.fact_text === "codex-cli")
          ? "prefer_agent"
          : f.fact_type,
      fact_text: f.fact_text,
    }));

    const hint = recommendRouting({ card_type: card.card_type, meta }, facts);

    out(`agent: ${hint.agent}`);
    out(`role: ${hint.role}`);
    out(`browserQa: ${hint.browserQa}`);
    out(`tests: ${hint.tests}`);
    out("reasons:");
    for (const reason of hint.reasons) {
      out(`  - ${reason}`);
    }

    if (assign) {
      repo.patchCard(card.card_id, { assignee: hint.agent });
      out(`assigned ${card.card_id} -> ${hint.agent}`);
    }

    return 0;
  } finally {
    db.close();
  }
}

/**
 * `osstack stack retro` — close the merge loop. Reads a board's cards + their
 * checks + their events, renders a retrospective markdown doc that cites which
 * checks caught issues, and (with --write) persists the outcome as an idempotent
 * memory fact plus, when a smoke/UI gate was missing, an improvement proposal.
 */
async function stackRetro(args: string[], deps?: StackCliDeps): Promise<number> {
  const out = deps?.out ?? console.log;
  const board = flag(args, "--board") ?? "stack";
  const write = args.includes("--write");
  const outPath = flag(args, "--out");

  const dbPath = requireDbPath(deps);
  const db = openDb({ path: dbPath });
  try {
    const repo = new KanbanRepository(db, dbPath, deps?.now);

    let cards: ReturnType<KanbanRepository["topoOrder"]>;
    try {
      cards = repo.topoOrder(board);
    } catch (error) {
      if (error instanceof CardCycleError) {
        console.error(`osstack: ${error.message}`);
        return 1;
      }
      throw error;
    }

    const input: StackRetroInput = {
      board,
      cards: cards.map((card) => {
        // reworkCount = number of times this card ENTERED the blocked lane, an
        // attempts proxy. moveCard emits kind:"blocked" specifically for a move
        // TO blocked (repository.ts:148), so count those events directly. (A
        // "moved" + payload-substring check would false-match every move, since
        // a moved event's payload always carries the literal key "blocked_reason".)
        const events = repo.eventsSince(0, { card_id: card.card_id });
        const reworkCount = events.filter((e) => e.kind === "blocked").length;
        return {
          cardId: card.card_id,
          title: card.title,
          cardType: card.card_type,
          status: card.status,
          assignee: card.assignee,
          checks: repo
            .listChecks(card.card_id)
            .map((c) => ({ label: c.label, state: c.state })),
          reworkCount,
        };
      }),
    };

    const result = renderStackRetro(input);
    out(result.markdown);

    if (outPath !== undefined) {
      try {
        writeFileSync(outPath, result.markdown, "utf-8");
      } catch (error) {
        console.error(
          `osstack: stack retro: could not write ${outPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 1;
      }
    }

    if (write) {
      // Memory fact (idempotent): skip if an active fact with the same text
      // already exists so re-running retro does not accumulate duplicates.
      const existing = readFactsForSubject(db, "workflow", "merge-orchestration");
      if (existing.some((f) => f.fact_text === result.memoryFactText)) {
        out("retro: memory fact already recorded");
      } else {
        const nowSecs = deps?.now?.() ?? Math.floor(Date.now() / 1000);
        // fact_id embeds now() only for uniqueness; it assumes now()'s
        // granularity is finer than the retro call frequency. Idempotency does
        // NOT rely on it — the text-dedupe guard above is what prevents dupes.
        writeFact(db, dbPath, {
          fact_id: `stack-retro-${board}-${nowSecs}`,
          subject_type: "workflow",
          subject_id: "merge-orchestration",
          fact_type: "observation",
          fact_text: result.memoryFactText,
          source_type: "agent_inference",
        });
        out("retro: recorded memory fact");
      }

      // Improvement proposal (optional, idempotent via upsert on proposal_id).
      if (result.missingGates.length > 0) {
        upsertImprovementProposal(db, dbPath, {
          proposal_id: `stack-retro-gate-${board}`,
          repo_id: board,
          source_asset_ids: [],
          target: "merge-orchestration",
          risk: "low",
          title: `Add earlier gates for board ${board}`,
          rationale: result.missingGates.join("; "),
          proposed_changes: [],
          required_gates: result.missingGates,
          status: "draft",
        });
        out("retro: recorded improvement proposal");
      }
    }

    return 0;
  } finally {
    db.close();
  }
}
