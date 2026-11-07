# Sandbox publication actor evidence

This isolated helper adds GitHub repository activity attribution for the fixed
`osborn-studio/osstack-bridge-sandbox` repository (id `1446327922`). It does not
activate a runtime or bot, mint credentials, or write to GitHub.

`readSandboxBranchActivities({repository, repositoryId, branch, get, signal})`
uses an injected parsed-JSON GET transport. It requests one page of 100 activity
records for the exact mission branch and the last day, without an actor filter.
A full page fails closed as incomplete; absence outside that time window cannot
be interpreted as success. The caller must bind the transport to the verified
sandbox repository identity; the numeric input is an allowlist assertion, not a
fresh server-side repository-id lookup.

`assertSandboxPublicationActivities({repository, repositoryId, branch,
publisherActorId, intents, activities})` matches confirmed open_pr creation and
push intents in head ancestry order. Creation requires a zero before hash;
revision requires the exact expected before and new after hashes. Every returned
activity must match the registered numeric App A actor and Bot type. Force push,
foreign actors, duplicates, missing ranges, unexpected extra records, invalid
scope and malformed hashes fail closed. Output contains only intent/activity
ids, activity type, numeric actor/type, ref and before/after hashes.

The [official GitHub activity API](https://docs.github.com/en/rest/repos/repos#list-repository-activities)
documents Contents read permission, ref filtering, day time period and cursor
pagination. A read-only sample at 2026-11-07 15:27:50 UTC returned actual
`actor.id=352680398`, `actor.type=Bot`, push and branch_creation records with
before/after hashes. The implementation uses actor, never commit author or the
sample's absent pusher field. No remote mutation or sandbox execute was run.

This proves API-reported publication actor attribution only. It does not prove
supply chain integrity, fast-forward enforcement, ruleset rejection, installation
permissions, or complete 5G acceptance. Those require the independent driver
probes and timeline evidence. The production acceptance gate remains closed.

Validation: test-first missing-module RED, then `node --test
scripts/bridge-sandbox-activity.test.mjs`: 8/8 passed, no skipped tests. Cases cover
scope, full-page incompleteness, actor/type, exact baseline/ranges, force push,
ambiguous/missing/extra records, 40/64-character hashes, cancellation and sanitized
transport errors. No package build or full monorepo suite was run for this script.
