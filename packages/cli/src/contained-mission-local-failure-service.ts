import { createLocalFailureDiagnosis } from './contained-mission-local-failure-diagnose.js';
import { createLocalFailureScan } from './contained-mission-local-failure-scan.js';

export interface LocalFailureRouteHandle {
  recover(signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export async function createLocalFailureRouteService(deps: Parameters<typeof createLocalFailureScan>[0] & Parameters<typeof createLocalFailureDiagnosis>[0]): Promise<LocalFailureRouteHandle> {
  const scan = await createLocalFailureScan(deps);
  const diagnosis = await createLocalFailureDiagnosis(deps);
  deps.log('osstack: local-failure route: on (read, record, register, diagnose)');
  return {
    async recover() { diagnosis.recover(); },
    start() { scan.start(); diagnosis.start(); },
    async stop() {
      const results = await Promise.allSettled([scan, diagnosis].map(async service => service.stop()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
  };
}
