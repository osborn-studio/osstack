import { CURRENT_SCHEMA_VERSION } from "@osstack/core";
import { describe, expect, it } from "vitest";
import { ATTENTION_READ_QUALIFIED_SCHEMA } from "./attention-read-model.js";
import { UPGRADE_QUALIFIED_SCHEMA } from "./upgrade-native-port.js";

// Each gate is qualified by hand on purpose. When a migration lands, this test is
// the one place that fails: review the migration against each gate, then bump it.
describe("schema gates", () => {
  it("have reviewed the latest migration", () => {
    expect(UPGRADE_QUALIFIED_SCHEMA, "review upgrade-native-port.ts lockHomeDatabase").toBe(CURRENT_SCHEMA_VERSION);
    expect(ATTENTION_READ_QUALIFIED_SCHEMA, "review attention-read-model.ts").toBe(CURRENT_SCHEMA_VERSION);
  });
});
