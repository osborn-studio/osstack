// W13-C1: the Mission side of the host child-process ledger. Builds the write gate every covered local git write goes
// through (docs/design/2026-11-06-w13-host-git-survival.md sections 4.3, 5.5, 6.1). No process or ledger logic lives here
// beyond wiring: the launcher is `runGatedProcess` (agents), the rows are `HostProcessStore` (core).
import { HostProcessUnprovenError, createHostProcessProbe, currentBootSession, gatedGit, type AgentHostProcessKind, type HardenedGitGate, type HostProcessProbe, type LocalWriteGate } from '@osstack/agents';
import { HostProcessStore, type HostProcessRecord, type ContainedEvent, type ContainedMission, type ContainedMissionStore } from '@osstack/core';

export interface HostProcessKitOptions {
  /** `$OSSTACK_HOME/contained/host-processes`: hold markers live here, not under the scratch root (design section 4.1). */
  markerDir: string;
  /** Observation-only probes (default: the real `ps`/`lsof`/`kill -0` ones). Tests inject doubles; nothing here ever signals. */
  probe?: HostProcessProbe;
  /** Overrides the boot session identity (tests). */
  bootId?: string;
}

/** Where a recovered Mission goes once every one of its host processes is proven stopped (design section 5.5). */
export type HostProcessRoute = 'delivering' | 'authorized' | 'default';
export const HOST_PROCESS_UNPROVEN_PREFIX = 'host_process_unproven:';
export const WORKSPACE_RECOVERED = 'workspace_recovered';
export const PUBLICATION_RECOVERED = 'publication_failed:host_process_recovered';
export const WORKSPACE_RECOVERY_FAILED = 'workspace_failed:host_process_recovered';

/**
 * The route a Mission is on when its host processes become unknown. It is recorded on the `halted` event, so a second crash
 * while the Mission sits in a recovery exit (`awaiting_decision` with one of the recovered reasons) keeps its way back.
 */
export function hostProcessRouteOf(state: ContainedMission['state'], haltReason: string | undefined): HostProcessRoute {
  if (state === 'delivering') return 'delivering';
  if (state === 'authorized') return 'authorized';
  if (state === 'awaiting_decision') {
    if (haltReason === WORKSPACE_RECOVERED) return 'authorized';
    if (haltReason?.startsWith(PUBLICATION_RECOVERED)) return 'delivering';
  }
  return 'default';
}

/**
 * True while the open stop obligation was set only by a host process that was unproven (a `host_process_unproven` halt that
 * owed nothing before it, with no executor turn or verification started since). A cancel or a second halt must keep that
 * fact, or a Mission that never ran an executor would be asked for executor proof it can never give.
 */
export function hostOnlyObligation(events: readonly ContainedEvent[]): boolean {
  const parse = (e: ContainedEvent): Record<string, unknown> => { try { return JSON.parse(e.payload_json) as Record<string, unknown>; } catch { return {}; } };
  const at = events.map(e => e.kind).lastIndexOf('halted');
  if (at < 0) return false;
  const halt = parse(events[at]!);
  if (typeof halt.reason !== 'string' || !halt.reason.startsWith(HOST_PROCESS_UNPROVEN_PREFIX) || halt.prior_obligation !== 0) return false;
  return !events.slice(at + 1).some(e => { const to = parse(e).to; return to === 'executing' || to === 'verifying'; });
}

/** The op id of a gated launch whose process could not be proven stopped, otherwise undefined. */
export function unprovenOpId(error: unknown): string | undefined {
  return error instanceof HostProcessUnprovenError ? error.opId : undefined;
}

export class HostProcessKit {
  readonly hp: HostProcessStore;
  readonly markerDir: string;
  readonly probe: HostProcessProbe;
  private boot: string | undefined;
  constructor(private readonly store: ContainedMissionStore, private readonly options: HostProcessKitOptions, now: () => number) {
    this.hp = new HostProcessStore(store.attention, store.owner, { clock: now });
    this.markerDir = options.markerDir;
    this.probe = options.probe ?? createHostProcessProbe();
  }

  /** The daemon's boot session, read once. `unknown` turns rule 0 of the classifier off. */
  bootId(): string {
    this.boot ??= this.options.bootId ?? currentBootSession() ?? 'unknown';
    return this.boot;
  }

  /** The gate for one Mission's local writes. `fence` runs synchronously inside every release transaction. */
  gate(missionId: string, fence: () => void): LocalWriteGate {
    return { journal: this.hp, markerDir: this.markerDir, mission_id: missionId, boot_id: this.bootId(), probe: this.probe, fence };
  }

  /** A hardened-git gate for a command the ports run themselves. */
  hardened(missionId: string, fence: () => void, kind: AgentHostProcessKind, localTarget: string): { gate: HardenedGitGate } {
    return gatedGit(this.gate(missionId, fence), kind, localTarget) as { gate: HardenedGitGate };
  }

  hasOpen(missionId: string): boolean { return this.hp.hasOpen(missionId); }
  /** The op id of one record of the Mission that is not proven stopped, if any. */
  openOpId(missionId: string): string | undefined { return this.hp.open(missionId)[0]?.op_id; }
  /**
   * True when a remote write (push or PR creation) of the Mission was released at or after `since`: the release record decides whether the
   * remote can have been written. No release means git or gh never ran, whatever else failed.
   */
  remoteReleasedSince(missionId: string, since: number): boolean {
    return this.store.db.prepare("SELECT 1 FROM engineering_host_processes WHERE mission_id=? AND kind IN ('git_push','gh_pr_create') AND released_at IS NOT NULL AND created_at>=? LIMIT 1").get(missionId, since) !== undefined;
  }
  /** The ledger row bound to a phase 5 push intent (the op id is the row's own, never the intent id). */
  recordForIntent(intentId: string): HostProcessRecord | undefined {
    return this.store.db.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(intentId) as HostProcessRecord | undefined;
  }

  /**
   * Runs one covered write sequence. Any failure that leaves a row open (a stop record that could not be written, a proof
   * that did not hold) surfaces as `HostProcessUnprovenError`, whatever error the launcher raised first, so the caller
   * stops the Mission in `stop_unknown` instead of offering a decision that would write the branch again.
   */
  async guard<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) {
      if (error instanceof HostProcessUnprovenError) throw error;
      let open: ReturnType<HostProcessStore['open']> = [];
      try { open = this.hp.open(missionId); } catch { /* a stale owner cannot read: the original failure stands */ }
      const first = open[0];
      if (first !== undefined) throw new HostProcessUnprovenError(first.op_id, first.released_at !== null);
      throw error;
    }
  }
}
