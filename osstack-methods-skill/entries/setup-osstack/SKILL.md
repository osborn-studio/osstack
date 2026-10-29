---
name: setup-osstack
description: Prepare or apply a scoped OSStack role/model/effort and resource-budget configuration when the user asks for setup or cost control. Discover actual host support, preserve existing choices, and produce a reviewable proposal before any configuration change.
---

# Set up OSStack method preferences

Determine the target host, configuration scope and requested outcome from the conversation and readable local state. Produce a concise, reviewable role table and proposed diff. If the target or scope is unresolved, keep that part as a proposal; do not choose a global destination or overwrite unrelated settings.

## Discover and propose

Use the host's available model catalog, supported CLI help or configuration schema to establish exact identifiers and supported effort values. Do not invent a model slug, infer entitlement from marketing names, concatenate effort/speed suffixes, or assume a suggestion is an executable model setting. If discovery is unavailable, retain the host's current choice and label proposed alternatives unverified.

Read the existing configuration at the identified scope before suggesting changes. Preserve user-selected models and unrelated keys. Map only roles relevant to this task, such as investigation, implementation and verification; a role table does not itself create routing or spawn agents.

For each proposed role record the model choice or “retain host default”, supported effort setting, reason, and observed support. For the run record the relevant limits: maximum duration, calls/concurrency, and tokens or cost where the host can measure and enforce them. Distinguish an intended spending target from an enforced cap. Do not describe an unmeasured or unlimited setting as a safe bounded budget. If omitting a model option is the host's documented way to retain its default, omit it rather than sending a made-up alias.

## Apply only within the resolved scope

When the user has already authorized these settings for a known host and scope, apply the validated diff using its supported mechanism without requesting the same approval again. Otherwise present the concrete proposal and identify the unresolved choice or authorization needed for the write. Setup is not authorization to install dependencies, change credentials, select additional paid providers or enable background automation.

Before writing, check whether the destination exists and preserve its unrelated content. Do not create a new absolute configuration path by convention, replace a control-plane database or source manifest, or write role settings into repository instructions merely because a host-specific configuration mechanism is unknown. If the mechanism cannot express a role table, report it as planning guidance, not an active setting.

After an authorized application, re-read the actual settings and use supported read-only validation. Report what changed, the effective scope, whether a new session is required according to that host, and anything not validated. Configuration acceptance does not prove task execution, a measured cost reduction or runtime qualification.

For the next task, [osstack-mode](../osstack-mode/SKILL.md) routes the twelve implemented shared methods. This entry adapts setup principles from the fixed upstream revision `99b609a72323b70204eab407c622f436e858e112`; [source attribution](../../references/sources.md) remains intact. It carries no upstream default models or unconditional file-overwrite behavior.
