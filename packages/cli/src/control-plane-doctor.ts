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

const KNOWN_LABELS = ["ai.osstack.daemon", "ai.osstack.autoupgrade", "ai.osstack.copilot-daemon", "ai.ostag.copilot-relay"];

export function runControlPlaneChecks(deps: ControlPlaneDoctorDeps = {}): ControlPlaneFinding[] {
  const home = deps.home ?? process.env["OSSTACK_HOME"] ?? resolve(homedir(), ".osstack");
  const dbPath = join(home, "state.db");
  const findings: ControlPlaneFinding[] = [];

  // 1+2. Who holds the stable DB open vs the recorded daemon pid.
  let holders: number[] = [];
  let lsofFailed = false;
  try {
    const lsof = deps.lsof ?? ((p: string) => {
      // lsof exits 1 when no process holds the file — that is a valid empty
      // answer; any OTHER failure must surface as a warning, not a false green.
      try { return execFileSync("/usr/sbin/lsof", ["-t", p], { encoding: "utf8" }); }
      catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        // status 1 + empty stdout + empty stderr = genuinely no holders; any
        // stderr diagnostics (permissions etc.) is a FAILURE, not a pass (F4).
        if (e.status === 1 && !(e.stdout ?? "").trim() && !(e.stderr ?? "").toString().trim()) return "";
        throw err;
      }
    });
    holders = [...new Set(lsof(dbPath).split(/\s+/).filter(Boolean).map(Number))];
  } catch { lsofFailed = true; }
  let pidfilePid: number | null = null;
  try { pidfilePid = Number(readFileSync(join(home, "daemon.pid"), "utf8").trim()) || null; } catch { /* absent */ }
  const strangers = holders.filter((p) => p !== pidfilePid);
  if (lsofFailed) {
    findings.push({ check: "db_writers", level: "warn", detail: "could not enumerate DB holders (lsof failed) — inconclusive, NOT a pass" });
    findings.push({ check: "multi_daemon", level: "warn", detail: "holder enumeration unavailable" });
  } else if (strangers.length > 0) {
    findings.push({ check: "db_writers", level: "alert", detail: `unknown process(es) holding the control-plane DB besides the recorded daemon pid: ${strangers.join(",")}` });
  } else {
    findings.push({ check: "db_writers", level: "ok", detail: holders.length > 0 ? "only the recorded daemon holds the DB" : "no open DB handles observed" });
  }
  if (!lsofFailed) {
    if (holders.length > 1) {
      findings.push({ check: "multi_daemon", level: "alert", detail: `multiple processes attached to the control-plane DB (${holders.length})` });
    } else {
      findings.push({ check: "multi_daemon", level: "ok", detail: "single (or no) DB attachment" });
    }
  }

  // 3. LaunchAgents mentioning osstack: unknown labels are suspicious.
  const laDir = deps.launchAgentsDir ?? resolve(homedir(), "Library", "LaunchAgents");
  const known = new Set(deps.knownLabels ?? KNOWN_LABELS);
  const unknown: string[] = [];
  const seenLabels = new Map<string, number>();
  let laFailed = false;
  try {
    for (const f of readdirSync(laDir)) {
      if (!f.endsWith(".plist")) continue;
      const body = readFileSync(join(laDir, f), "utf8");
      if (!/osstack/i.test(body)) continue;
      // Authoritative identity is the plist's own Label key, not the filename.
      const m = body.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/);
      const label = m?.[1]?.trim() ?? f.replace(/\.plist$/, "");
      seenLabels.set(label, (seenLabels.get(label) ?? 0) + 1);
      if (!known.has(label)) unknown.push(label);
    }
  } catch { laFailed = true; }
  const dupes = [...seenLabels.entries()].filter(([, n]) => n > 1).map(([l]) => l);
  if (laFailed) {
    findings.push({ check: "launch_agents", level: "warn", detail: "could not read LaunchAgents dir — inconclusive, NOT a pass" });
  } else if (unknown.length > 0 || dupes.length > 0) {
    const parts = [
      ...(unknown.length ? [`unknown osstack-related LaunchAgents: ${unknown.join(", ")}`] : []),
      ...(dupes.length ? [`DUPLICATE labels: ${dupes.join(", ")}`] : []),
    ];
    findings.push({ check: "launch_agents", level: "alert", detail: parts.join("; ") });
  } else {
    findings.push({ check: "launch_agents", level: "ok", detail: "only known, unique osstack LaunchAgent labels present" });
  }

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
  // warn is NOT a pass: any non-ok exits non-zero (alerts 1, warn-only 2).
  const alert = findings.some((f) => f.level === "alert");
  const warn = findings.some((f) => f.level === "warn");
  return { text: lines.join("\n"), exitCode: alert ? 1 : warn ? 2 : 0 };
}
