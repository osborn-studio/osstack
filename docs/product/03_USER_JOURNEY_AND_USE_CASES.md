# User Journey And Use Cases

## Five-Minute Journey

1. Install: `npm install -g @osstack/cli`.
2. Check workspace: `osstack doctor --workspace .`.
3. Queue or deliver work: `osstack deliver "Add billing dashboard" --verify "pnpm test"`.
4. Inspect: `osstack cockpit`.
5. Share evidence: `osstack proof` or `osstack pr --dry-run`.

## Core Use Cases

- Fix a failing test with deterministic verification.
- Implement a feature in an isolated worktree.
- Run a daemon-managed loop for a task queue.
- Generate a PR body from run evidence.
- Produce a compliance mapping report from an existing proof pack.
- Search official, team, and project knowledge packs before planning.

## Failure Journey

When verification fails, osstack records the failed task, verifier output, governance findings, and a pitfall lesson candidate. The next run can recall the lesson or route differently.

