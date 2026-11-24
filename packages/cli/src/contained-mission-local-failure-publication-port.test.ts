import type { ContainedMission, ContainedMissionStore } from '@osstack/core';
import { describe, expect, it, vi } from 'vitest';
import { ContainedMissionHost } from './contained-mission-host.js';
import type { ContainedMissionHostPorts } from './contained-mission-ports.js';
import * as publication from './contained-mission-local-failure-publication-port.js';
import { createLocalFailureRouteService } from './contained-mission-local-failure-service.js';
import * as scan from './contained-mission-local-failure-scan.js';
import * as diagnosis from './contained-mission-local-failure-diagnose.js';
import * as recheck from './contained-mission-local-failure-recheck-step.js';
import * as dispatch from './contained-mission-local-failure-dispatch-step.js';

const unexpected = async (): Promise<never> => { throw Error('unexpected port'); };
function fixture() {
  const adapters = { runner: { gated: true as const, run: unexpected }, preflight: unexpected, localGit: unexpected };
  const ports = {} as ContainedMissionHostPorts;
  ports.revisionPublicationAdapters = async () => adapters;
  const deps: Parameters<typeof publication.createLocalFailurePublicationPort>[0] = {
    ports, missions: {} as ContainedMissionStore, access: { refresh: () => { throw Error('unexpected refresh'); } },
    host: { resumeConfirmedLocalPublication: unexpected }, repository: 'fixture/repo', enabled: () => true, now: () => 1, log: vi.fn(),
  };
  return { deps, ports, adapters };
}

describe('publication port readiness', () => {
  it.each(['no adapters', 'no repository', 'bad repository', 'already attached'])('refuses %s', async condition => {
    const { deps, ports } = fixture();
    let reason = 'repository_required';
    if (condition === 'no adapters') { delete ports.revisionPublicationAdapters; reason = 'publication_adapters_required'; }
    if (condition === 'no repository') delete deps.repository;
    if (condition === 'bad repository') deps.repository = 'a/b/c';
    if (condition === 'already attached') { ports.localFailurePublication = { publish: unexpected }; reason = 'port_already_attached'; }
    const before = ports.localFailurePublication;
    const result = await publication.createLocalFailurePublicationPort(deps);
    expect(result.ready).toBe(false);
    expect(ports.localFailurePublication).toBe(before);
    await result.recover(new AbortController().signal);
    expect(vi.mocked(deps.log).mock.calls).toEqual([[`osstack: local-failure route: publication port unavailable (${reason})`]]);
  });

  it('propagates adapter failure and refuses an ungated runner', async () => {
    const { deps, ports, adapters } = fixture();
    const failure = Error('adapter configuration');
    ports.revisionPublicationAdapters = async () => { throw failure; };
    await expect(publication.createLocalFailurePublicationPort(deps)).rejects.toBe(failure);
    expect(ports.localFailurePublication).toBeUndefined();
    ports.revisionPublicationAdapters = async () => ({ ...adapters, runner: { run: unexpected } });
    await expect(publication.createLocalFailurePublicationPort(deps)).rejects.toThrow('CONTAINED_PUBLICATION_UNGATED');
    expect(ports.localFailurePublication).toBeUndefined();
  });

  it('attaches the publisher once even when two factories start together', async () => {
    const { deps, ports } = fixture();
    const results = await Promise.all([publication.createLocalFailurePublicationPort(deps), publication.createLocalFailurePublicationPort(deps)]);
    expect(results.map(r => r.ready)).toEqual([true, false]);
    expect(typeof ports.localFailurePublication?.publish).toBe('function');
    expect(vi.mocked(deps.log).mock.calls).toEqual([['osstack: local-failure route: publication port unavailable (port_already_attached)']]);
  });
});

it.each([false, true])('assembles and recovers the service with ready=%s', async ready => {
  const calls: string[] = [];
  const recover = vi.fn(async (_signal: AbortSignal) => { calls.push('publication'); });
  const { deps } = fixture();
  try {
    vi.spyOn(scan, 'createLocalFailureScan').mockResolvedValue({} as Awaited<ReturnType<typeof scan.createLocalFailureScan>>);
    vi.spyOn(diagnosis, 'createLocalFailureDiagnosis').mockResolvedValue({
      recover: () => { calls.push('diagnosis'); },
    } as Awaited<ReturnType<typeof diagnosis.createLocalFailureDiagnosis>>);
    vi.spyOn(recheck, 'createLocalFailureRecheck').mockReturnValue({
      recover: () => { calls.push('recheck'); },
    } as ReturnType<typeof recheck.createLocalFailureRecheck>);
    vi.spyOn(dispatch, 'createLocalFailureDispatch').mockReturnValue({} as ReturnType<typeof dispatch.createLocalFailureDispatch>);
    vi.spyOn(publication, 'createLocalFailurePublicationPort').mockResolvedValue({ ready, recover });
    const service = await createLocalFailureRouteService(deps as Parameters<typeof createLocalFailureRouteService>[0]);
    expect(service.publicationReady).toBe(ready);
    expect(vi.mocked(deps.log).mock.calls).toEqual([[`osstack: local-failure route: on (read, record, register, diagnose, dispatch${ready ? ', publish' : ''}, recheck)`]]);
    const signal = new AbortController().signal;
    await service.recover(signal);
    expect(calls).toEqual(['diagnosis', 'recheck', 'publication']);
    expect(recover).toHaveBeenCalledWith(signal);
  } finally { vi.restoreAllMocks(); }
});

it('tracks resume and refuses it during an in-flight step', async () => {
  const { ports } = fixture();
  const child = { mission_id: 'fixture', state: 'revalidating' } as ContainedMission;
  ports.store = { listOutstanding: () => [child], get: () => child, atDepthLimit: () => false } as unknown as ContainedMissionStore;
  const host = new ContainedMissionHost({ ports });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(host.runner, 'step').mockImplementation(async () => { await gate; return child; });
  const ticking = host.tick();
  await expect(host.resumeConfirmedLocalPublication(child.mission_id)).rejects.toThrow('CONTAINED_MISSION_BUSY');
  finish();
  await ticking;
  vi.spyOn(host.runner, 'resumeConfirmedLocalPublication').mockImplementation(async id => {
    expect(host.isBusy(id)).toBe(true);
    return child;
  });
  expect(await host.resumeConfirmedLocalPublication(child.mission_id)).toBe(child);
  expect(host.isBusy(child.mission_id)).toBe(false);
});
