# Runbook

## Local Development

```bash
pnpm install
pnpm -r build
pnpm --filter @osstack/cli test
```

## Smoke Install

```bash
pnpm smoke:npm-install
```

## Daemon

```bash
osstack serve
osstack serve --install --profile mac-mini \
  --write-concurrency 2 \
  --read-concurrency 8 \
  --power-policy none
osstack serve --status --json
osstack serve --uninstall --no-load
```

## Evidence Flow

```bash
osstack loop run --source task_queue --verify "pnpm test" --report --scorecard --proof
osstack cockpit
osstack pr --dry-run
```

## Guarded Git Autonomy

```bash
osstack deliver "Implement one bounded change" \
  --workspace . \
  --profile mac-mini \
  --autonomy guarded-git \
  --expected-path src/example.ts \
  --verify "pnpm test" \
  --json

osstack autonomy list --json
osstack autonomy status RUN_ID --json
osstack autonomy resume RUN_ID --json
```

Production prerequisites, R0-R4 semantics, external Ed25519 R3 decisions,
blocked-delivery recovery, proof ordering, and rollback are documented in
[`docs/runbooks/guarded-git-autonomy.md`](../runbooks/guarded-git-autonomy.md).

## Guarded Deploy on Mac Mini

```bash
osstack autonomy health --json
osstack autonomy list --json
osstack autonomy freeze list --json
osstack daily --json
```

Installation, project deploy allowlists, named machine/production authority
gates, automatic rollback/freeze, recovery order, signed freeze clear, host
evidence, and the seven-day soak are documented in
[`docs/runbooks/kimi-mac-mini-autonomy.md`](../runbooks/kimi-mac-mini-autonomy.md).
