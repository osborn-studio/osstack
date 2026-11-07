import type { RevisionChainStore } from '@osstack/core';

export function safeReasonCode(error: unknown): string {
  const raw = error instanceof Error ? error.message.split(':')[0] : 'error';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(raw ?? '') ? raw! : 'error';
}

export function recordChildCancelFailure(
  chains: Pick<RevisionChainStore, 'appendEvent'>, chainId: string, child: string, error: unknown, now: number, principal?: string,
): void {
  try {
    chains.appendEvent(chainId, 'child_cancel_failed', { child, code: safeReasonCode(error), ...(principal ? { principal } : {}) }, now);
  } catch { /* The close is committed; the next sweep retries cancellation. */ }
}
