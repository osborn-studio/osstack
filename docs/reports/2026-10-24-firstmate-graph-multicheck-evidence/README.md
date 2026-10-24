# Graph multi-check evidence

The native Graph integration suite passed 19 tests; related broker/join/contained-recovery/host regressions passed153; five new boundary cases passed (actual native and container-engine HTTP fixture invocation, including sixteen commands with escaped text crossing64KiB). Final complete verification suite replay passed46/46 with unchanged deadlines (279.16seconds on the shared development host); see graph-verification-final.log. CLI strict typecheck and Biome passed.

Initial concurrent integration run timed out; unchanged-deadline isolated rerun passed. The first16-check boundary exposed the old aggregate64KiB validator; host suite files now have a256KiB limit with each component validated using existing boundedJSON; wire and single-check budgets are unchanged. Initial failing runs are not qualification passes.

Claude CLI round1 completed with is_error:false and no confirmedP0/P1. Requested claude-haiku-5-5; modelUsage reports that identifier, but stderr reports unrecognized_model, so model weights are not independently attested. It is static review only. P2 disposition: outputcompaction is called beforepublication; size limit now separately qualified with16 actual invocations; uncertain later-stop diagnostics are rejected; revoked/cancelled preinvocation remains failclosed. Subsequent final budget/diagnostic changes have a prepared followup prompt; external authentication blocked the parent finalaudit, so no final-audit pass is claimed here.

Real Docker daemon, real modelprovider identity, production latency and cross-platform qualification remain separate.
