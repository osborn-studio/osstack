export function parseLocalFailureRouteSwitch(value: string | undefined): boolean {
  return value === '1';
}

export function assertLocalFailureRouteStartable(input: {
  enabled: boolean;
  bridgeMode: 'off' | 'shadow' | 'live';
  automaticMerge: boolean;
}): void {
  if (!input.enabled) return;
  if (input.bridgeMode !== 'live') throw new Error('LOCAL_FAILURE_ROUTE_REQUIRES_LIVE_BRIDGE');
  if (input.automaticMerge) throw new Error('LOCAL_FAILURE_ROUTE_MERGE_HOLD_REQUIRED');
}
