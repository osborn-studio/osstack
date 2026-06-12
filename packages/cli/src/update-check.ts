// Passive update check — the daemon probes the npm registry at most once per
// 24h and caches the result. Strictly best-effort: offline, timeout, or a
// not-yet-published package all degrade to "no update info", never to an
// error a user can see in the middle of normal work.
//
// Disable entirely with OSSTACK_UPDATE_CHECK=0.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compareSemver, VERSION } from "./version.js";
import { updateCheckCachePath } from "./paths.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 20_000;

export interface UpdateCheckCache {
  checked_at: number;
  current: string;
  latest: string | null;
  update_available: boolean;
  /** Set when the probe failed (offline, E404, timeout). */
  reason?: string;
}

export function updateCheckEnabled(): boolean {
  return process.env["OSSTACK_UPDATE_CHECK"] !== "0";
}

export function readUpdateCache(): UpdateCheckCache | null {
  try {
    const raw = readFileSync(updateCheckCachePath(), "utf8");
    return JSON.parse(raw) as UpdateCheckCache;
  } catch {
    return null;
  }
}

function writeUpdateCache(cache: UpdateCheckCache): void {
  try {
    const path = updateCheckCachePath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch { /* best effort */ }
}

/** `npm view <pkg>@<tag> version` — resolves to null on any failure. */
export function fetchRegistryVersion(pkg: string, tag = "latest"): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn("npm", ["view", `${pkg}@${tag}`, "version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const t = setTimeout(() => { p.kill("SIGTERM"); resolve(null); }, REGISTRY_TIMEOUT_MS);
    p.stdout.on("data", (c) => { out += String(c); });
    p.on("error", () => { clearTimeout(t); resolve(null); });
    p.on("exit", (code) => {
      clearTimeout(t);
      const v = out.trim().split("\n").pop()?.trim() ?? "";
      resolve(code === 0 && /^\d+\.\d+\.\d+/.test(v) ? v : null);
    });
  });
}

/** Run one probe and persist the result. Never throws. */
export async function runUpdateCheck(): Promise<UpdateCheckCache> {
  const latest = await fetchRegistryVersion("@osstack/cli");
  const cache: UpdateCheckCache = {
    checked_at: Date.now() / 1000,
    current: VERSION,
    latest,
    update_available: latest !== null && compareSemver(latest, VERSION) > 0,
    ...(latest === null ? { reason: "registry_unreachable_or_unpublished" } : {}),
  };
  writeUpdateCache(cache);
  return cache;
}

/**
 * Daemon-side scheduler: first probe after a short delay (don't compete with
 * boot), then every 24h. Skips the probe when the cache is fresh. Returns a
 * stop function for clean shutdown. Timers are unref'd so they never hold
 * the process open.
 */
export function startUpdateChecker(): () => void {
  if (!updateCheckEnabled()) return () => { /* disabled */ };
  const probeIfStale = (): void => {
    const cache = readUpdateCache();
    const fresh = cache !== null
      && Date.now() / 1000 - cache.checked_at < UPDATE_CHECK_INTERVAL_MS / 1000;
    if (!fresh) void runUpdateCheck();
  };
  const initial = setTimeout(probeIfStale, 60_000);
  initial.unref();
  const interval = setInterval(probeIfStale, UPDATE_CHECK_INTERVAL_MS);
  interval.unref();
  return () => { clearTimeout(initial); clearInterval(interval); };
}
