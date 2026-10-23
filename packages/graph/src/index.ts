/** Pinned kernel identity; safe to inspect in the CLI or daemon main process. */
export const GRAPH_KERNEL = Object.freeze({
  engine: 'langgraph',
  version: '1.4.15',
  coreVersion: '1.2.11',
  checkpointVersion: '1.1.5',
  workerEntry: '@osstack/graph/worker',
} as const);

// Only serializable protocol types cross the worker boundary. Type exports are
// erased so this entry does not load protocol validators or any runtime SDK.
export type {
  GraphSpecV1,
  WorkerActionRequest,
  WorkerActionResponse,
} from '@osstack/protocol';
