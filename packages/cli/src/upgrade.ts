import { assertGraphUpgradeSafe } from './graph-upgrade-guard.js';
// `osstack upgrade` — self-update with a safety net.
//
// Flow:
//   1. Resolve target version from the npm registry (channel = dist-tag).
//   2. Nothing newer → exit 0 ("already up to date").
//   3. Drain + stop the daemon (if running) so no run dies mid-flight.
//   4. Snapshot ~/.osstack/state.db (+WAL/SHM) into ~/.osstack/backups/.
//   5. `npm install -g @osstack/cli@<target>`.
//   6. Restart the daemon (launchctl kickstart when launchd-managed,
//      detached `osstack serve` otherwise) and verify health + version.
//   7. Any failure after install → roll back to the previous version and
//      restart again.
//
// `--auto` is the cron/launchd entrypoint: identical behaviour, but designed
// to be quiet and always safe to run unattended.

import { spawn } from "node:child_process";
import { loadRoleFile, provisionStableServing } from "./control-plane-guard.js";
import { CURRENT_SCHEMA_VERSION } from "@osstack/core";
import { homedir } from "node:os";
import {
  copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { backupsDir, logsDir, osstackHome, resolveSocketPath } from "./paths.js";
import { compareSemver, VERSION } from "./version.js";
import { fetchRegistryVersion } from "./update-check.js";

const PKG = "@osstack/cli";
const LAUNCHD_LABEL = "ai.osstack.daemon";
const BACKUPS_TO_KEEP = 5;

function daemonPlistPath(): string {
  const directory = process.env["OSSTACK_LAUNCH_AGENTS_DIR"]
    ?? join(homedir(), "Library", "LaunchAgents");
  return join(directory, `${LAUNCHD_LABEL}.plist`);
}

/**
 * Resolve the OSSTACK_HOME the DEPLOYED daemon actually serves.
 *
 * The caller's shell environment is the LAST resort: `osstack upgrade` run
 * from a terminal without the daemon's env used to re-provision the guard
 * for the wrong home, so the freshly installed daemon refused to serve and
 * every health check failed — and the rollback re-provisioned wrongly too
 * (incident 2026-08-12, 0.16.1 → 0.17.0). Priority: the launchd plist env
 * (how the daemon is actually started) → the role file provisioned next to
 * the current global binary (self-perpetuating; captured BEFORE npm wipes
 * it) → caller env / default.
 */
export function resolveDeployedHome(
  plistText: string | null,
  npmRoot: string | null,
): { home: string; source: "launchd plist" | "existing role file" | "environment" } {
  const fromPlist = plistText?.match(/<key>OSSTACK_HOME<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (fromPlist !== undefined && fromPlist !== "") {
    return { home: fromPlist, source: "launchd plist" };
  }
  if (npmRoot !== null && npmRoot !== "") {
    try {
      const role = loadRoleFile(join(npmRoot, "@osstack", "cli", "dist"));
      const first = role?.allowed_osstack_homes[0];
      if (first !== undefined) return { home: first, source: "existing role file" };
    } catch { /* invalid role file — treat as absent */ }
  }
  return { home: process.env["OSSTACK_HOME"] ?? "~/.osstack", source: "environment" };
}

/**
 * Align this process with the deployed daemon's home BEFORE any path is
 * derived from it (backup, socket polling, log paths, and all four
 * provisionStableServing calls read OSSTACK_HOME/OSSTACK_SOCKET from env).
 *
 * Values are ~-expanded to absolute paths before assignment: role files may
 * legitimately carry "~/..." entries, but osstackHome()/resolveSocketPath()
 * do no expansion of their own — a literal "~" in env would silently derive
 * relative paths (and mkdir a literal ./~ directory).
 *
 * A served-home change must go through `serve --install`, which re-renders
 * the plist: when both exist, a (stale) plist intentionally wins over the
 * role file, because the incident this guards against is exactly a
 * wrongly-provisioned role file.
 */
export function alignEnvWithDeployment(plistText: string | null, npmRoot: string | null): void {
  const deployed = resolveDeployedHome(plistText, npmRoot);
  if (deployed.source === "environment") return;
  const expand = (p: string): string => resolve(p.replace(/^~(?=$|\/)/, homedir()));
  const envHome = process.env["OSSTACK_HOME"];
  if (envHome !== undefined && expand(envHome) !== expand(deployed.home)) {
    log(`note: OSSTACK_HOME in this shell (${envHome}) differs from the deployed daemon's home (${deployed.home}, from ${deployed.source}) — using the deployed home.`);
  }
  process.env["OSSTACK_HOME"] = expand(deployed.home);
  const sock = plistText?.match(/<key>OSSTACK_SOCKET<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (sock !== undefined && sock !== "" && process.env["OSSTACK_SOCKET"] === undefined) {
    process.env["OSSTACK_SOCKET"] = expand(sock);
  }
}

export interface UpgradeOptions {
  channel: string;        // npm dist-tag: latest | canary
  dryRun: boolean;
  auto: boolean;
  /** Internal: RPC helper injected by bin.ts (avoids a circular import). */
  rpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
}

interface RpcResp { ok?: boolean; result?: unknown }

function log(msg: string): void {
  console.log(`osstack upgrade: ${msg}`);
}

function run(cmd: string, args: string[], timeoutMs = 300_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { p.kill("SIGTERM"); resolve({ ok: false, output: `${out}\n(timeout)` }); }, timeoutMs);
    p.stdout.on("data", (c) => { out += String(c); });
    p.stderr.on("data", (c) => { out += String(c); });
    p.on("error", (err) => { clearTimeout(t); resolve({ ok: false, output: err.message }); });
    p.on("exit", (code) => { clearTimeout(t); resolve({ ok: code === 0, output: out }); });
  });
}

