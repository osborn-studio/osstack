import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, KanbanRepository } from "@osstack/core";
import type { CommandRunner } from "@osstack/github";
import { handleStackCommand, PR_CARD_CHECKLIST } from "./stack-cli.js";

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
  return join(dir, "state.db");
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
});
