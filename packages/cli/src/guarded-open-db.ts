// guarded-open-db.ts — the ONLY way cli code may open a control-plane DB
// (Phase 2.1 review F1). Wraps @osstack/core openDb with the control-plane
// guard: opening auto-migrates, so an undeclared checkout must never touch the
// default or a reserved home, on ANY command (daily, probe, neat, supervise,
// stack, start/control, daemon, …). Dev/test custom homes pass unchanged.
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, openDb as coreOpenDb } from "@osstack/core";
import { assertDbAccessAllowed } from "./control-plane-guard.js";
import { assertManagedHomeMarker } from "./managed-home-guard.js";
import { VERSION, PROTOCOL_VERSION } from "./version.js";

import { assertSingleSqliteFiles } from "./sqlite-file-guard.js";

type OpenDbArgs = Parameters<typeof coreOpenDb>[0];

export function guardedOpenDb(opts: OpenDbArgs): ReturnType<typeof coreOpenDb> {
  if (opts.path === ":memory:") return coreOpenDb(opts);
  let checkoutRoot = dirname(fileURLToPath(import.meta.url));
  try { checkoutRoot = dirname(realpathSync(fileURLToPath(import.meta.url))); } catch { /* lexical */ }
  // The home is the DB file's parent directory by construction everywhere in
  // the cli (state.db lives at <home>/state.db).
  // Resolve the actual database before deriving its home: an external file
  // symlink must not bypass the managed marker on the target directory.
  let path = resolve(opts.path);
  assertSingleSqliteFiles(path);
  try { path = realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { path = join(realpathSync(dirname(path)), basename(path)); } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
    }
  }
  assertSingleSqliteFiles(path);
  const home = dirname(path);
  assertDbAccessAllowed({ checkoutRoot, osstackHome: home });
  assertManagedHomeMarker(home, process.argv[1], {version:VERSION,protocol_version:PROTOCOL_VERSION,database_schema:CURRENT_SCHEMA_VERSION});
  return coreOpenDb({ ...opts, path });
}