async function daemonVersion(rpc: UpgradeOptions["rpc"]): Promise<string | null> {
  try {
    const resp = (await rpc("version", undefined, 3_000)) as RpcResp;
    const r = resp.result as { version?: string } | undefined;
    return resp.ok === true && typeof r?.version === "string" ? r.version : null;
  } catch {
    return null;
  }
}

async function launchdManaged(): Promise<boolean> {
  const r = await run("launchctl", ["list", LAUNCHD_LABEL], 5_000);
  return r.ok;
}

/** Copy state.db (+ -wal/-shm sidecars) into backups/, prune old snapshots. */
export function backupStateDb(fromVersion: string): string | null {
  const db = join(osstackHome(), "state.db");
  if (!existsSync(db)) return null;
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = `state-v${fromVersion}-${stamp}`;
  copyFileSync(db, join(dir, `${base}.db`));
  for (const ext of ["-wal", "-shm"]) {
    if (existsSync(`${db}${ext}`)) copyFileSync(`${db}${ext}`, join(dir, `${base}.db${ext}`));
  }
  // Prune: keep the newest N snapshot groups (lexicographic == chronological).
  const groups = Array.from(new Set(
    readdirSync(dir).filter((f) => f.startsWith("state-v")).map((f) => f.replace(/\.db(-wal|-shm)?$/, "")),
  )).sort();
  for (const g of groups.slice(0, Math.max(0, groups.length - BACKUPS_TO_KEEP))) {
    for (const ext of [".db", ".db-wal", ".db-shm"]) {
      try { rmSync(join(dir, `${g}${ext}`), { force: true }); } catch { /* best effort */ }
    }
  }
  return join(dir, `${base}.db`);
}

async function stopDaemon(rpc: UpgradeOptions["rpc"], viaLaunchd = false): Promise<boolean> {
  log("draining daemon (waiting for active runs, max 60s)…");
  try {
    const response = await rpc("daemon.drain", { timeout_ms: 60_000 }, 70_000) as { ok?: boolean; result?: { drained?: boolean } };
    if (response.ok === false || response.result?.drained === false) { log("ABORT: daemon still has active runs or graph recovery holds"); return false; }
  } catch { /* daemon may be gone; durable graph inventory is checked below */ }
  try { await assertGraphUpgradeSafe(join(osstackHome(), "state.db")); }
  catch (error) { log(`ABORT: ${String(error)}`); return false; }
  if (viaLaunchd) {
    // KeepAlive quiescence (Phase 2.1-D/F2): a plain shutdown would be
    // RESPAWNED by launchd mid-swap — boot the job OUT for the upgrade window.
    // FAIL-CLOSED (review F3): a failed bootout or a still-present socket means
    // the daemon may still be running — the caller must ABORT, not swap.
    const uid = process.getuid?.() ?? 501;
    const out = await run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], 15_000);
    if (!out.ok && !/no such process|not find/i.test(out.output)) {
      log(`launchctl bootout FAILED: ${out.output.slice(0, 120)}`);
      return false;
    }
  } else {
    try { await rpc("daemon.shutdown", undefined, 5_000); } catch { /* expected if it exits fast */ }
  }
  // Wait for the socket to disappear.
  const sock = resolveSocketPath();
  const deadline = Date.now() + 10_000;
  while (existsSync(sock) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (existsSync(sock)) { log("daemon socket still present after stop window"); return false; }
  return true;
}

