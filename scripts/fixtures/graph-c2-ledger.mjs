// TEST ONLY. The caller supplies a row from the fixture's external confirmed
// effect store, NEVER checkpoint state. This is not an authentication service.
export function trustedResult(row, expected) {
  if (!row || row.status !== 'confirmed') throw new Error('reconcile: no confirmed effect');
  for (const key of ['run', 'effect', 'attempt']) {
    if (row[key] !== expected[key]) throw new Error(`identity mismatch: ${key}`);
  }
  if (!row.result || !Array.isArray(row.result.results)
    || row.result.results.length !== 1 || row.result.results[0] !== expected.effect) {
    throw new Error('invalid fixture result');
  }
  return structuredClone(row.result);
}
// Fixture broker gate: confirmed-result lookup may proceed, but unresolved work
// prevents NEW effects anywhere in this run. Production G15 owns real preflight.
export function assertCanStart(rows, run) {
  for (const row of Object.values(rows)) {
    if (row.run !== run) throw new Error('identity mismatch: run');
    if (row.status !== 'confirmed') throw new Error('reconcile: run has unresolved effects');
  }
}
