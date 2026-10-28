# Performance measurement

Use this method to assess a latency, throughput, speedup or regression claim. Start with the user's decision and the actual workload. A number without a correct result and completed work cannot establish an improvement. Follow [the evidence rules](evidence.md). Use [investigation](investigation.md) to explain an unknown cause, and [code review](code-review.md) to review a proposed change.

## Fix the claim and comparison

Write the claim before running the experiment. Name the user-facing operation, input size, concurrency, unit, timing boundary and decision threshold. Pin both source revisions, generated build identities, runtime versions, machine class and measurement script. Read that script. Identify everything it includes, excludes, retries or discards.

Make the baseline and candidate perform equivalent work with the same correctness predicate. Keep inputs, commands, expected output, concurrency and timing boundaries comparable. Use appropriate production builds and settings on both sides. Record differences in batching, transactions, connection pools, indexes and cache state. If a setting is the proposed change, name it as the experimental variable. Do not call that an implementation-only comparison.

Do not pick an option while one side remains untuned. Investigate and correct the imbalance within the authorized scope, then retain the original run and compare again. If comparable tuning is unavailable, report the choice as inconclusive. Renaming the claim to “as shipped” does not justify an adoption decision from an unfair comparison.

Set the run count, ordering, warmup and exclusion rules before collection. Record cold and warm workloads separately when users encounter both. Check machine load and competing work with available host tools. Do not stop unrelated work without authority. Alternate sides to reduce drift: A, B, A, B. Record the actual order and any scheduling deviation.

## Establish that the measured work happened

Use an existing project benchmark or real operation. Do not invent an installed OSStack measurement command. Follow the repository's scratch, explicit home and resource-ownership rules. Keep raw samples outside disposable fixture state. Treat candidate scripts as code that needs an authorized execution boundary. Privileged profiling, dependency-install lifecycle scripts and load against a shared or remote target remain subject to existing authorization; an unavailable diagnostic leaves an explicit gap rather than permission to expand access.

For every sample, retain elapsed time, exit status, errors, timeouts, retry count, completed work and correctness results. Check the actual output or side effect, not only its presence. Confirm that requests reached the target and that required results were consumed inside the timed region. Await asynchronous work and consume lazy results. A fast rejection, an unawaited promise or a cache hit on the wrong workload is not a faster successful operation.

Define wall-clock start and finish points. Include setup, queueing, transfer, computation, output consumption and retry costs when the claim covers them. If a microbenchmark excludes a phase, name that exclusion and measure the complete user path separately. Keep failed attempts in the report. A success-only latency summary must include its success denominator and the separate failure outcomes; it is not an all-request result. Do not change the command, weaken the output predicate or remove slow failures to improve the number.

## Explain the result

Find the limiting resource using an actual profile or counters and connect it to source. Inspect the load generator as well as the target. A saturated generator can hide the target's capacity. Collect intrusive profiles in separate diagnostic runs; do not mix their timings into the headline samples. A source-based guess is a hypothesis, not a measured bottleneck. If the limiter is unknown, preserve the observation but keep an improvement claim inconclusive.

Check physical and arithmetic bounds. Compare transferred bytes with bandwidth and completed operations with available resources. The saved time cannot exceed the time spent in the changed component under the stated assumptions. This additive bound assumes other costs and the critical path remain fixed; changed queueing, contention or overlap can invalidate that assumption and must be measured separately. Investigate a result that crosses a bound: missing work, a shifted timing boundary, caching or incorrect output may explain it.

For a comparison, start with at least five samples per side in alternating order. Retain every sample and report the count, median and range with units. This is a diagnostic minimum, not statistical proof. Inspect the distribution, outliers, warmup and temporal drift. Do not derive a reliable tail percentile from five observations. If the apparent gap is comparable to run-to-run variation, report that the measurement does not resolve a difference. For a close decision, plan more representative trials and a suitable uncertainty analysis; do not repeat until a preferred winner appears. Choose any statistical procedure for the design and its dependence assumptions, not merely because it returns a small p-value.

