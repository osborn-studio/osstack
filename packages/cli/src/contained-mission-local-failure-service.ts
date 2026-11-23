import { createLocalFailureDispatch } from './contained-mission-local-failure-dispatch-step.js';
import { createLocalFailureDiagnosis } from './contained-mission-local-failure-diagnose.js';
import { createLocalFailureScan } from './contained-mission-local-failure-scan.js';

export interface LocalFailureRouteHandle {
  readonly publicationReady: boolean;
  recover(signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

type FactoryDeps = Parameters<typeof createLocalFailureScan>[0] & Parameters<typeof createLocalFailureDiagnosis>[0]
  & Omit<Parameters<typeof createLocalFailureDispatch>[0], 'portsFor'>;

export async function createLocalFailureRouteService(deps: FactoryDeps): Promise<LocalFailureRouteHandle> {
  const scan = await createLocalFailureScan(deps);
  const diagnosis = await createLocalFailureDiagnosis(deps);
  const dispatch = createLocalFailureDispatch({ ...deps, portsFor: request => diagnosis.portsFor(request) });
  deps.log('osstack: local-failure route: on (read, record, register, diagnose, dispatch)');
  return {
    publicationReady: false,
    async recover() { diagnosis.recover(); },
    start() { scan.start(); diagnosis.start(); dispatch.start(); },
    async stop() {
      const results = await Promise.allSettled([scan, diagnosis, dispatch].map(async service => service.stop()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
  };
}
