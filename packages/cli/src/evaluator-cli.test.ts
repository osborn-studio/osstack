import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEvaluatorVersions, openDb, upsertAnchorCase } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-evaluator-cli-"));
  logs = [];
  errors = [];
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.map(String).join(" ")); });
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function seedAnchor() {
  const home = join(tmp, "home");
  await mkdir(home, { recursive: true });
  const path = join(home, "state.db");
  const db = openDb({ path });
  try {
    upsertAnchorCase(db, path, {
      case_id: "anchor_1",
      repo_id: "stock-monitor",
      input_summary: "overconfident buy",
      expected_verdict: "reject",
      evidence_refs: ["human: reject"],
      adversarial: true,
    });
  } finally {
    db.close();
  }
}

const CHALLENGE = [
  "--repo", "stock-monitor",
  "--incumbent", "eval_v1", "--challenger", "eval_v2",
  "--incumbent-correct", "8", "--incumbent-total", "10",
  "--challenger-correct", "9", "--challenger-total", "10",
];

describe("evaluator CLI", () => {
  it("challenge is advisory and reports the promotion delta", async () => {
    const code = await main(["evaluator", "challenge", ...CHALLENGE, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as { advisory: boolean; promoted: boolean; anchor_accuracy_delta: number };
    expect(parsed).toMatchObject({ advisory: true, promoted: true, anchor_accuracy_delta: 0.1 });
  });

  it("promote blocks with exit 1 when there are no anchor cases", async () => {
    const code = await main(["evaluator", "promote", ...CHALLENGE, "--yes", "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ promoted: false, blocked: true });
  });

  it("promote defaults to a dry run even with anchors present", async () => {
    await seedAnchor();
    const code = await main(["evaluator", "promote", ...CHALLENGE, "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ dry_run: true, promoted: true });
    // Dry run must not create a frozen challenger version.
    const db = openDb({ path: join(tmp, "home", "state.db") });
    try {
      expect(listEvaluatorVersions(db, { repo_id: "stock-monitor" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("promote --yes with anchors freezes the challenger and quarantines the incumbent", async () => {
    await seedAnchor();
    const code = await main(["evaluator", "promote", ...CHALLENGE, "--yes", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as { promoted: boolean; promoted_evaluator_id: string; epoch_id: string };
    expect(parsed).toMatchObject({ promoted: true, promoted_evaluator_id: "eval_v2" });
    expect(parsed.epoch_id).toMatch(/^epoch_/);

    const db = openDb({ path: join(tmp, "home", "state.db") });
    try {
      const frozen = listEvaluatorVersions(db, { repo_id: "stock-monitor", status: "frozen" });
      expect(frozen.map((v) => v.evaluator_id)).toContain("eval_v2");
    } finally {
      db.close();
    }
  });
});
