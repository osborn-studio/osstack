// Watcher — queries each skill source for the current head SHA at its
// tracked ref, compares to blessed_sha, and reports drift.
//
// Implementation: shell out to `git ls-remote`. Cheap, network-only,
// no clone required. Handles auth via the user's existing git config.

import { spawn } from "node:child_process";
import type { SkillManifest, SkillSource } from "./manifest.js";

export interface DriftEntry {
  source: SkillSource;
  ok: boolean;
  current_sha?: string;
  drifted: boolean;
  reason?: string;
}

export interface CheckResult {
  generated_at: string;
  entries: DriftEntry[];
}

export async function checkSource(src: SkillSource): Promise<DriftEntry> {
  const sha = await lsRemoteHead(src.origin, src.ref);
  if (!sha.ok) {
    return { source: src, ok: false, drifted: false, reason: sha.reason };
  }
  const drifted = src.blessed_sha !== null && src.blessed_sha !== sha.sha;
  return {
    source: src,
    ok: true,
    current_sha: sha.sha,
    drifted: src.blessed_sha === null ? true : drifted,
    ...(src.blessed_sha === null ? { reason: "no_blessed_sha_yet" } : {}),
  };
}

export async function checkAll(manifest: SkillManifest): Promise<CheckResult> {
  const entries = await Promise.all(manifest.sources.map(checkSource));
  return { generated_at: new Date().toISOString(), entries };
}

function lsRemoteHead(origin: string, ref: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", ["ls-remote", origin, ref], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      p.kill("SIGTERM");
      resolve({ ok: false, reason: "timeout" });
    }, 20_000);
    p.stdout.on("data", (c) => { stdout += String(c); });
    p.stderr.on("data", (c) => { stderr += String(c); });
    p.on("error", (err) => {
      clearTimeout(t);
      resolve({ ok: false, reason: `spawn_failed: ${err.message}` });
    });
    p.on("exit", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        resolve({ ok: false, reason: stderr.trim().slice(0, 200) || `git_exit_${code}` });
        return;
      }
      const first = stdout.split(/\r?\n/).find((l) => l.length > 0);
      if (!first) {
        resolve({ ok: false, reason: "no_matching_ref" });
        return;
      }
      const sha = first.split(/\s+/)[0];
      if (typeof sha !== "string" || !/^[0-9a-f]{7,}$/i.test(sha)) {
        resolve({ ok: false, reason: "could_not_parse_sha" });
        return;
      }
      resolve({ ok: true, sha });
    });
  });
}
