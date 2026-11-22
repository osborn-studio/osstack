import { describe, expect, it, vi } from 'vitest';
import { createLocalFailureRouteService } from './contained-mission-local-failure-service.js';
import { assertLocalFailureRouteStartable, parseLocalFailureRouteSwitch } from './contained-mission-local-failure-switch.js';
import { ContainedMissionRpcRequests, ContainedMissionService } from './contained-mission-rpc.js';

describe('local-failure route switch', () => {
  it.each([undefined, '', '0', 'true', 'on', 'yes', ' 1', '1 ', '01', '1'])('parses %j', value => {
    expect(parseLocalFailureRouteSwitch(value)).toBe(value === '1');
  });
  for (const enabled of [false, true]) {
    for (const bridgeMode of ['off', 'shadow', 'live'] as const) {
      it.each([false, true])(`enabled=${enabled}, bridge=${bridgeMode}, automaticMerge=%s`, automaticMerge => {
        const check = () => assertLocalFailureRouteStartable({ enabled, bridgeMode, automaticMerge });
        if (enabled && bridgeMode !== 'live') expect(check).toThrow(new Error('LOCAL_FAILURE_ROUTE_REQUIRES_LIVE_BRIDGE'));
        else if (enabled && automaticMerge) expect(check).toThrow(new Error('LOCAL_FAILURE_ROUTE_MERGE_HOLD_REQUIRED'));
        else expect(check()).toBeUndefined();
      });
    }
  }
});

it('preserves the contained Mission RPC surface', () => {
  // A later node that adds a method must change this list on purpose.
  expect(Object.keys(ContainedMissionRpcRequests).sort()).toEqual([
    'mission.approve_ci_repair', 'mission.cancel', 'mission.chain_decide', 'mission.decide', 'mission.grant_revisions',
    'mission.list', 'mission.merger_report', 'mission.publish_check', 'mission.revision_grant_preview',
    'mission.revision_grant_renew_preview', 'mission.start', 'mission.status',
  ]);
});

it('logs only at assembly, including when stopped before start or twice', async () => {
  const log = vi.fn();
  const scan = { start: vi.fn(), stop: vi.fn(async () => {}) };
  const module = await import('./contained-mission-local-failure-scan.js');
  const factory = vi.spyOn(module, 'createLocalFailureScan').mockResolvedValue(scan as unknown as Awaited<ReturnType<typeof module.createLocalFailureScan>>);
  const diagnosis = { start: vi.fn(), stop: vi.fn(async () => {}), recover: vi.fn(), portsFor: vi.fn(() => null) };
  const diagnose = await import('./contained-mission-local-failure-diagnose.js');
  const diagnosisFactory = vi.spyOn(diagnose, 'createLocalFailureDiagnosis').mockResolvedValue(diagnosis as unknown as Awaited<ReturnType<typeof diagnose.createLocalFailureDiagnosis>>);
  const step = await import('./contained-mission-local-failure-dispatch-step.js');
  const dispatch = { start: vi.fn(), stop: vi.fn(async () => {}) };
  const dispatchFactory = vi.spyOn(step, 'createLocalFailureDispatch').mockReturnValue(dispatch as unknown as ReturnType<typeof step.createLocalFailureDispatch>);
  try {
    const route = await createLocalFailureRouteService({ log } as unknown as Parameters<typeof createLocalFailureRouteService>[0]);
    const request = { request_id: 'synthetic' } as import('@osstack/core/verification-intake').DiagnosisRequest;
    expect(dispatchFactory.mock.calls[0]![0].portsFor(request)).toBeNull();
    expect(diagnosis.portsFor).toHaveBeenCalledWith(request);
    expect(log.mock.calls).toEqual([['osstack: local-failure route: on (read, record, register, diagnose, dispatch)']]);
    await route.recover(new AbortController().signal);
    expect(diagnosis.recover).toHaveBeenCalledOnce();
    expect(scan.start).not.toHaveBeenCalled();
    expect(scan.stop).not.toHaveBeenCalled();
    await route.stop();
    route.start();
    await route.stop();
    await route.stop();
    expect(scan.start).toHaveBeenCalledOnce();
    expect(scan.stop).toHaveBeenCalledTimes(3);
    expect(diagnosis.start).toHaveBeenCalledOnce();
    expect(diagnosis.stop).toHaveBeenCalledTimes(3);
    expect(dispatch.start).toHaveBeenCalledOnce();
    expect(dispatch.stop).toHaveBeenCalledTimes(3);
    let finish!: () => void;
    diagnosis.stop.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    scan.stop.mockRejectedValueOnce(Error('scan'));
    let settled = false;
    const stopping = route.stop().finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(stopping).rejects.toThrow('scan');
    dispatch.stop.mockRejectedValueOnce(Error('dispatch'));
    diagnosis.stop.mockRejectedValueOnce(Error('diagnosis'));
    await expect(route.stop()).rejects.toThrow('diagnosis');
    expect(dispatch.stop).toHaveBeenCalledTimes(5);
  } finally { dispatchFactory.mockRestore(); factory.mockRestore(); diagnosisFactory.mockRestore(); }
  expect(log).toHaveBeenCalledTimes(1);
});

