import { expect, it } from 'vitest';
import { Annotation, END, START, StateGraph } from './worker-entry.js';

it('executes a tiny StateGraph through the worker kernel boundary', async () => {
  const state = Annotation.Root({ value: Annotation<number>() });
  const graph = new StateGraph(state)
    .addNode('increment', ({ value }) => ({ value: value + 1 }))
    .addEdge(START, 'increment')
    .addEdge('increment', END)
    .compile();

  expect(await graph.invoke({ value: 41 })).toEqual({ value: 42 });
});
