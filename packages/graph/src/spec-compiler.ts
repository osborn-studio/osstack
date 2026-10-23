// Current compiler entrypoint. Historical resolution imports the frozen implementation directly.
export { GRAPH_COMPILER_VERSION, compileGraphSpec, validateGraphPlan } from './legacy/code-delivery-v4.js';
export type { GraphInputMapping, GraphPlanNode, GraphPlan, CompiledGraphSpec } from './legacy/code-delivery-v4.js';
