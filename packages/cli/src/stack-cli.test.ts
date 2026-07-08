import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, KanbanRepository } from "@osstack/core";
import type { CommandRunner } from "@osstack/github";
import { handleStackCommand, PR_CARD_CHECKLIST } from "./stack-cli.js";

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
