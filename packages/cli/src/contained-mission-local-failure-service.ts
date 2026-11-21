// This is the only caller the route libraries may have. Each later node adds one step and its guard exemption.
export interface LocalFailureRouteHandle {
  recover(signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createLocalFailureRouteService(deps: { log(line: string): void }): LocalFailureRouteHandle {
  deps.log('osstack: local-failure route: on (no steps wired)');
  return {
    async recover() {},
    start() {},
    async stop() {},
  };
}
