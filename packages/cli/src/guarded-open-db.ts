// guarded-open-db.ts — the ONLY way cli code may open a control-plane DB
// (Phase 2.1 review F1). Wraps @osstack/core openDb with the control-plane
// guard: opening auto-migrates, so an undeclared checkout must never touch the
// default or a reserved home, on ANY command (daily, probe, neat, supervise,
// stack, start/control, daemon, …). Dev/test custom homes pass unchanged.
import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb as coreOpenDb } from "@osstack/core";
import { assertDbAccessAllowed } from "./control-plane-guard.js";

type OpenDbArgs = Parameters<typeof coreOpenDb>[0];

export function guardedOpenDb(opts: OpenDbArgs): ReturnType<typeof coreOpenDb> {
  let checkoutRoot = dirname(fileURLToPath(import.meta.url));
  try { checkoutRoot = dirname(realpathSync(fileURLToPath(import.meta.url))); } catch { /* lexical */ }
  // The home is the DB file's parent directory by construction everywhere in
  // the cli (state.db lives at <home>/state.db).
  const home = dirname(opts.path);
  assertDbAccessAllowed({ checkoutRoot, osstackHome: home });
  return coreOpenDb(opts);
}
