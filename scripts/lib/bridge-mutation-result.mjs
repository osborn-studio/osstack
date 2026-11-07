// A test failure kills a mutant only when the failure is an actual assertion.
// Resource, launcher, import and unhandled failures invalidate the experiment.
export function classifyMutationResult({ status, signal, error, output }) {
  const plain = String(output ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const infrastructureFailure = /Test timed out|Hook timed out|Timeout calling|ERR_TEST_TIMEOUT|ETIMEDOUT|SIGKILL|SIGTERM|SIGINT|SIGABRT|SIGSEGV|Unhandled Errors?|Transform failed|Failed to load|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNKNOWN_FILE_EXTENSION|Failed to start|Worker exited unexpectedly|Parse failure/i.test(plain)
    || /^\s*(?:TypeError|ReferenceError|SyntaxError|RangeError|AggregateError):/m.test(plain);
  if (signal || error || infrastructureFailure || !Number.isInteger(status)) return 'invalid';
  if (status === 0) return 'survived';
  if (status !== 1) return 'invalid';
  const failedTest = /^\s*FAIL\s+src\/[^\n]+ >[^\n]*/m.test(plain);
  const assertion = /^\s*AssertionError(?:\s*\[[^\]]+\])?:/m.test(plain);
  return failedTest && assertion ? 'killed' : 'invalid';
}
