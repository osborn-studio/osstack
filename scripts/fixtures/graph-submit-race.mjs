// Separate OS process for simultaneous SQLite admission; no executor is launched.
import { readFileSync } from 'node:fs';
import { openDb, GraphRunStore } from '../../packages/core/dist/index.js';
const { path, request, version } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const db = openDb({ path }); const runs = new GraphRunStore(db);
process.once('message', message => {
  if (message !== 'go') throw Error('INVALID_BARRIER');
  try {
    const run = runs.create(request, version, Date.now());
    process.send({ kind: 'created', graphRunId: run.graphRunId });
  } catch (error) { process.send({ kind: 'rejected', error: String(error) }); }
  finally { db.close(); process.disconnect(); }
});
process.send({ kind: 'ready' });
