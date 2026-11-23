import type { ContainedMissionStore } from '@osstack/core';
import type { EngineeringAccess } from './engineering-access.js';
import type { ContainedMissionHost } from './contained-mission-host.js';
import type { ContainedMissionHostPorts } from './contained-mission-ports.js';
import { defaultGhExec, ghGraphqlTransport } from './contained-mission-bridge-reader.js';
import { readRevisionPr, type RevisionPrFacts } from './contained-mission-revision-publication.js';

interface Dependencies {
  missions: ContainedMissionStore;
  ports: ContainedMissionHostPorts;
  host: Pick<ContainedMissionHost, 'resumeConfirmedLocalPublication'>;
  access: Pick<EngineeringAccess, 'refresh'>;
  enabled(): boolean;
  now(): number;
  log(line: string): void;
  repository?: string;
  readPr?(repository: string, number: number, signal: AbortSignal): Promise<RevisionPrFacts>;
}

export async function createLocalFailurePublicationPort(deps: Dependencies) {
  const { ports, repository, missions } = deps;
  const unavailable = (reason: string) => {
    deps.log(`osstack: local-failure route: publication port unavailable (${reason})`);
    return { ready: false, recover: async (_signal: AbortSignal) => {} };
  };
  if (!ports.revisionPublicationAdapters) return unavailable('publication_adapters_required');
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return unavailable('repository_required');
  if (ports.localFailurePublication) return unavailable('port_already_attached');
  const { runner } = await ports.revisionPublicationAdapters();
  if (runner.gated !== true) throw Error('CONTAINED_PUBLICATION_UNGATED');

  const libraryDeps: Parameters<typeof import('./contained-mission-local-failure-publish.js').publishLocalFailureRepair>[1] = {
    store: missions, host: ports.hostProcesses, runner, now: deps.now, enabled: deps.enabled, repository,
    refresh: (principal, session) => deps.access.refresh(principal, session),
    async readPr(target, signal) {
      signal.throwIfAborted();
      const facts = deps.readPr ? await deps.readPr(repository, target.pr, signal)
        : await readRevisionPr(repository, target.pr, ghGraphqlTransport((args, call) => defaultGhExec(args, {
          ...call, signal: call.signal ? AbortSignal.any([call.signal, signal]) : signal,
        })));
      signal.throwIfAborted();
      if (facts.repository.toLowerCase() !== repository.toLowerCase() || facts.headRefName !== target.branch) return null;
      return { state: facts.state.toLowerCase(), head: { sha: facts.headRefOid }, base: { sha: facts.baseRefOid } };
    },
  };
  // Another factory can finish while the adapters are loading.
  if (ports.localFailurePublication) return unavailable('port_already_attached');
  ports.localFailurePublication = {
    publish: input => ports.hostProcesses.guard(input.mission.mission_id, async () => {
      if (!input.spec.local_failure_repair || input.spec.publication?.remote !== 'origin') throw Error('verify_publish_authority_invalid');
      const { publishLocalFailureRepair } = await import('./contained-mission-local-failure-publish.js');
      return publishLocalFailureRepair(input, libraryDeps);
    }),
  };
  return {
    ready: true,
    async recover(signal: AbortSignal) {
      if (signal.aborted) return;
      const rows = missions.db.prepare(`SELECT m.mission_id, EXISTS (
        SELECT 1 FROM engineering_contained_events WHERE mission_id=m.mission_id AND kind='verify_repair_push_confirmed'
      ) AS confirmed FROM engineering_contained_missions m
      WHERE json_type(m.spec_json,'$.local_failure_repair')='object' AND (confirmed=0 OR m.state='awaiting_decision')
        AND EXISTS (SELECT 1 FROM engineering_contained_events WHERE mission_id=m.mission_id AND kind='verify_repair_push_intent')
      ORDER BY m.created_at,m.mission_id`).all() as { mission_id: string; confirmed: number }[];
      const { reconcileLocalFailurePush } = await import('./contained-mission-local-failure-publish.js');
      for (const { mission_id: id, confirmed } of rows) {
        if (signal.aborted) break;
        if (!confirmed) {
          const outcome = await reconcileLocalFailurePush(id, libraryDeps, signal);
          if (outcome !== 'confirmed') {
            deps.log(`osstack: local-failure route: reconcile ${id}: ${outcome}`);
            continue;
          }
        }
        if (signal.aborted) break;
        if (missions.get(id).state !== 'awaiting_decision') continue;
        try { await deps.host.resumeConfirmedLocalPublication(id); }
        catch (error) { deps.log(`osstack: local-failure route: resume ${id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    },
  };
}
