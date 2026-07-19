// control-plane-doctor.ts — `osstack doctor --control-plane` (Phase 2 closure
// G1.3): detect the incident classes of 2026-07-18 — multiple daemons or
// unknown writers on the stable home, duplicate/unknown osstack LaunchAgents,
// and a DB whose schema version does not match this binary.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "@osstack/core";

export interface ControlPlaneFinding {
  check: "multi_daemon" | "db_writers" | "launch_agents" | "schema_version";
  level: "ok" | "warn" | "alert";
  detail: string;
}

export interface ControlPlaneDoctorDeps {
  home?: string;
  lsof?: (path: string) => string;
  launchAgentsDir?: string;
  knownLabels?: string[];
}

const KNOWN_LABELS = ["ai.osstack.daemon", "ai.osstack.copilot-daemon", "ai.ostag.copilot-relay"];

export function runControlPlaneChecks(deps: ControlPlaneDoctorDeps = {}): ControlPlaneFinding[] {
  const home = deps.home ?? resolve(homedir(), ".osstack");
  const dbPath = join(home, "state.db");
  const findings: ControlPlaneFinding[] = [];

  // 1+2. Who holds the stable DB open vs the recorded daemon pid.
  let holders: number[] = [];
  try {
    const lsof = deps.lsof ?? ((p: string) => {
      try { return execFileSync("/usr/sbin/lsof", ["-t", p], { encoding: "utf8" }); } catch { return ""; }
    });
    holders = [...new Set(lsof(dbPath).split(/\s+/).filter(Boolean).map(Number))];
  } catch { /* lsof unavailable — skip */ }
  let pidfilePid: number | null = null;
  try { pidfilePid = Number(readFileSync(join(home, "daemon.pid"), "utf8").trim()) || null; } catch { /* absent */ }
  const strangers = holders.filter((p) => p !== pidfilePid);
  if (strangers.length > 0) {
    findings.push({ check: "db_writers", level: "alert", detail: `unknown process(es) holding the control-plane DB besides the recorded daemon pid: ${strangers.join(",")}` });
  } else {
    findings.push({ check: "db_writers", level: "ok", detail: holders.length > 0 ? "only the recorded daemon holds the DB" : "no open DB handles observed" });
  }
  if (holders.length > 1) {
    findings.push({ check: "multi_daemon", level: "alert", detail: `multiple processes attached to the control-plane DB (${holders.length})` });
  } else {
    findings.push({ check: "multi_daemon", level: "ok", detail: "single (or no) DB attachment" });
  }

  // 3. LaunchAgents mentioning osstack: unknown labels are suspicious.
  const laDir = deps.launchAgentsDir ?? resolve(homedir(), "Library", "LaunchAgents");
  const known = new Set(deps.knownLabels ?? KNOWN_LABELS);
  const unknown: string[] = [];
  try {
    for (const f of readdirSync(laDir)) {
      if (!f.endsWith(".plist")) continue;
      const body = readFileSync(join(laDir, f), "utf8");
      if (!/osstack/i.test(body)) continue;
      const label = f.replace(/\.plist$/, "");
      if (!known.has(label)) unknown.push(label);
    }
  } catch { /* dir unreadable — skip */ }
  findings.push(unknown.length > 0
    ? { check: "launch_agents", level: "alert", detail: `unknown osstack-related LaunchAgents: ${unknown.join(", ")}` }
    : { check: "launch_agents", level: "ok", detail: "only known osstack LaunchAgent labels present" });

  // 4. DB schema version vs this binary — a foreign newer writer leaves a trail.
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const uv = (db.pragma("user_version", { simple: true }) as number) ?? -1;
      db.close();
      findings.push(uv === CURRENT_SCHEMA_VERSION
        ? { check: "schema_version", level: "ok", detail: `user_version=${uv} matches this binary` }
        : { check: "schema_version", level: "alert", detail: `user_version=${uv} != supported ${CURRENT_SCHEMA_VERSION} — a foreign checkout may have migrated the DB (incident 2026-07-18 pattern)` });
    } catch (err) {
      findings.push({ check: "schema_version", level: "warn", detail: `could not read user_version: ${err instanceof Error ? err.message : String(err)}` });
    }
  } else {
    findings.push({ check: "schema_version", level: "ok", detail: "no control-plane DB present" });
  }

  return findings;
}

export function renderControlPlaneFindings(findings: ControlPlaneFinding[]): { text: string; exitCode: number } {
  const lines = findings.map((f) => `${f.level === "ok" ? "✓" : f.level === "warn" ? "!" : "✗"} [${f.check}] ${f.detail}`);
  const bad = findings.some((f) => f.level === "alert");
  return { text: lines.join("\n"), exitCode: bad ? 1 : 0 };
}
