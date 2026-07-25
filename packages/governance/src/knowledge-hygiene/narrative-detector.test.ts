import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectNarrativeSignals,
  type NarrativeSignalRuleIdV1,
} from "./narrative-detector.js";

interface NarrativeFixtureCase {
  id: string;
  file: string;
  expected_rule_ids: NarrativeSignalRuleIdV1[];
  explicit_marker: boolean;
}

interface NarrativeFixtureManifest {
  cases: NarrativeFixtureCase[];
}

const fixtureRoot = fileURLToPath(
  new URL("../../fixtures/knowledge-hygiene/u0-narrative/", import.meta.url),
);

async function loadManifest(): Promise<NarrativeFixtureManifest> {
  return JSON.parse(
    await readFile(`${fixtureRoot}manifest.json`, "utf8"),
  ) as NarrativeFixtureManifest;
}

describe("detectNarrativeSignals", () => {
  it("meets the frozen fixture precision and recall gates", async () => {
    const manifest = await loadManifest();
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let explicitMarkersFound = 0;
    let explicitMarkersExpected = 0;

    expect(manifest.cases.length).toBeGreaterThanOrEqual(30);
    expect(
      manifest.cases.filter((fixture) => fixture.expected_rule_ids.length > 0)
        .length,
    ).toBeGreaterThanOrEqual(10);
    expect(
      manifest.cases.filter((fixture) => fixture.expected_rule_ids.length === 0)
        .length,
    ).toBeGreaterThanOrEqual(20);

    for (const fixture of manifest.cases) {
      const content = await readFile(`${fixtureRoot}cases/${fixture.file}`, "utf8");
      const first = detectNarrativeSignals({
        path: "AGENTS.md",
        content,
      });
      const second = detectNarrativeSignals({
        path: "AGENTS.md",
        content,
      });
      expect(second).toEqual(first);

      const actual = new Set(first.map((signal) => signal.rule_id));
      const expected = new Set(fixture.expected_rule_ids);
      for (const ruleId of actual) {
        if (expected.has(ruleId)) truePositives += 1;
        else falsePositives += 1;
      }
      for (const ruleId of expected) {
        if (!actual.has(ruleId)) falseNegatives += 1;
      }
      if (fixture.explicit_marker) {
        explicitMarkersExpected += 1;
        if (actual.has("rulebook.managed_context_block")) {
          explicitMarkersFound += 1;
        }
      }
    }

    const recall = truePositives / (truePositives + falseNegatives);
    const precision = truePositives / (truePositives + falsePositives);
    expect(explicitMarkersFound / explicitMarkersExpected).toBe(1);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });

  it("anchors an unclosed managed block through EOF", () => {
    const signals = detectNarrativeSignals({
      path: "AGENTS.md",
      content: "# Rules\n<claude-mem-context>\nold session\n",
    });

    expect(signals).toEqual([
      expect.objectContaining({
        rule_id: "rulebook.managed_context_block",
        start_line: 2,
        end_line: 3,
        confidence: "high",
      }),
    ]);
  });

  it("sorts signals by location then rule id", () => {
    const content = [
      "<!-- osstack-neat-disable-next-line unknown.rule reason=\"bad\" -->",
      "<claude-mem-context>",
      "old session",
      "</claude-mem-context>",
    ].join("\n");

    expect(
      detectNarrativeSignals({ path: "AGENTS.md", content }).map((signal) => [
        signal.start_line,
        signal.rule_id,
      ]),
    ).toEqual([
      [1, "rulebook.invalid_waiver"],
      [2, "rulebook.managed_context_block"],
    ]);
  });
});