For a user-requested one-run ballpark, retain the output-correctness and completed-work checks and label the result as one observation. Do not infer a spread, repeatability or comparative winner. Choosing between options is not this exception.

Measure the end-to-end path users wait on with representative data and concurrency. Report how much of that path the changed component occupies. Keep local and CI machine classes separate. Passing an existing startup budget does not by itself establish a baseline-to-candidate speedup. Distinguish latency reduction, `(baseline - candidate) / baseline`, from speedup, `baseline / candidate`; name the denominator and unit. For higher-is-better throughput, use `(candidate - baseline) / baseline` for relative gain and `candidate / baseline` for the rate ratio. With equal completed work, that rate ratio equals `baseline_time / candidate_time`; changing work counts or excluding failures invalidates that equivalence.

## Report and act

Lead with a bounded verdict: observed faster, observed slower, no resolved difference, or inconclusive. State the workload, source/build pins, timing boundary, sample count, median/range, correctness and failure counts, measured limiter and end-to-end relevance. Link the raw runs, command order and diagnostic evidence. Distinguish an observed association from a causal conclusion. Small samples or one synthetic workload do not establish a general benefit.

If output correctness, completed work, fair tuning or the limiter is unverified, identify the gap. Keep that claim inconclusive instead of selecting a winner. Fix only what the task authorizes. Preserve invalid runs and explain why they do not support the claim. The method does not change a performance budget, authorize a deployment, install a benchmark service or issue a runtime or joint gate pass.

## Worked examples — synthetic, not executed benchmarks

All numbers below are invented teaching data. They demonstrate arithmetic and claim review. They are not OSStack timings, profiler observations or evidence of a performance gain.

**Comparable observation.** Suppose each A/B pair performs the same correct workload, with zero errors and all intended work completed. The five A samples are `100, 102, 98, 101, 99 ms`; B is `90, 92, 88, 91, 89 ms`. The recorded order is A1, B1 through A5, B5. Medians are 100 and 90 ms; ranges are 98–102 and 88–92 ms. That is a 10% latency reduction and approximately 1.111× speedup in these invented samples. If the full user operation has A samples `1000, 1002, 998, 1001, 999 ms` and B samples `990, 992, 988, 991, 989 ms`, its median reduction is only 1%. A real comparison would still need real run records and a measured limiter. These arrays alone do not supply them or justify a causal claim. For another explicitly synthetic example, a rate change from 100 to 120 correct operations per second is a 20% throughput gain and a 1.2× rate ratio. Completing the same 1200 operations would take 12 versus 10 seconds, also a 1.2× time speedup; it is a 16.67% latency reduction, not 20%.

**Shifted boundary.** A takes 40 ms to prepare and 60 ms to compute. B takes 70 ms to prepare and 30 ms to compute. Reporting only compute time suggests a 50% reduction; both complete operations take 100 ms. The compute observation can be named as such, but an end-to-end improvement is unsupported. For a different 1000 ms operation with a 10 ms component, removing that component entirely saves at most 1% of latency, giving at most `1000 / 990 ≈ 1.0101×` speedup if everything else is unchanged. A claimed 20% whole-operation reduction requires another explanation.

**Fast failure.** A completes 20 of 20 correct operations in 100 ms. B returns 20 rejected responses in 5 ms and completes none. Dividing elapsed times produces 20×, but that is not a successful-work speedup. Preserve the rejection evidence and report the comparison as invalid for the intended operation. Do not omit B's failures or change its input to make this run pass.

**Unresolved noise.** A samples are `97, 100, 103, 99, 101 ms`; B is `98, 100, 102, 99, 101 ms`. Both medians are 100 ms, with overlapping ranges. A smaller B maximum is not enough to claim a faster or more reliable system. Retain the distribution and design more trials only if the decision needs them.

This is an OSStack adaptation of the pinned pstack benchmark and number-explanation practices. See [source attribution](sources.md) for the shared provenance policy. Upstream host-specific commands and automatic optimization workflows are not required by this method.
