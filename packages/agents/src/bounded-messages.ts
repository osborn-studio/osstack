import type { AgentAdapter } from './base.js';
import type { BoundedMessagesOptions } from './adapters/bounded-messages.js';

export type { BoundedMessagesOptions } from './adapters/bounded-messages.js';

/** Explicit host enrollment; never added to the general-purpose agent router. */
export async function createBoundedMessagesAdapter(options: BoundedMessagesOptions): Promise<AgentAdapter> {
  const { BoundedMessagesAdapter } = await import('./adapters/bounded-messages.js');
  return new BoundedMessagesAdapter(options);
}