describe('local-failure route lifecycle', () => {
  function fixture(enabled = true) {
    const calls: string[] = [];
    const record = (name: string) => { calls.push(name); };
    const reader = (name: string) => ({
      start: () => record(name), stop: async () => {}, scan: async () => {},
    });
    const route = {
      recover: vi.fn(async (_signal: AbortSignal) => record('route.recover')),
      start: () => record('route.start'),
      stop: vi.fn(async () => record('route.stop')),
    };
    const host = { recover: async () => record('host.recover'), close: async () => record('host.close'), tick: vi.fn(async () => {}) };
    const service = new ContainedMissionService({
      host: host as never, access: {} as never, draining: () => false,
      revisionRecovery: async () => record('receipts'), shadow: reader('shadow'), live: reader('live'),
      stoppedScan: reader('stopped'), checkRetry: reader('retry'), githubCi: reader('ci'), merger: reader('merger'),
      ...(enabled ? { localFailure: route } : {}),
    });
    return { calls, service, route };
  }
  const readers = ['shadow', 'live', 'stopped', 'retry', 'ci', 'merger'];
  it.each([true, false])('orders startup and shutdown with handle=%s', async enabled => {
    const { service, calls } = fixture(enabled);
    try {
      await service.start();
      expect(calls).toEqual(['host.recover', 'receipts', ...(enabled ? ['route.recover'] : []), ...readers,
        ...(enabled ? ['route.start'] : [])]);
    } finally {
      await service.close();
    }
    expect(calls.slice(enabled ? -2 : -1)).toEqual(enabled ? ['route.stop', 'host.close'] : ['host.close']);
  });
  it('propagates recovery failure before starting readers or the tick interval', async () => {
    const { service, route, calls } = fixture();
    const error = Error('recovery failed');
    route.recover.mockRejectedValue(error);
    vi.useFakeTimers();
    try {
      await expect(service.start()).rejects.toBe(error);
      expect(calls).toEqual(['host.recover', 'receipts']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });
  it('aborts pending recovery and skips startup when closed', async () => {
    const { service, route, calls } = fixture();
    let entered!: (signal: AbortSignal) => void;
    const recovering = new Promise<AbortSignal>(resolve => { entered = resolve; });
    route.recover.mockImplementation(signal => new Promise<void>(resolve => {
      entered(signal);
      signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    const starting = service.start();
    const signal = await recovering;
    const closing = service.close();
    expect(signal.aborted).toBe(true);
    await Promise.all([starting, closing]);
    expect(calls).toEqual(['host.recover', 'receipts', 'route.stop', 'host.close']);
  });
  it('closes the host even if the route fails to stop', async () => {
    const { service, route, calls } = fixture();
    const error = Error('stop failed');
    route.stop.mockImplementation(async () => { calls.push('route.stop'); throw error; });
    await expect(service.close()).rejects.toBe(error);
    expect(calls).toEqual(['route.stop', 'host.close']);
  });
});
