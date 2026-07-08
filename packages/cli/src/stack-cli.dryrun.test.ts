import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, readFactsForSubject, listImprovementProposals } from "@osstack/core";
import type { CommandRunner } from "@osstack/github";
import { handleStackCommand, PR_CARD_CHECKLIST } from "./stack-cli.js";

// ---------------------------------------------------------------------------
// OFFLINE dry-run over a captured 8-PR Knowledge Layer fixture.
//
// The whole `stack` loop (ingest → board → runbook → check/move → retro) is
// driven against the fixture with a CommandRunner that NEVER spawns a process:
// it reads the JSON from disk once and answers `gh pr view <n>` from memory.
// If a PR is not in the fixture the runner THROWS, so the test can never
// silently fall through to a live `gh` invocation.
// ---------------------------------------------------------------------------

// Read the fixture ONCE at module load — this is the only source of PR data.
const FIXTURE: Record<string, unknown> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/knowledge-layer-stack.json", import.meta.url)),
    "utf-8",
  ),
);

/** A CommandRunner that answers `gh pr view <n> --json ...` purely from the
 * fixture file. It never touches the network or spawns a subprocess. */
function makeFixtureRunner(): CommandRunner {
  return {
    run: async (_command, args) => {
      const number = args[args.indexOf("view") + 1];
      const record = number === undefined ? undefined : FIXTURE[number];
      if (record === undefined) {
        // Hard guarantee that nothing hits live gh: an unknown PR is fatal.
        throw new Error("dry-run: no fixture for PR " + number);
      }
      return JSON.stringify(record);
    },
  };
}

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "osstack-stack-dryrun-"));
  const dbPath = join(dir, "state.db");
  tmpDirs.push(dirname(dbPath));
  return dbPath;
}

const KL_PRS = "47,48,49,50,52,53,55,56";
const KL_ORDER = "47,48,49,50,52,53,55,56";

describe("stack dry-run: Knowledge Layer 8-PR fixture (offline)", () => {
  it("drives the full loop offline: ingest → board → runbook → checks → retro", async () => {
    const dbPath = makeTempDbPath();
    const runner = makeFixtureRunner();
    const now = () => 1_000_000;
    const deps = { runner, dbPath, now, out: (line: string) => out.push(line) };
    let out: string[] = [];

    // 1. ingest — the chained base↔head PRs topo-sort into the known-good order.
    out = [];
    const ingestCode = await handleStackCommand(
      ["ingest", "--prs", KL_PRS, "--board", "kl"],
      { ...deps, out: (line) => out.push(line) },
    );
    expect(ingestCode).toBe(0);
    expect(out.join("\n")).toContain(`order: ${KL_ORDER}`);

    // 2. board — freshly-ingested cards all start in `ready`; expect 8 cards.
    out = [];
    const boardCode = await handleStackCommand(
      ["board", "--board", "kl"],
      { ...deps, out: (line) => out.push(line) },
    );
    expect(boardCode).toBe(0);
    const boardText = out.join("\n");
    expect(boardText).toContain("== READY (8) ==");
    for (const n of ["47", "48", "49", "50", "52", "53", "55", "56"]) {
      expect(boardText).toContain(`pr-${n}`);
    }

    // 3. runbook — capstone: the generated bottom-up order matches the
    //    known-good chain exactly, 1. pr-47 … 8. pr-56, plus the gate notes.
    out = [];
    const runbookCode = await handleStackCommand(
      ["runbook", "--board", "kl"],
      { ...deps, out: (line) => out.push(line) },
    );
    expect(runbookCode).toBe(0);
    const runbook = out.join("\n");
    const orderTokens = [
      "1. pr-47",
      "2. pr-48",
      "3. pr-49",
      "4. pr-50",
      "5. pr-52",
      "6. pr-53",
      "7. pr-55",
      "8. pr-56",
    ];
    let cursor = -1;
    for (const token of orderTokens) {
      const at = runbook.indexOf(token);
      expect(at, `runbook missing "${token}"`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(runbook).toContain("Retarget:");
    expect(runbook).toContain("Rollback:");

    // 4. simulated checks (offline, no gh). Pass every check on pr-47, done it.
    for (let idx = 0; idx < PR_CARD_CHECKLIST.length; idx++) {
      const c = await handleStackCommand(["check", "47", String(idx), "--pass"], {
        ...deps,
        out: () => {},
      });
      expect(c).toBe(0);
    }
    expect(await handleStackCommand(["move", "47", "done"], { ...deps, out: () => {} })).toBe(0);

    // On the UI card pr-55, FAIL the "endpoint/UI smoke" check (index 3).
    const smokeIdx = PR_CARD_CHECKLIST.indexOf("endpoint/UI smoke");
    expect(smokeIdx).toBe(3);
    expect(
      await handleStackCommand(["check", "55", String(smokeIdx), "--fail"], {
        ...deps,
        out: () => {},
      }),
    ).toBe(0);

    // Drive pr-55 into blocked once and back, producing one real blocked event
    // for the Rework section (all lane→lane moves are legal except leaving
    // archived, per kanban/schema.ts isLegalCardTransition).
    expect(await handleStackCommand(["move", "55", "blocked"], { ...deps, out: () => {} })).toBe(0);
    expect(await handleStackCommand(["move", "55", "running"], { ...deps, out: () => {} })).toBe(0);

    // 5. retro --write — closes the loop, persists a fact + a gate proposal.
    out = [];
    const retroCode = await handleStackCommand(
      ["retro", "--board", "kl", "--write"],
      { ...deps, out: (line) => out.push(line) },
    );
    expect(retroCode).toBe(0);
    const retro = out.join("\n");
    expect(retro).toContain('# Merge retrospective — board "kl"');
    expect(retro).toContain("## What Worked");
    expect(retro).toContain("pr-47"); // the done card
    expect(retro).toContain("## What The Checks Caught");
    expect(retro).toContain("pr-55: endpoint/UI smoke failed");
    expect(retro).toContain("- pr-55 reworked 1×"); // the one blocked event

    // Assert the persisted memory fact + improvement proposal.
    {
      const db = openDb({ path: dbPath });
      try {
        const facts = readFactsForSubject(db, "workflow", "merge-orchestration");
        expect(facts).toHaveLength(1);
        expect(facts[0]!.fact_text.startsWith("retro(kl):")).toBe(true);

        const proposals = listImprovementProposals(db, { repo_id: "kl" });
        expect(proposals).toHaveLength(1);
        expect(proposals[0]!.proposal_id).toBe("stack-retro-gate-kl");
      } finally {
        db.close();
      }
    }

    // 6. idempotency — a second retro --write dedupes fact + upserts proposal.
    expect(
      await handleStackCommand(["retro", "--board", "kl", "--write"], {
        ...deps,
        out: () => {},
      }),
    ).toBe(0);
    {
      const db = openDb({ path: dbPath });
      try {
        expect(readFactsForSubject(db, "workflow", "merge-orchestration")).toHaveLength(1);
        expect(listImprovementProposals(db, { repo_id: "kl" })).toHaveLength(1);
      } finally {
        db.close();
      }
    }
  });

  it("the fixture runner throws for an unknown PR, so nothing hits live gh", async () => {
    const dbPath = makeTempDbPath();
    const runner = makeFixtureRunner();

    // #99 is absent → the runner throws → ingest catches and returns 1. If this
    // ever returned 0 it would mean a live gh path existed; it does not.
    const code = await handleStackCommand(["ingest", "--prs", "99", "--board", "x"], {
      runner,
      dbPath,
      now: () => 1_000_000,
      out: () => {},
    });
    expect(code).toBe(1);
  });
});
