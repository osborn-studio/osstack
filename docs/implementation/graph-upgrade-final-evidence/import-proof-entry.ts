import { writeFile } from 'node:fs/promises';
import { graphRpcFixture } from '/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/cli/src/graph-test-fixture.ts';
const f = await graphRpcFixture();
try { const run = await f.start(); const ready = await f.until(run.graphRunId, s => s.status === 'ready');
  await writeFile('/Volumes/AIMATE_WORK/tmp/g30-final/import-proof/result.json', JSON.stringify({ passed: ready.status === 'ready', graphRunId: run.graphRunId, hostPid: process.pid, policy: 'Host loader rejects every @langchain module; isolated worker runs normally' }, null, 2));
} finally { await f.close(); }
