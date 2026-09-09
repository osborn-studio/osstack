import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDb,
  KanbanRepository,
  writeFact,
  readFactsForSubject,
  listImprovementProposals,
  upsertImprovementProposal,
} from "@osstack/core";
import type { CommandRunner } from "@osstack/github";
import {
  handleStackCommand,
  PR_CARD_CHECKLIST,
  renderRunbook,
  type RunbookCard,
} from "./stack-cli.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function prViewJson(pr: {
  number: number;
  baseRefName: string;
  headRefName: string;
  title?: string;
}): string {
  return JSON.stringify({
    number: pr.number,
    state: "OPEN",
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    title: pr.title ?? `PR #${pr.number}`,
    url: `https://github.com/o/r/pull/${pr.number}`,
  });
}

function makeRunner(): CommandRunner {
  return {
    run: async (command, args) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.includes("pr view 47")) {
        return prViewJson({ number: 47, baseRefName: "main", headRefName: "feat/a" });
      }
      if (joined.includes("pr view 48")) {
        return prViewJson({ number: 48, baseRefName: "feat/a", headRefName: "feat/b" });
      }
      if (joined.includes("pr view 49")) {
        return prViewJson({ number: 49, baseRefName: "feat/b", headRefName: "feat/c" });
      }
      throw new Error(`unexpected command: ${joined}`);
    },
  };
}

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "osstack-stack-cli-"));
  const dbPath = join(dir, "state.db");
  tmpDirs.push(dirname(dbPath));
  return dbPath;
}

