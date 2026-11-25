import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScratchDirSync, openDb } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHermesDecision } from "./hermes-resolve.js";

for (const kind of ["approval", "clarify"] as const) {
  describe(`${kind}.resolve`, () => {
    const approval = kind === "approval";
    const method = `${kind}.resolve` as const;
    const table = approval ? "approvals" : "clarifies";
    const key = `${kind}_id`;
    const field = approval ? "choice" : "answer";
    const status = approval ? "accepted" : "answered";
    const params = { [key]: "a", [field]: "no" };
    const result = { resolved: true, [key]: "a", ...(approval ? { choice: "no" } : {}) };
    let root: string;
    let db: ReturnType<typeof openDb>;
    const resolve = () => resolveHermesDecision(db, method, params);
    const row = () => db.prepare(`SELECT * FROM ${table} WHERE ${key}='a'`).get();
    const changes = () => db.prepare("SELECT total_changes()").pluck().get();

    beforeEach(() => {
      root = createScratchDirSync("tests", "hermes-resolve");
      db = openDb({ path: join(root, "db") });
      db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
      db.exec("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','agent','code','execute',1)");
      db.exec(approval
        ? "INSERT INTO approvals(approval_id,run_id,status,action_summary,risk,requested_at) VALUES('a','r','pending','Approve?','low',1)"
        : "INSERT INTO clarifies(clarify_id,run_id,status,question,requested_at) VALUES('a','r','pending','Which?',1)");
    });
    afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

    it("returns the first result on identical replay without changing any row", () => {
      const first = resolve();
      expect(first).toStrictEqual(result);
      const stored = row();
      expect(stored).toMatchObject({ status, [field]: "no", resolved_at: expect.any(Number) });
      const before = changes();
      expect(resolveHermesDecision(db, method, { ...params, actor: "another" })).toStrictEqual(first);
      expect(row()).toStrictEqual(stored);
      expect(changes()).toBe(before);
    });

    if (approval) {
      it.each(["accepted", "rejected"])("writes and replays explicit status %s", stated => {
        const request = { ...params, status: stated };
        const first = resolveHermesDecision(db, method, request);
        expect(first).toStrictEqual({ ...result, status: stated });
        const stored = row();
        expect(stored).toMatchObject({ status: stated, choice: "no", resolved_at: expect.any(Number) });
        const before = changes();
        expect(resolveHermesDecision(db, method, request)).toStrictEqual(first);
        const other = stated === "accepted" ? "rejected" : "accepted";
        expect(() => resolveHermesDecision(db, method, { ...params, status: other })).toThrow(/^already_resolved$/);
        if (stated === "accepted") expect(resolve()).toStrictEqual(result);
        expect(row()).toStrictEqual(stored);
        expect(changes()).toBe(before);
      });

      it.each(["timed_out", "", 1, "REJECTED"])("refuses invalid status %j before writing", invalid => {
        const before = changes();
        expect(() => resolveHermesDecision(db, method, { ...params, status: invalid })).toThrow(/^bad_request$/);
        expect(row()).toMatchObject({ status: "pending", choice: null, resolved_at: null });
        expect(changes()).toBe(before);
      });
    } else {
      it("ignores the status key on a clarify resolution", () => {
        expect(resolveHermesDecision(db, method, { ...params, status: "rejected" })).toStrictEqual(result);
        expect(row()).toMatchObject({ status: "answered", answer: "no" });
        const before = changes();
        expect(resolve()).toStrictEqual(result);
        expect(changes()).toBe(before);
      });
    }

    it.each([
      [status, "NO"], [status, null], ["timed_out", "no"], [approval ? "rejected" : "abandoned", "no"],
    ])("refuses stored status %s and value %s without a write", (priorStatus, priorValue) => {
      db.prepare(`UPDATE ${table} SET status=?, ${field}=?, resolved_at=42`).run(priorStatus, priorValue);
      const stored = row();
      const before = changes();
      expect(resolve).toThrow(/^already_resolved$/);
      expect(row()).toStrictEqual(stored);
      expect(changes()).toBe(before);
    });

    it.each(["same value", "different value", "different status", "deleted"])("lost race: %s", race => {
      const prepare = db.prepare.bind(db);
      let winner: unknown;
      const before = changes();
      vi.spyOn(db, "prepare").mockImplementation(sql => {
        if (/^\s*UPDATE\b/i.test(sql)) {
          const other = openDb({ path: join(root, "db") });
          try {
            if (race === "deleted") other.exec(`DELETE FROM ${table} WHERE ${key}='a'`);
            else other.prepare(`UPDATE ${table} SET status=?, ${field}=?, resolved_at=42 WHERE ${key}='a'`)
              .run(race === "different status" ? "timed_out" : status, race === "different value" ? "yes" : "no");
            winner = other.prepare(`SELECT * FROM ${table} WHERE ${key}='a'`).get();
          } finally { other.close(); }
        }
        return prepare(sql);
      });
      if (race === "same value") expect(resolve()).toStrictEqual(result);
      else expect(resolve).toThrow(race === "deleted" ? /^not_found$/ : /^already_resolved$/);
      expect(row()).toStrictEqual(winner);
      expect(changes()).toBe(before);
    });

    it("preserves validation and missing-id errors", () => {
      const before = changes();
      for (const invalid of [{ ...params, [key]: 0 }, { ...params, [field]: null }]) {
        expect(() => resolveHermesDecision(db, method, invalid)).toThrow(/^bad_request$/);
      }
      expect(() => resolveHermesDecision(db, method, { ...params, [key]: "missing" })).toThrow(/^not_found$/);
      expect(changes()).toBe(before);
    });
  });
}

it("limits resolver, port and RPC case labels to the existing wiring", () => {
  const packages = fileURLToPath(new URL("../../..", import.meta.url));
  const sources = readdirSync(packages).flatMap(pkg => {
    const src = join(packages, pkg, "src");
    if (!existsSync(src)) return [];
    return readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\./.test(file))
      .map(file => ({ path: `${pkg}/src/${file}`, source: readFileSync(join(src, file), "utf8") }));
  });
  const matches = (pattern: RegExp) => sources.filter(f => pattern.test(f.source)).map(f => f.path).sort();
  const daemon = "cli/src/daemon.ts";
  expect(matches(/\bresolveHermesDecision\b/)).toEqual([daemon, "cli/src/decisions/hermes-resolve.ts"]);
  expect(matches(/\bresolveHermes\b/)).toEqual([daemon, "cli/src/decisions/answer.ts"]);
  expect(matches(/\bcase\s+["'`]approval\.resolve["'`]\s*:/)).toEqual([daemon]);
  expect(matches(/\bcase\s+["'`]clarify\.resolve["'`]\s*:/)).toEqual([daemon]);
});
