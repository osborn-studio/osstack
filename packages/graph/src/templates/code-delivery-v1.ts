import { GRAPH_REGISTRY } from '../registry.js';
import type { CompiledGraphSpec } from '../spec-compiler.js';

/** All host slots and reservation ceilings come from the exact compiled plan. */
export function deliveryEpoch(compiled: CompiledGraphSpec, epoch: number) {
  const nodes = compiled.plan.nodes.filter(node => node.epoch === epoch);
  if (!nodes.length) throw Error('EPOCH_BUDGET_EXHAUSTED');
  const node = (name: string) => {
    const value = nodes.find(n => n.id === `e${epoch}.${name}`);
    if (!value) throw Error('UNREGISTERED_DELIVERY_NODE');
    return { ...value, tokenReservation: GRAPH_REGISTRY.nodes[value.operation].reservedTokens };
  };
  const cost = (items: typeof nodes) => items.reduce((sum, n) => ({
    actions: sum.actions + (GRAPH_REGISTRY.nodes[n.operation].tool === 'pure' ? 0 : n.maxLedgerAttempts),
    tokens: sum.tokens + GRAPH_REGISTRY.nodes[n.operation].reservedTokens * n.maxLedgerAttempts,
  }), { actions: 0, tokens: 0 });
  const preparationSlot = (kind: 'review' | 'tests', attempt: number) => {
    const selected = node(`prepare_${kind}`);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > selected.maxLedgerAttempts) throw Error('BRANCH_BUDGET_EXHAUSTED');
    return attempt === 1 ? selected.effectSlot : `retry-${attempt}`;
  };
  return { node, preparationSlot, cost: cost(nodes), slots: { review: { nodeId: node('review').id, effectSlot: node('review').effectSlot },
    tests: { nodeId: node('tests').id, effectSlot: node('tests').effectSlot } }, nextCost: {
    repair: cost(compiled.plan.nodes.filter(n => n.epoch === epoch + 1).length ? compiled.plan.nodes.filter(n => n.epoch === epoch + 1) : nodes),
    review: cost([node('prepare_review'), node('review')].map(n => ({ ...n, maxLedgerAttempts: 1 }))),
    tests: cost([node('prepare_tests'), node('tests')].map(n => ({ ...n, maxLedgerAttempts: 1 }))),
  } };
}