describe("handleStackCommand: ingest", () => {
  it("ingests a 3-PR linear chain into typed cards, links, checks, and events", async () => {
    const dbPath = makeTempDbPath();
    const runner = makeRunner();
    const out: string[] = [];

    const exitCode = await handleStackCommand(
      ["ingest", "--prs", "47,48,49", "--board", "stack"],
      { runner, dbPath, out: (line) => out.push(line) },
    );

    expect(exitCode).toBe(0);
    expect(out.join("\n")).toContain("ingested 3 PRs");
    expect(out.join("\n")).toContain('board "stack"');

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);

      const card47 = repo.getCard("pr-47");
      const card48 = repo.getCard("pr-48");
      const card49 = repo.getCard("pr-49");
      expect(card47).toBeDefined();
      expect(card48).toBeDefined();
      expect(card49).toBeDefined();

      for (const card of [card47, card48, card49]) {
        expect(card!.card_type).toBe("pr");
      }

      expect(card47!.title.startsWith("#47")).toBe(true);
      expect(card48!.title.startsWith("#48")).toBe(true);
      expect(card49!.title.startsWith("#49")).toBe(true);

      const meta47 = JSON.parse(card47!.meta ?? "{}");
      expect(meta47.pr_number).toBe(47);
      expect(meta47.base_ref).toBe("main");
      expect(meta47.head_ref).toBe("feat/a");

      const meta48 = JSON.parse(card48!.meta ?? "{}");
      expect(meta48.pr_number).toBe(48);
      expect(meta48.base_ref).toBe("feat/a");
      expect(meta48.head_ref).toBe("feat/b");

      const links = repo.linksForBoard("stack");
      expect(links).toEqual(
        expect.arrayContaining([
          { parent_id: "pr-47", child_id: "pr-48" },
          { parent_id: "pr-48", child_id: "pr-49" },
        ]),
      );
      expect(links).toHaveLength(2);

      for (const cardId of ["pr-47", "pr-48", "pr-49"]) {
        const checks = repo.listChecks(cardId);
        expect(checks).toHaveLength(PR_CARD_CHECKLIST.length);
        for (const check of checks) {
          expect(check.state).toBe("pending");
        }
      }

      const events = repo.eventsSince(0, { board: "stack" });
      const kinds = new Set(events.map((e) => e.kind));
      expect(kinds.has("created")).toBe(true);
      expect(kinds.has("linked")).toBe(true);
      expect(kinds.has("check")).toBe(true);
      expect(kinds.has("commented")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("errors and returns 1 when --prs is missing", async () => {
    const dbPath = makeTempDbPath();
    const errors: string[] = [];

    const exitCode = await handleStackCommand(["ingest"], {
      dbPath,
      out: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
  });

  it("errors and returns 1 when --prs is empty", async () => {
    const dbPath = makeTempDbPath();

    const exitCode = await handleStackCommand(["ingest", "--prs", ""], { dbPath });

    expect(exitCode).toBe(1);
  });

  it("is idempotent across repeated ingests (no duplicate-card crash)", async () => {
    const dbPath = makeTempDbPath();
    const runner = makeRunner();

    const first = await handleStackCommand(["ingest", "--prs", "47,48,49", "--board", "stack"], {
      runner,
      dbPath,
    });
    expect(first).toBe(0);

    const second = await handleStackCommand(["ingest", "--prs", "47,48,49", "--board", "stack"], {
      runner,
      dbPath,
    });
    expect(second).toBe(0);

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      const cards = repo.listCards({ board: "stack" });
      expect(cards).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("passes --repo through to ingestStack when provided", async () => {
    const dbPath = makeTempDbPath();
    let sawRepoFlag = false;
    const runner: CommandRunner = {
      run: async (_command, args) => {
        if (args.includes("--repo") && args.includes("o/r")) sawRepoFlag = true;
        return prViewJson({ number: 1, baseRefName: "main", headRefName: "feat/x" });
      },
    };

    const exitCode = await handleStackCommand(
      ["ingest", "--prs", "1", "--repo", "o/r"],
      { runner, dbPath },
    );

    expect(exitCode).toBe(0);
    expect(sawRepoFlag).toBe(true);
  });

  it("re-ingest is idempotent: comments stay at 1/card and no-op events do not grow", async () => {
    const dbPath = makeTempDbPath();
    const runner = makeRunner();

    const first = await handleStackCommand(["ingest", "--prs", "47,48,49", "--board", "stack"], {
      runner,
      dbPath,
    });
    expect(first).toBe(0);

    const countByKind = (): Record<string, number> => {
      const db = openDb({ path: dbPath });
      try {
        const repo = new KanbanRepository(db, dbPath);
        const events = repo.eventsSince(0, { board: "stack" });
        const counts: Record<string, number> = {};
        for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
        return counts;
      } finally {
        db.close();
      }
    };

    const afterFirst = countByKind();

    // Second ingest of the SAME chain must be a no-op for comments/checks/links.
    const second = await handleStackCommand(["ingest", "--prs", "47,48,49", "--board", "stack"], {
      runner,
      dbPath,
    });
    expect(second).toBe(0);

    const afterSecond = countByKind();

    // Provenance comment count stays at exactly 1 per card.
    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      for (const cardId of ["pr-47", "pr-48", "pr-49"]) {
        expect(repo.listComments(cardId)).toHaveLength(1);
      }
    } finally {
      db.close();
    }

    // The event log did not grow on the second run for these kinds.
    expect(afterSecond.commented).toBe(afterFirst.commented);
    expect(afterSecond.linked).toBe(afterFirst.linked);
    expect(afterSecond.check).toBe(afterFirst.check);
    expect(afterSecond.created).toBe(afterFirst.created);
  });

  it("returns 1 (not a thrown rejection) when ingestStack fails", async () => {
    const dbPath = makeTempDbPath();
    const errors: string[] = [];
    const runner: CommandRunner = {
      run: async () => {
        throw new Error("gh exploded");
      },
    };

    const exitCode = await handleStackCommand(["ingest", "--prs", "47"], {
      runner,
      dbPath,
      out: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
  });

  it("returns 1 with a non-numeric message when --prs has a garbage token", async () => {
    const dbPath = makeTempDbPath();
    const runner = makeRunner();

    const exitCode = await handleStackCommand(["ingest", "--prs", "47,48,x"], {
      runner,
      dbPath,
    });

    expect(exitCode).toBe(1);
  });

  it("rejects trailing garbage like '47abc' rather than silently truncating to 47", async () => {
    const dbPath = makeTempDbPath();
    let ranGh = false;
    const runner: CommandRunner = {
      run: async () => {
        ranGh = true;
        return prViewJson({ number: 47, baseRefName: "main", headRefName: "feat/a" });
      },
    };

    const exitCode = await handleStackCommand(["ingest", "--prs", "47abc"], {
      runner,
      dbPath,
    });

    expect(exitCode).toBe(1);
    expect(ranGh).toBe(false);
  });

  it("dedups repeated PR numbers in --prs (47,47,48 -> two cards)", async () => {
    const dbPath = makeTempDbPath();
    const runner = makeRunner();

    const exitCode = await handleStackCommand(["ingest", "--prs", "47,47,48", "--board", "stack"], {
      runner,
      dbPath,
    });
    expect(exitCode).toBe(0);

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      const cards = repo.listCards({ board: "stack" });
      expect(cards).toHaveLength(2);
      expect(repo.getCard("pr-47")).toBeDefined();
      expect(repo.getCard("pr-48")).toBeDefined();
    } finally {
      db.close();
    }
  });
});

async function ingestThreePrBoard(dbPath: string): Promise<void> {
  const exitCode = await handleStackCommand(["ingest", "--prs", "47,48,49", "--board", "stack"], {
    runner: makeRunner(),
    dbPath,
  });
  expect(exitCode).toBe(0);
}

describe("handleStackCommand: board", () => {
  it("prints lane headers, card ids, and a [0/N checks] marker", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);
    const out: string[] = [];

    const exitCode = await handleStackCommand(["board", "--board", "stack"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("pr-47");
    expect(text).toContain("pr-48");
    expect(text).toContain("pr-49");
    expect(text).toMatch(/==\s*READY/i);
    expect(text).toContain(`[0/${PR_CARD_CHECKLIST.length} checks]`);
  });

  it("reflects a passed check as [1/N checks] for that card", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      repo.setCheckState("pr-47", 0, "pass");
    } finally {
      db.close();
    }

    const out: string[] = [];
    const exitCode = await handleStackCommand(["board", "--board", "stack"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const lines = out.join("\n").split("\n");
    const line47 = lines.find((l) => l.includes("pr-47"));
    expect(line47).toBeDefined();
    expect(line47).toContain(`[1/${PR_CARD_CHECKLIST.length} checks]`);
  });
});

describe("handleStackCommand: move", () => {
  it("moves a card to a new status and prints a confirmation", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);
    const out: string[] = [];

    const exitCode = await handleStackCommand(["move", "48", "running"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    expect(out.join("\n")).toContain("moved pr-48 -> running");

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      expect(repo.getCard("pr-48")!.status).toBe("running");
    } finally {
      db.close();
    }
  });

  it("returns 1 when moving a nonexistent card", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const exitCode = await handleStackCommand(["move", "999", "running"], { dbPath });

    expect(exitCode).toBe(1);
  });

  it("returns 1 for an invalid status string", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const exitCode = await handleStackCommand(["move", "48", "not-a-status"], { dbPath });

    expect(exitCode).toBe(1);
  });

  it("evaluates every transition guard and emits no move event when one denies", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);
    const evaluated: string[] = [];
    const before = openDb({ path: dbPath });
    const beforeEvents = new KanbanRepository(before, dbPath)
      .eventsSince(0, { card_id: "pr-48" }).length;
    before.close();

    const exitCode = await handleStackCommand(["move", "48", "running"], {
      dbPath,
      workspacePath: "/workspace",
      transitionGuards: [
        {
          id: "probe-readiness",
          evaluate: async (input) => {
            evaluated.push(`probe:${input.cardId}:${input.from}:${input.to}`);
            return { allow: false, reason: "readiness denied", evidenceRefs: ["ledger.json"] };
          },
        },
        {
          id: "audit",
          evaluate: async () => {
            evaluated.push("audit");
            return { allow: true, reason: "recorded", evidenceRefs: [] };
          },
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(evaluated.sort()).toEqual(["audit", "probe:pr-48:ready:running"]);
    const after = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(after, dbPath);
      expect(repo.getCard("pr-48")!.status).toBe("ready");
      expect(repo.eventsSince(0, { card_id: "pr-48" })).toHaveLength(beforeEvents);
    } finally {
      after.close();
    }
  });
});

describe("handleStackCommand: check", () => {
  it("sets a check to pass and emits a check event", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);
    const out: string[] = [];

    const exitCode = await handleStackCommand(["check", "47", "0", "--pass"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    expect(out.join("\n")).toContain("check pr-47#0 -> pass");

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      const checks = repo.listChecks("pr-47");
      expect(checks[0]!.state).toBe("pass");

      const events = repo.eventsSince(0, { board: "stack", card_id: "pr-47" });
      expect(events.some((e) => e.kind === "check")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("returns 1 when the check idx does not exist", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const exitCode = await handleStackCommand(["check", "47", "99", "--pass"], { dbPath });

    expect(exitCode).toBe(1);
  });
});

describe("handleStackCommand: timeline", () => {
  it("lists events in ascending order including created, moved, check kinds", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);
    await handleStackCommand(["move", "48", "running"], { dbPath });
    await handleStackCommand(["check", "47", "0", "--pass"], { dbPath });

    const out: string[] = [];
    const exitCode = await handleStackCommand(["timeline", "--board", "stack"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const lines = out.join("\n").split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const eventIds = lines.map((l) => Number(l.split("\t")[0]));
    const sorted = [...eventIds].sort((a, b) => a - b);
    expect(eventIds).toEqual(sorted);

    const text = out.join("\n");
    expect(text).toContain("created");
    expect(text).toContain("moved");
    expect(text).toContain("check");
  });

  it("filters to a single card with --card", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);
    await handleStackCommand(["move", "48", "running"], { dbPath });

    const out: string[] = [];
    const exitCode = await handleStackCommand(["timeline", "--card", "47"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const lines = out.join("\n").split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain("pr-47");
    }
  });
});

describe("handleStackCommand: unknown subcommand", () => {
  it("returns 1 with a usage message for an unknown subcommand", async () => {
    const dbPath = makeTempDbPath();

    const exitCode = await handleStackCommand(["bogus"], { dbPath });

    expect(exitCode).toBe(1);
  });
});

describe("handleStackCommand: retro", () => {
  it.each(["approved", "rejected", "applied", "needs_human"] as const)("preserves a %s proposal when a later retro suggests different gates", async (status) => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);
    const smokeIdx = PR_CARD_CHECKLIST.indexOf("endpoint/UI smoke");
    const firstDb = openDb({ path: dbPath });
    new KanbanRepository(firstDb, dbPath).setCheckState("pr-47", smokeIdx, "fail");
    firstDb.close();

    const out: string[] = [];
    let now = 1000;
    const run = () => handleStackCommand(["retro", "--board", "stack", "--write"], {
      dbPath, now: () => now, out: (line) => out.push(line),
    });
    expect(await run()).toBe(0);
    const reviewDb = openDb({ path: dbPath });
    const reviewed = upsertImprovementProposal(reviewDb, dbPath, {
      ...listImprovementProposals(reviewDb, { repo_id: "stack" })[0]!, status,
    });
    const repo = new KanbanRepository(reviewDb, dbPath);
    repo.setCheckState("pr-47", smokeIdx, "pass");
    repo.setCheckState("pr-48", smokeIdx, "fail");
    reviewDb.close();

    now = 1001;
    out.length = 0;
    expect(await run()).toBe(0);
    expect(out.join("\n")).toContain(`preserved improvement proposal ${reviewed.proposal_id} (${status})`);
    expect(out.join("\n")).toContain("new gate suggestions were not persisted");
    expect(out.join("\n")).not.toContain("retro: recorded improvement proposal");
    expect(await run()).toBe(0);
    const replayDb = openDb({ path: dbPath });
    try {
      expect(listImprovementProposals(replayDb, { repo_id: "stack" })).toEqual([reviewed]);
      expect(readFactsForSubject(replayDb, "workflow", "merge-orchestration")).toHaveLength(2);
    } finally {
      replayDb.close();
    }
  });

  it("counts reworkCount from REAL blocked-transition events (2× blocked shows 2×; never-blocked shows none)", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    // Drive pr-48 into the blocked lane exactly twice via legal transitions:
    // ready → running → blocked → running → blocked. pr-47 is never blocked.
    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      repo.moveCard("pr-48", "running", { actor: "cli" });
      repo.moveCard("pr-48", "blocked", { actor: "cli" });
      repo.moveCard("pr-48", "running", { actor: "cli" });
      repo.moveCard("pr-48", "blocked", { actor: "cli" });
      // pr-47 just runs — it enters blocked zero times (guards against the
      // old bug where every "moved" event false-matched on "blocked_reason").
      repo.moveCard("pr-47", "running", { actor: "cli" });
    } finally {
      db.close();
    }

    const out: string[] = [];
    const exitCode = await handleStackCommand(["retro", "--board", "stack"], {
      dbPath,
      now: () => 1000,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("## Rework");
    expect(text).toContain("- pr-48 reworked 2×");
    // pr-47 (and pr-49) never entered blocked, so they must NOT appear in Rework.
    expect(text).not.toContain("- pr-47 reworked");
    expect(text).not.toContain("- pr-49 reworked");
  });

  it("prints a retro for a seeded board", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const out: string[] = [];
    const exitCode = await handleStackCommand(["retro", "--board", "stack"], {
      dbPath,
      now: () => 1000,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("# Merge retrospective");
    expect(text).toContain('board "stack"');
    expect(text).toContain("pr-47");
  });

  it("persists an idempotent memory fact under --write", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const run = () =>
      handleStackCommand(["retro", "--board", "stack", "--write"], {
        dbPath,
        now: () => 1000,
        out: () => {},
      });

    expect(await run()).toBe(0);
    expect(await run()).toBe(0);

    const db = openDb({ path: dbPath });
    try {
      const facts = readFactsForSubject(db, "workflow", "merge-orchestration");
      expect(facts).toHaveLength(1);
      expect(facts[0]!.fact_text.startsWith("retro(")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("records an improvement proposal under --write when a gate was missing", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    // Fail the "endpoint/UI smoke" check on a card so a smoke/UI gate is proposed.
    const smokeIdx = PR_CARD_CHECKLIST.indexOf("endpoint/UI smoke");
    const db0 = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db0, dbPath);
      repo.setCheckState("pr-47", smokeIdx, "fail");
    } finally {
      db0.close();
    }

    const run = () =>
      handleStackCommand(["retro", "--board", "stack", "--write"], {
        dbPath,
        now: () => 1000,
        out: () => {},
      });

    expect(await run()).toBe(0);

    const db = openDb({ path: dbPath });
    try {
      const proposals = listImprovementProposals(db, { repo_id: "stack" });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.proposal_id).toBe("stack-retro-gate-stack");
    } finally {
      db.close();
    }

    // Second --write run keeps it at one (upsert keyed on proposal_id).
    expect(await run()).toBe(0);
    const db2 = openDb({ path: dbPath });
    try {
      const proposals = listImprovementProposals(db2, { repo_id: "stack" });
      expect(proposals).toHaveLength(1);
    } finally {
      db2.close();
    }
  });
});

describe("renderRunbook (pure)", () => {
  function makeOrdered(): RunbookCard[] {
    return [
      {
        cardId: "pr-47",
        title: "#47 Add base layer",
        meta: { pr_number: 47, base_ref: "main", head_ref: "feat/a", ci_state: "SUCCESS", mergeable: "MERGEABLE" },
        checks: [
          { label: "mergeable & clean", state: "pass" },
          { label: "CI green", state: "pending" },
        ],
      },
      {
        cardId: "pr-48",
        title: "#48 Add middle layer",
        meta: { pr_number: 48, base_ref: "feat/a", head_ref: "feat/b", ci_state: "PENDING", mergeable: "MERGEABLE" },
        checks: [
          { label: "mergeable & clean", state: "fail" },
        ],
      },
      {
        cardId: "pr-49",
        title: "#49 Add top layer",
        meta: null,
        checks: [
          { label: "suite green", state: "pending" },
        ],
      },
    ];
  }

  it("includes the bottom-up merge order list in the given order", () => {
    const md = renderRunbook("stack", makeOrdered());
    expect(md).toContain('# Merge runbook — board "stack"');
    expect(md).toContain("Bottom-up merge order");

    const idx47 = md.indexOf("1. pr-47 — #47 Add base layer");
    const idx48 = md.indexOf("2. pr-48 — #48 Add middle layer");
    const idx49 = md.indexOf("3. pr-49 — #49 Add top layer");
    expect(idx47).toBeGreaterThanOrEqual(0);
    expect(idx48).toBeGreaterThan(idx47);
    expect(idx49).toBeGreaterThan(idx48);
  });

  it("renders a section per card with base<-head context and mixed checkbox states", () => {
    const md = renderRunbook("stack", makeOrdered());

    expect(md).toContain("## pr-47 — #47 Add base layer");
    expect(md).toContain("base main ← head feat/a  (ci: SUCCESS, mergeable: MERGEABLE)");
    expect(md).toContain("Verify before merge:");
    expect(md).toContain("- [x] mergeable & clean");
    expect(md).toContain("- [ ] CI green");

    expect(md).toContain("## pr-48 — #48 Add middle layer");
    expect(md).toContain("- [!] mergeable & clean");
  });

  it("uses ? for missing meta fields (null meta)", () => {
    const md = renderRunbook("stack", makeOrdered());
    expect(md).toContain("base ? ← head ?  (ci: ?, mergeable: ?)");
  });

  it("names the next card in the Retarget line, and 'none (top of stack)' for the last card", () => {
    const md = renderRunbook("stack", makeOrdered());

    const section47Start = md.indexOf("## pr-47");
    const section48Start = md.indexOf("## pr-48");
    const section49Start = md.indexOf("## pr-49");

    const section47 = md.slice(section47Start, section48Start);
    const section48 = md.slice(section48Start, section49Start);
    const section49 = md.slice(section49Start);

    expect(section47).toMatch(/Retarget:.*pr-48/);
    expect(section48).toMatch(/Retarget:.*pr-49/);
    expect(section49).toContain("Retarget: none (top of stack).");
  });

  it("includes the fixed Rollback note for every card", () => {
    const md = renderRunbook("stack", makeOrdered());
    const rollbackCount = md.split("Rollback: revert this merge commit; changes are additive/fail-safe.").length - 1;
    expect(rollbackCount).toBe(3);
  });

  it("returns the title plus a 'No cards on this board.' line for an empty ordered list", () => {
    const md = renderRunbook("stack", []);
    expect(md).toContain('# Merge runbook — board "stack"');
    expect(md).toContain("No cards on this board.");
  });
});

describe("handleStackCommand: runbook", () => {
  it("returns 0 and prints the 3 PRs in bottom-up order with a [x] for the passed check", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      repo.setCheckState("pr-47", 0, "pass");
    } finally {
      db.close();
    }

    const out: string[] = [];
    const exitCode = await handleStackCommand(["runbook", "--board", "stack"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const text = out.join("\n");

    const idx47 = text.indexOf("pr-47");
    const idx48 = text.indexOf("pr-48");
    const idx49 = text.indexOf("pr-49");
    expect(idx47).toBeGreaterThanOrEqual(0);
    expect(idx48).toBeGreaterThan(idx47);
    expect(idx49).toBeGreaterThan(idx48);

    expect(text).toContain("- [x] " + PR_CARD_CHECKLIST[0]);
  });
});

describe("handleStackCommand: recommend", () => {
  it("returns 0 and prints role: merge-manager and agent: claude-code for a pr card with no learned preference", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const out: string[] = [];
    const exitCode = await handleStackCommand(["recommend", "47"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("role: merge-manager");
    expect(text).toContain("agent: claude-code");
  });

  it("uses a learned prefer_agent fact for the card's subject (card_type) to recommend codex-cli", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const db = openDb({ path: dbPath });
    try {
      writeFact(db, dbPath, {
        fact_id: "fact-prefer-agent-1",
        subject_type: "workflow",
        subject_id: "pr",
        fact_type: "preference",
        fact_text: "codex-cli",
        source_type: "user_confirmation",
      });
    } finally {
      db.close();
    }

    const out: string[] = [];
    const exitCode = await handleStackCommand(["recommend", "47"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("agent: codex-cli");
    expect(text).toContain("learned preference from memory: codex-cli");
  });

  it("returns 1 for a missing card", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const exitCode = await handleStackCommand(["recommend", "999"], { dbPath });
    expect(exitCode).toBe(1);
  });

  it("with --assign, persists the recommended agent as the card's assignee", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const out: string[] = [];
    const exitCode = await handleStackCommand(["recommend", "47", "--assign"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    expect(out.join("\n")).toContain("assigned pr-47 -> claude-code");

    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      const card = repo.getCard("pr-47");
      expect(card?.assignee).toBe("claude-code");
    } finally {
      db.close();
    }
  });

  it("honors the NEWEST preference when two conflicting facts exist (newest-wins, end-to-end)", async () => {
    const dbPath = makeTempDbPath();
    await ingestThreePrBoard(dbPath);

    const db = openDb({ path: dbPath });
    try {
      // Write the OLDER preference first, then the NEWER one. writeFact stamps
      // created_at itself at second-resolution, so two rapid writes could tie;
      // pin explicit, strictly-increasing created_at values afterward to make
      // the ordering deterministic regardless of wall-clock timing.
      writeFact(db, dbPath, {
        fact_id: "fact-old-claude",
        subject_type: "workflow",
        subject_id: "pr",
        fact_type: "preference",
        fact_text: "claude-code",
        source_type: "user_confirmation",
      });
      writeFact(db, dbPath, {
        fact_id: "fact-new-codex",
        subject_type: "workflow",
        subject_id: "pr",
        fact_type: "preference",
        fact_text: "codex-cli",
        source_type: "user_confirmation",
      });
      db.prepare("UPDATE memory_facts SET created_at = ? WHERE fact_id = ?").run(1000, "fact-old-claude");
      db.prepare("UPDATE memory_facts SET created_at = ? WHERE fact_id = ?").run(2000, "fact-new-codex");

      // Prove the DB ordering first: readFactsForSubject returns newest-first.
      const facts = readFactsForSubject(db, "workflow", "pr");
      expect(facts.map((f) => f.fact_text)).toEqual(["codex-cli", "claude-code"]);
    } finally {
      db.close();
    }

    const out: string[] = [];
    const exitCode = await handleStackCommand(["recommend", "47"], {
      dbPath,
      out: (line) => out.push(line),
    });

    expect(exitCode).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("agent: codex-cli");
    expect(text).toContain("learned preference from memory: codex-cli");
  });
});
