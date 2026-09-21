/**
 * Heavy kernel entry for worker-side consumers only. Legacy SDK exports remain
 * compatible; the explicit child launch flag enables the bounded IPC runtime.
 */
export { Annotation, Command, END, START, StateGraph, entrypoint, interrupt, task } from '@langchain/langgraph';
export { GRAPH_KERNEL } from './index.js';
export { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export { runGraphWorker } from './worker-runtime.js';
export type { GraphWorkerProgram, GraphWorkerProgramContext } from './worker-runtime.js';
export { GraphWorkerClient } from './worker-client.js';

// Import compatibility is preserved: only the explicitly launched child listens.
import { pathToFileURL } from 'node:url';
import { runGraphWorker } from './worker-runtime.js';
if (process.argv[2] === '--osstack-graph-worker' && process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url) runGraphWorker();
