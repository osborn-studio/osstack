import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateAllProbeSchemasV1,
  PROBE_SCHEMA_MANIFEST_V1,
} from "./generate.js";

const schemasDirectory = fileURLToPath(
  new URL("../../schemas", import.meta.url),
);

describe("probe public schemas", () => {
  const generated = generateAllProbeSchemasV1();

  it("publishes one deterministic artifact per public root object", () => {
    expect(Object.keys(generated).sort()).toEqual([
      "probe-evaluation-compilation-batch-v1.schema.json",
      "probe-evaluation-compilation-delta-v1.schema.json",
      "probe-event-v1.schema.json",
      "probe-item-v1.schema.json",
      "probe-ledger-v1.schema.json",
      "probe-policy-v1.schema.json",
      "probe-question-batch-v1.schema.json",
      "probe-render-manifest-v1.schema.json",
      "probe-restatement-finding-v1.schema.json",
      "probe-session-v1.schema.json",
    ]);
    expect(PROBE_SCHEMA_MANIFEST_V1).toHaveLength(10);
  });

  for (const [filename, content] of Object.entries(generated)) {
    it(`keeps schemas/${filename} in sync with Zod`, () => {
      expect(readFileSync(`${schemasDirectory}/${filename}`, "utf8")).toBe(
        content,
      );
    });
  }
});
