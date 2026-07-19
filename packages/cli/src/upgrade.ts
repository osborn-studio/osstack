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
import { provisionStableServing } from "./control-plane-guard.js";
import { CURRENT_SCHEMA_VERSION } from "@osstack/core";
import {
  copyFileSync, existsSync, mkdirSync, openSync, readdirSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { backupsDir, logsDir, osstackHome, resolveSocketPath } from "./paths.js";
import { compareSemver, VERSION } from "./version.js";
import { fetchRegistryVersion } from "./update-check.js";

const PKG = "@osstack/cli";
const LAUNCHD_LABEL = "ai.osstack.daemon";
const BACKUPS_TO_KEEP = 5;

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

async function stopDaemon(rpc: UpgradeOptions["rpc"]): Promise<void> {
  log("draining daemon (waiting for active runs, max 60s)…");
  try { await rpc("daemon.drain", { timeout_ms: 60_000 }, 70_000); } catch { /* daemon may be gone */ }
  try { await rpc("daemon.shutdown", undefined, 5_000); } catch { /* expected if it exits fast */ }
  // Wait for the socket to disappear.
  const sock = resolveSocketPath();
  const deadline = Date.now() + 10_000;
  while (existsSync(sock) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function startDaemonAgain(viaLaunchd: boolean): Promise<void> {
  if (viaLaunchd) {
    log("restarting via launchd kickstart…");
    const uid = process.getuid?.() ?? 501;
    await run("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], 15_000);
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
  if (wasRunning) await stopDaemon(opts.rpc);

  const backup = backupStateDb(VERSION);
  log(backup ? `state.db backed up → ${backup}` : "no state.db yet; skipping backup");

  log(`installing ${PKG}@${target}…`);
  const install = await run("npm", ["install", "-g", `${PKG}@${target}`]);
  if (!install.ok) {
    log(`npm install failed:\n${install.output}`);
    if (wasRunning) await startDaemonAgain(viaLaunchd);
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
    if (wasRunning) await startDaemonAgain(viaLaunchd);
    return 1;
  }

  if (wasRunning || viaLaunchd) {
    await startDaemonAgain(viaLaunchd);
    const healthy = await waitForDaemon(opts.rpc, target);
    if (!healthy) {
      log(`daemon failed health check on ${target} — ROLLING BACK to ${VERSION}…`);
      const rollback = await run("npm", ["install", "-g", `${PKG}@${VERSION}`]);
      if (!rollback.ok) {
        log(`rollback install ALSO failed:\n${rollback.output}`);
        log(`manual recovery: npm i -g ${PKG}@${VERSION}; backups in ${backupsDir()}`);
        return 1;
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
