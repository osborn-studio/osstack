import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const script = join(repositoryRoot, "scripts", "eval-kimi-review.mjs");
const corpusPath = join(
  repositoryRoot,
  "eval",
  "kimi-review",
  "corpus-v1.json",
);

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "osstack-kimi-eval-"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("Kimi seeded-defect evaluator", () => {
  it("scores the independent offline oracle with zero false passes", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "--check", "--json"],
      { cwd: repositoryRoot },
    );
    const scorecard = JSON.parse(stdout) as {
      mode: string;
      case_count: number;
      false_pass_count: number;
      false_alarm_count: number;
      rule_miss_count: number;
      gate_pass: boolean;
    };

    expect(scorecard).toMatchObject({
      mode: "offline",
      case_count: 10,
      false_pass_count: 0,
      false_alarm_count: 0,
      rule_miss_count: 0,
      gate_pass: true,
    });
  });

  it("fails when a defect label is not supported by the independent oracle", async () => {
    const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as {
      cases: Array<{
        case_id: string;
        expected_verdict: string;
        expected_finding_rules: string[];
      }>;
    };
    const clean = corpus.cases.find(
      (entry) => entry.case_id === "clean-refactor",
    );
    if (clean === undefined) throw new Error("clean-refactor case missing");
    clean.expected_verdict = "changes_requested";
    clean.expected_finding_rules = ["correctness.injected_label"];
    const mutatedPath = join(temporaryRoot, "mutated-corpus.json");
    await writeFile(mutatedPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");

    let stdout = "";
    try {
      await execFileAsync(
        process.execPath,
        [script, "--check", "--json", "--corpus", mutatedPath],
        { cwd: repositoryRoot },
      );
      throw new Error("mutated corpus unexpectedly passed");
    } catch (error) {
      stdout = String((error as { stdout?: unknown }).stdout ?? "");
    }
    const scorecard = JSON.parse(stdout) as {
      false_pass_count: number;
      rule_miss_count: number;
      gate_pass: boolean;
    };
    expect(scorecard.false_pass_count).toBe(1);
    expect(scorecard.rule_miss_count).toBe(1);
    expect(scorecard.gate_pass).toBe(false);
  });
});
