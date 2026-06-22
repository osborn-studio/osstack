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
osstack serve --install --no-load
osstack serve --status
osstack serve --uninstall --no-load
```

## Evidence Flow

```bash
osstack loop run --source task_queue --verify "pnpm test" --report --scorecard --proof
osstack cockpit
osstack pr --dry-run
```