async function startDaemonAgain(viaLaunchd: boolean): Promise<void> {
  if (viaLaunchd) {
    // Counterpart of the bootout-based stop: re-bootstrap the plist (kickstart
    // as fallback when the job is still loaded).
    log("restarting via launchd bootstrap…");
    const uid = process.getuid?.() ?? 501;
    const plist = daemonPlistPath();
    const boot = await run("launchctl", ["bootstrap", `gui/${uid}`, plist], 15_000);
    if (!boot.ok) await run("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], 15_000);
    return;
  }
  log("starting daemon (detached `osstack serve`)…");
  mkdirSync(logsDir(), { recursive: true });
  const out = openSync(join(logsDir(), "daemon.log"), "a");
  const err = openSync(join(logsDir(), "daemon.error.log"), "a");
  const p = spawn("osstack", ["serve"], { detached: true, stdio: ["ignore", out, err] });
  p.unref();
}

async function waitForDaemon(rpc: UpgradeOptions["rpc"], expectVersion: string | null, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await daemonVersion(rpc);
    if (v !== null && (expectVersion === null || v === expectVersion)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function handleUpgradeCommand(args: string[], rpcFn: UpgradeOptions["rpc"]): Promise<number> {
  // Checkout-based deployments (launchd bin.js outside npm-global) must NOT
  // self-upgrade via npm: the swap would not affect the serving binary and the
  // npm-path recovery branches do not apply (release-review F2-F5 exposure
  // closed operationally; full npm-path hardening tracked for Phase 2.1).
  let plistText: string | null = null;
  let npmRoot: string | null = null;
  try {
    plistText = readFileSync(daemonPlistPath(), "utf8");
  } catch { /* no plist — not a launchd deployment */ }
  {
    const rootResp0 = await run("npm", ["root", "-g"]);
    npmRoot = rootResp0.ok ? rootResp0.output.trim() : null;
  }
  if (plistText !== null && plistText.includes("bin.js") && (npmRoot === null || npmRoot === "" || !plistText.includes(npmRoot))) {
    log("this deployment serves a CHECKOUT dist (not the npm-global package); `osstack upgrade` does not apply — use the checkout deploy flow in PHASE2-RUNBOOK.md");
    return 1;
  }
  // Incident 2026-08-12: provisioning/backup/health-checks must follow the
  // DEPLOYED home, not whatever this shell happens to export.
  alignEnvWithDeployment(plistText, npmRoot);
  const channel = args.includes("--channel")
    ? (args[args.indexOf("--channel") + 1] ?? "latest")
    : "latest";
  const opts: UpgradeOptions = {
    channel,
    dryRun: args.includes("--dry-run"),
    auto: args.includes("--auto"),
    rpc: rpcFn,
  };

  log(`current version: ${VERSION} (channel: ${opts.channel})`);
  const target = await fetchRegistryVersion(PKG, opts.channel);
  if (target === null) {
    log(`could not resolve ${PKG}@${opts.channel} from the npm registry (offline, or package not published yet).`);
    return opts.auto ? 0 : 1;
  }
  if (compareSemver(target, VERSION) <= 0) {
    log(`already up to date (registry has ${target}).`);
    return 0;
  }
  log(`update available: ${VERSION} → ${target}`);
  if (opts.dryRun) {
    log("dry run — stopping here. Plan: drain daemon → backup state.db → npm i -g → restart → health check (rollback on failure).");
    return 0;
  }

  const wasRunning = (await daemonVersion(opts.rpc)) !== null;
  const viaLaunchd = await launchdManaged();
  if (wasRunning || viaLaunchd) {
    const stopped = await stopDaemon(opts.rpc, viaLaunchd);
    if (!stopped) { log("ABORT: could not quiesce the daemon — nothing was swapped."); return 1; }
  }

  try { await assertGraphUpgradeSafe(join(osstackHome(), "state.db")); }
  catch (error) { log(`ABORT: ${String(error)}`); return 1; }
  const backup = backupStateDb(VERSION);
  log(backup ? `state.db backed up → ${backup}` : "no state.db yet; skipping backup");

  log(`installing ${PKG}@${target}…`);
  const install = await run("npm", ["install", "-g", `${PKG}@${target}`]);
  if (!install.ok) {
    log(`npm install failed:\n${install.output}`);
    // The previous package remains installed (no swap happened) — restart it
    // and VERIFY health rather than assuming (F5).
    // npm may have left a PARTIAL swap (review F5): restore the known-good
    // version explicitly, re-verify provisioning, then restart and check.
    const restore = await run("npm", ["install", "-g", `${PKG}@${VERSION}`]);
    if (!restore.ok) {
      log(`restore install of ${VERSION} ALSO failed — daemon left STOPPED. Manual recovery: npm i -g ${PKG}@${VERSION}; backups in ${backupsDir()}`);
      return 1;
    }
    try {
      const rr = await run("npm", ["root", "-g"]);
      if (!rr.ok) throw new Error(`npm root -g failed: ${rr.output.slice(0, 120)}`);
      provisionStableServing(`${rr.output.trim()}/@osstack/cli/dist/bin.js`, process.env["OSSTACK_HOME"] ?? "~/.osstack", CURRENT_SCHEMA_VERSION, { requireBinary: true });
    } catch (err) {
      log(`re-provisioning after restore FAILED: ${err instanceof Error ? err.message : String(err)} — daemon left STOPPED (manual: osstack serve --install)`);
      return 1;
    }
    if (wasRunning || viaLaunchd) {
      await startDaemonAgain(viaLaunchd);
      const ok = await waitForDaemon(opts.rpc, VERSION);
      log(ok ? `previous daemon ${VERSION} healthy again.` : `previous daemon did NOT come back healthy — check ${join(logsDir(), "daemon.error.log")}`);
    }
    return 1;
  }

  // Re-provision the control-plane role next to the NEWLY installed binary
  // BEFORE restarting (round-4 F1; round-5: guard code is STATICALLY imported
  // so npm's replacement of this package's chunks cannot break the call, and
  // an npm-root failure or provisioning failure restores the previous daemon
  // instead of leaving it stopped).
  try {
    const which = await run("npm", ["root", "-g"]);
    if (!which.ok) throw new Error(`npm root -g failed: ${which.output.slice(0, 120)}`);
    const newBin = `${which.output.trim()}/@osstack/cli/dist/bin.js`;
    provisionStableServing(newBin, process.env["OSSTACK_HOME"] ?? "~/.osstack", CURRENT_SCHEMA_VERSION, { requireBinary: true });
  } catch (err) {
    log(`control-plane provisioning after upgrade FAILED: ${err instanceof Error ? err.message : String(err)}`);
    // npm has ALREADY replaced the global package — restarting now would launch
    // the new, unprovisioned binary (round-6). Roll back to the previous
    // version, re-provision it, then restart that.
    log(`ROLLING BACK to ${PKG}@${VERSION} before restart…`);
    const rb = await run("npm", ["install", "-g", `${PKG}@${VERSION}`]);
    if (!rb.ok) {
      log(`rollback install ALSO failed:\n${rb.output}`);
      log(`manual recovery: npm i -g ${PKG}@${VERSION}; backups in ${backupsDir()}`);
      return 1;
    }
    try {
      const rootResp = await run("npm", ["root", "-g"]);
      if (!rootResp.ok) throw new Error(`npm root -g failed: ${rootResp.output.slice(0, 120)}`);
      provisionStableServing(`${rootResp.output.trim()}/@osstack/cli/dist/bin.js`,
        process.env["OSSTACK_HOME"] ?? "~/.osstack", CURRENT_SCHEMA_VERSION, { requireBinary: true });
    } catch (provErr) {
      // Never restart into a binary the guard will refuse (round-7): stop here
      // with explicit manual recovery instead of a doomed kickstart.
      log(`re-provisioning the rolled-back binary FAILED: ${provErr instanceof Error ? provErr.message : String(provErr)}`);
      log(`daemon left STOPPED. Manual recovery: osstack serve --install (provisions + verifies), or fix the role file next to the global dist/bin.js; backups in ${backupsDir()}`);
      return 1;
    }
    if (wasRunning || viaLaunchd) await startDaemonAgain(viaLaunchd);
    return 1;
  }

  if (wasRunning || viaLaunchd) {
    await startDaemonAgain(viaLaunchd);
    const healthy = await waitForDaemon(opts.rpc, target);
    if (!healthy) {
      log(`daemon failed health check on ${target} — ROLLING BACK to ${VERSION}…`);
      // Quiesce before mutating package/DB (review F4): the unhealthy daemon
      // may still be flapping under KeepAlive. If it will NOT quiesce, do not
      // mutate anything under it — stop with manual recovery (round-3 #1).
      const quiesced = await stopDaemon(opts.rpc, viaLaunchd);
      if (!quiesced) {
        log("could not quiesce the unhealthy daemon — NOT touching package or DB while it may be live.");
        log(`Manual recovery — do NOT mutate anything until the daemon is VERIFIED stopped: ${viaLaunchd
          ? `launchctl bootout gui/$UID/${LAUNCHD_LABEL} (repeat until 'no such process')`
          : "stop the daemon process (kill the pid in daemon.pid)"}, confirm the daemon socket is gone AND lsof shows no state.db holders; ONLY THEN: npm i -g ${PKG}@${VERSION}; ${backup ? `restore the snapshot ${backup}` : "delete the newly created state.db(+wal/shm)"}; osstack serve --install.`);
        return 1;
      }
      const rollback = await run("npm", ["install", "-g", `${PKG}@${VERSION}`]);
      if (!rollback.ok) {
        log(`rollback install ALSO failed:\n${rollback.output}`);
        log(`manual recovery: npm i -g ${PKG}@${VERSION}; backups in ${backupsDir()}`);
        return 1;
      }
      // The NEW version may have MIGRATED the DB on its failed boot — the old
      // code would refuse it. Restore the pre-upgrade snapshot (F3).
      if (backup === null) {
        // No DB existed pre-upgrade (review F6): the failed new version may
        // have CREATED one at its own schema — remove it so the restored old
        // version starts fresh instead of refusing a newer schema. Only ENOENT
        // counts as absent; a real I/O failure would leave the foreign-schema
        // DB in place, so STOP instead of restarting over it (round-3 #3).
        const dbP = join(osstackHome(), "state.db");
        for (const f of [dbP, `${dbP}-wal`, `${dbP}-shm`]) {
          try { unlinkSync(f); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              log(`could not remove ${f === dbP ? "the newly created state.db" : "a state.db sidecar"} (${(err as Error).message}) — daemon left STOPPED to avoid booting old code on a newer-schema DB. Manual recovery: remove ${dbP}* then osstack serve --install`);
              return 1;
            }
          }
        }
      }
      if (backup) {
        try {
          const dbP = join(osstackHome(), "state.db");
          copyFileSync(backup, dbP);
          for (const side of ["-wal", "-shm"]) { try { unlinkSync(`${dbP}${side}`); } catch { /* absent */ } }
          log("pre-upgrade state.db snapshot restored");
        } catch (err) {
          log(`WARN: could not restore the pre-upgrade DB snapshot: ${err instanceof Error ? err.message : String(err)}`);
          log(`daemon left STOPPED (old code may refuse a migrated DB). Manual recovery from ${backupsDir()}`);
          return 1;
        }
      }
      // The reinstalled package's tarball never contains the role file — the
      // restored binary must be re-provisioned or the guard refuses the boot
      // we are rolling back TO (round-5 F4; round-8: failure STOPS, never a
      // kickstart into a guard-refused binary).
      try {
        const rootResp = await run("npm", ["root", "-g"]);
        if (!rootResp.ok) throw new Error(`npm root -g failed: ${rootResp.output.slice(0, 120)}`);
        provisionStableServing(`${rootResp.output.trim()}/@osstack/cli/dist/bin.js`,
          process.env["OSSTACK_HOME"] ?? "~/.osstack", CURRENT_SCHEMA_VERSION, { requireBinary: true });
      } catch (err) {
        log(`re-provisioning the rolled-back binary FAILED: ${err instanceof Error ? err.message : String(err)}`);
        log(`daemon left STOPPED. Manual recovery: osstack serve --install (provisions + verifies); backups in ${backupsDir()}`);
        return 1;
      }
      await startDaemonAgain(viaLaunchd);
      const recovered = await waitForDaemon(opts.rpc, VERSION);
      log(recovered
        ? `rolled back to ${VERSION}; daemon healthy again. Investigate before retrying.`
        : `rolled back to ${VERSION} but daemon still not healthy — check ${join(logsDir(), "daemon.error.log")}`);
      return 1;
    }
    log(`daemon healthy on ${target}.`);
  } else {
    log("daemon was not running; skipped restart.");
  }

  log(`upgrade complete: ${VERSION} → ${target}`);
  return 0;
}
