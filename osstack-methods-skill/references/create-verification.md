# Create verification instructions

The deliverable should let a cold caller operate an actual project surface and inspect its outcome. Start with an existing driver; build a new harness only when the task authorizes it and the observed gap requires one.

1. Inspect the project: user-facing surfaces, documented build/start commands, readiness signal, input fixtures, credentials, observable output/side effects, isolation and owned cleanup. Name unsupported surfaces. A dependency or startup failure remains a blocker; do not invent a runnable command.
2. Write launch, doctor, drive, observe, isolate and cleanup instructions using real paths and commands. Doctor checks prerequisites and ownership; it does not prove the behavior. For a short-lived CLI, use a fresh isolated run. A shared service must not be driven concurrently without demonstrated isolation.
3. Build a [feature map](feature-map-template.md). Seed a few important behaviors and enumerate uncovered ones. Every entry states preconditions, action, expected end state, evidence, failure/recovery path and owner. Describe fixtures that replace external systems and what remains untested.
4. Define evidence retention outside disposable application state. Use [the common record](evidence.md). A dry-run name is not a safety guarantee: establish its actual skipped and performed effects before relying on it.
5. Run the documented path end to end once, including doctor where available, one mapped feature, evidence capture and cleanup. Verify the proof still exists afterward. If a step fails, retain the attempt, fix only the authorized harness/document scope and rerun the affected path. Product defects stay visible and require their own authorized correction.
6. Hand off the exact proven candidate/environment and remaining coverage. Unexecuted generated instructions are **draft**. One successfully exercised feature gives a usable seed, not complete feature coverage or joint qualification. Provide the [maintenance procedure](maintain-verification.md), without scheduling it automatically.

Start OSStack work with [the existing engineering decision example](engineering-decision.md). Do not fabricate a `method-control` or `skills install` command: this package adds neither. If this driver cannot exercise the requested behavior, report the gap rather than editing the success predicate to fit the driver.
