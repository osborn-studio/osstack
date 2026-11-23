import { createLocalFailureDispatch } from './contained-mission-local-failure-dispatch-step.js';
import { createLocalFailureDiagnosis } from './contained-mission-local-failure-diagnose.js';
import { createLocalFailureScan } from './contained-mission-local-failure-scan.js';
import { createLocalFailurePublicationPort } from './contained-mission-local-failure-publication-port.js';

export interface LocalFailureRouteHandle {
  readonly publicationReady: boolean;
  recover(signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

type FactoryDeps = Parameters<typeof createLocalFailureScan>[0] & Parameters<typeof createLocalFailureDiagnosis>[0]
  & Omit<Parameters<typeof createLocalFailureDispatch>[0], 'portsFor'> & Parameters<typeof createLocalFailurePublicationPort>[0];

export async function createLocalFailureRouteService(deps: FactoryDeps): Promise<LocalFailureRouteHandle> {
  const scan = await createLocalFailureScan(deps);
  const diagnosis = await createLocalFailureDiagnosis(deps);
  const dispatch = createLocalFailureDispatch({ ...deps, portsFor: request => diagnosis.portsFor(request) });
  const publication = await createLocalFailurePublicationPort(deps);
  deps.log(publication.ready ? 'osstack: local-failure route: on (read, record, register, diagnose, dispatch, publish)'
    : 'osstack: local-failure route: on (read, record, register, diagnose, dispatch)');
  return {
    publicationReady: publication.ready,
    async recover(signal) { diagnosis.recover(); await publication.recover(signal); },
    start() { scan.start(); diagnosis.start(); dispatch.start(); },
    async stop() {
      const results = await Promise.allSettled([scan, diagnosis, dispatch].map(async service => service.stop()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
  };
}
