import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, openDb } from "@osstack/core";

// R0.5 conformance #1 — an external consumer can open the kernel state DB and
// run migrations using ONLY @osstack/core (no osstack CLI product package). The
// SQLite `user_version` pragma is the migration cursor; after openDb it must
// equal core's published CURRENT_SCHEMA_VERSION constant.

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-conformance-db-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("DB conformance (@osstack/core kernel consumption)", () => {
  it("openDb + migrations set user_version to CURRENT_SCHEMA_VERSION", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const userVersion = Number(db.pragma("user_version", { simple: true }));
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
