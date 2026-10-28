# Fixed method verification journey

This tool turns the existing skills-check driver into a reusable two-feature journey. It runs doctor, runs healthy and missing-ref against real local Git fixtures, verifies retained evidence, and writes a two-row feature map. It does not invoke a model or claim native skill selection.

After the normal frozen install and build, select a new absolute output directory beneath `OSSTACK_SCRATCH_ROOT`. Its parent must exist. For example:

```sh
export OSSTACK_SCRATCH_ROOT=/absolute/scratch/osstack
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"
node scripts/method-verification-journey.mjs --output "$OSSTACK_SCRATCH_ROOT/runtime/new-journey"
```

The command refuses existing output, including symlinks. It writes only the newly owned output tree. The actual driver receives a minimal environment, explicit isolated OSSTACK_HOME and its own scratch root. No default database, user Git repository, global host settings or live provider is used. The output contains raw doctor/driver stdout, stderr and exit records, the original per-case evidence directories, `journey.json`, `journey-manifest.json` and `feature-map.md`. Evidence survives fixture removal. Failure stops the remaining case and preserves existing evidence; use a new output for a later attempt.

Healthy requires product exit0. Missing-ref requires product exit1 and an unreachable ref; this source has not recovered. The underlying driver exits0 when the expected result, input preservation and its cleanup predicates pass. This wrapper additionally verifies the receipt bytes, complete retained-file manifest, required raw records, fixed case expectations, source/build binding digests, raw behavior, and actual owned fixture absence. Overall exit0 requires both features to pass. Exit1 means a failed or blocked journey; exit2 is invalid CLI usage.

The tool only accepts `--output`. It does not accept arbitrary commands, case IDs, repositories or model-generated shell strings. Doctor has a30-second outer limit. Each driver has a180-second outer limit; its existing90-second command-sequence budget does not bound all filesystem work. On outer timeout the direct driver is killed, uncertainty is retained, and no clean process-tree claim is made. The wrapper never deletes a possibly live failed fixture.

A verified manifest establishes retained-file consistency, not an authenticated oracle or historical truth. Build digests alone do not prove a compiler invocation; retain the real build log separately. Direct child exits plus fixture removal do not prove all descendants terminated. Reports keep `descendant_termination:not_attested`. The omitted drift/mixed/empty cases remain unrun. No J03, MethodBinding, provider, principal, native-host or runtime qualification is issued.

Run focused tests with `node --test scripts/method-verification-journey.test.mjs`. Offline fixtures test verifier rejection and stop behavior; they are not product observations. Actual journey evidence must come from a built checkout. Host-assisted and native-execution experiments can consume this tool later, with their own frozen inputs, permissions and budgets. Earlier native help failures are not retried by this command.
