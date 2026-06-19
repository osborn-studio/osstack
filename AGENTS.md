# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm TypeScript monorepo for OSBORN stack. Primary source lives in `packages/*/src`, with each package owning its own `package.json` and `tsconfig.json`. Key packages include `packages/cli` for the `osstack` binary, `packages/core` for orchestration and state, `packages/agents` for agent adapters, and `packages/hermes-adapter` for Hermes integration. Tests are colocated with source as `*.test.ts`. Documentation lives in `docs/`, helper scripts in `scripts/`, Hermes skill files in `hermes-skill/`, the reusable Loop Engineering Codex skill in `loop-engineering/`, and preserved V1 Python code in `legacy-python/`.

## Build, Test, and Development Commands

- `corepack enable pnpm`: enables the expected pnpm version.
- `pnpm install`: installs workspace dependencies from `pnpm-lock.yaml`.
- `pnpm build`: builds every workspace package with `tsc` or `tsup`.
- `pnpm test`: runs all package test suites with Vitest.
- `pnpm typecheck`: runs strict TypeScript checks across packages.
- `pnpm dev`: starts the CLI package in `tsup --watch` mode.
- `pnpm --filter @osstack/core test`: runs one package test suite.

The root `lint` script delegates to packages, but package lint scripts are not currently defined.

## Coding Style & Naming Conventions

Use TypeScript ESM and keep exports explicit through package `src/index.ts` entrypoints. Follow the strict compiler settings in `tsconfig.base.json`: no implicit `any`, no unused locals or parameters, exact optional properties, and checked indexed access. Use two-space indentation, `camelCase` for functions and variables, `PascalCase` for types/classes, and kebab-case filenames such as `status-fsm.ts`. Keep package boundaries clear; prefer workspace imports like `@osstack/core` over deep cross-package paths.

## Testing Guidelines

Vitest is the test runner. Place tests beside the code they cover using `*.test.ts`, for example `packages/core/src/policy/engine.test.ts`. Add focused tests for new routing, policy, state, adapter, and parser behavior. Run `pnpm test` before opening a PR, and use `pnpm --filter <package> test` while iterating.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, for example `feat(loop): add loop engineering foundation` and `feat: OSStack standalone product + role-based agent configuration`. Use a concise imperative subject and include a scope when it clarifies the affected package. Pull requests should describe the change, list validation commands run, link related issues or docs, and include screenshots only for user-visible CLI, dashboard, or Hermes-facing behavior.

## Security & Configuration Tips

Do not commit local Hermes paths, secrets, socket data, or generated databases. Keep machine-specific settings in environment variables such as `HERMES_HOME`. Treat `legacy-python/` as compatibility code: update it only when intentionally maintaining V1 shims.
