import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { ENGINEERING_LOCAL_FAILURE_INTAKE_DDL } from "./engineering-local-failure-intake-ddl.js";

it("stays unregistered and adds only journal objects without changing existing schemas or migration version", () => {
  const root = realpathSync(createScratchDirSync("tests", "intake-ddl"));
  const db = openDb({ path: join(root, "state.db") });
  try {
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='engineering_local_failure_intakes'").get()).toBeUndefined();
    const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all() as Array<{ type: string; name: string; sql: string | null }>;
    const before = objects(), version = db.pragma("user_version", { simple: true });
    db.exec(ENGINEERING_LOCAL_FAILURE_INTAKE_DDL);
    const after = objects();
    for (const object of before) expect(after.find(o => o.name === object.name && o.type === object.type)).toEqual(object);
    expect(after.filter(o => !before.some(b => b.name === o.name)).every(o =>
      o.name.startsWith("engineering_local_failure_") || o.name.startsWith("sqlite_autoindex_engineering_local_failure_")
    )).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(version);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
