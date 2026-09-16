import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type GraphProcessIdentity =
  | { kind: 'linux'; pid: number; pgid: number; bootId: string; startTicks: string }
  | { kind: 'unverifiable'; pid: number; pgid: number | null; platform: string; detail: string };
export type GraphProcessObservation = {
  state: 'running' | 'absent' | 'unknown';
  reason: string;
};
function validPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('GRAPH_PROCESS_PID');
}
function linuxIdentity(pid: number): GraphProcessIdentity {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm can contain spaces and parentheses. Fields after its final ')' start at state (3).
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const pgid = Number(fields[2]); const startTicks = fields[19];
  if (!bootId || !startTicks || !/^\d+$/.test(startTicks) || !Number.isSafeInteger(pgid) || pgid < 1
    || Number(stat.slice(0, stat.indexOf(' '))) !== pid) throw new Error('GRAPH_PROCESS_STAT');
  return { kind: 'linux', pid, pgid, bootId, startTicks };
}
/** Called for the direct child before init. A coarse start timestamp is diagnostic only. */
export function captureGraphProcessIdentity(pid: number): GraphProcessIdentity {
  validPid(pid);
  try {
    if (process.platform === 'linux') return linuxIdentity(pid);
    if (process.platform === 'darwin') {
      const detail = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart='],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'pipe'], env: { LC_ALL: 'C' } }).trim();
      const pgid = Number(detail.split(/\s+/)[0]);
      return { kind: 'unverifiable', pid, pgid: Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null,
        platform: process.platform, detail: `coarse_lstart:${detail}` };
    }
  } catch { /* Missing or denied OS identity must not become a stop proof. */ }
  return { kind: 'unverifiable', pid, pgid: null, platform: process.platform, detail: 'os_identity_unavailable' };
}
export function compareGraphProcessIdentity(saved: GraphProcessIdentity, current: GraphProcessIdentity): GraphProcessObservation {
  if (saved.kind !== 'linux' || current.kind !== 'linux') return { state: 'unknown', reason: 'identity_unverifiable' };
  if (saved.pid !== current.pid || saved.pgid !== current.pgid || saved.bootId !== current.bootId || saved.startTicks !== current.startTicks) {
    return { state: 'unknown', reason: 'identity_mismatch' };
  }
  return { state: 'running', reason: 'same_linux_process' };
}
/** Read-only leader observation. Never proves descendants or opaque adapter effects stopped. */
export function observeGraphProcessIdentity(saved: GraphProcessIdentity): GraphProcessObservation {
  try { validPid(saved.pid); } catch { return { state: 'unknown', reason: 'identity_invalid' }; }
  if (saved.kind !== 'linux' || process.platform !== 'linux') return { state: 'unknown', reason: 'identity_unverifiable' };
  try {
    if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== saved.bootId) return { state: 'unknown', reason: 'boot_identity_mismatch' };
    try { return compareGraphProcessIdentity(saved, linuxIdentity(saved.pid)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent', reason: 'leader_absent_only' };
      throw error;
    }
  } catch { return { state: 'unknown', reason: 'os_identity_unavailable' }; }
}
