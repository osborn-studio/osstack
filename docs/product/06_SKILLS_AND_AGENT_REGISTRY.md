# Skills And Agent Registry

## Purpose

The registry makes execution choices explicit. Agents expose capabilities, auth modes, roles, and availability so routing can be explained later in reports and proof packs.

## Roles

- coding
- test-verify
- reviewer
- designer
- product/planning
- release/proof

## User-Facing Commands

- `osstack agent list`
- `osstack agent scorecard`
- `osstack config doctor`
- `osstack skills list`
- `osstack skills check`

## Product Rule

Every routed run should be explainable as: capability requested, candidates considered, selected agent, auth mode, role fit, and reason.

## Kimi Code Reviewer

`kimi-code` advertises only `code.review` and `release.verify`. These map to
`test-verify`, `reviewer`, and `release/proof`; the adapter must not acquire a
`coding` role during the experimental phase.

Readiness is a shared three-state contract:

- `kimi_not_installed`
- `kimi_not_authenticated`
- `kimi_available`

The readiness probe runs `kimi --version` and `kimi provider list`; it never
sends a model request. Runtime identity records adapter, provider, model,
profile, and binary-path digest without persisting credentials. `agent list`
and `config doctor` expose this state, using the installed model alias rather
than a guessed model name.

Kimi receives only the bounded diff, changed paths, deterministic command
summaries, and explicit evaluation criteria. It runs with an agent policy that
has no tools or subagents. `approved` is the only pass-eligible verdict;
missing/malformed structured review, unknown or duplicate judgment IDs,
timeout, boundary failure, or detected workspace mutation fails closed.
