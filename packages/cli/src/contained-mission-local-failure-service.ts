import { createLocalFailureScan } from './contained-mission-local-failure-scan.js';

export interface LocalFailureRouteHandle {
  recover(signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export async function createLocalFailureRouteService(deps: Parameters<typeof createLocalFailureScan>[0]): Promise<LocalFailureRouteHandle> {
  const scan = await createLocalFailureScan(deps);
  deps.log('osstack: local-failure route: on (read, record, register)');
  return { async recover() {}, start: () => scan.start(), stop: () => scan.stop() };
}
