// Test-only producer; the second authority check occurs after acquiring the lock.
import { readFileSync } from 'node:fs';
import { GraphArtifactStore } from '../../packages/core/dist/graph/artifact-store.js';
const { storeRoot, input } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let checks = 0;
const store = new GraphArtifactStore(storeRoot);
await store.freeze(input, {
  lease: {}, verifyLease: () => {}, verifyImplementationReceipt: () => {},
  verifyProducersStopped: async () => {
    if (++checks === 2) {
      process.send({ kind: 'lock-acquired' });
      await new Promise(() => {});
    }
  },
});
throw Error('FAULT_BARRIER_NOT_REACHED');
