# Task Queue Schema

Task queue files live under `tasks/*.json`. Prefer `loop enqueue` so generated files match the runtime schema.

## Minimal Task

```json
{
  "task_id": "fix-auth-test",
  "capability": "code.fix",
  "prompt": "Fix the failing auth test",
  "priority": 80,
  "source": "task_queue"
}
```

## Fields

- `task_id`: stable unique identifier. Use lowercase words separated by hyphens.
- `capability`: routing hint such as `code.fix`, `code.test`, `review.code`, or `docs.update`.
- `prompt`: natural-language task for the executor or agent.
- `priority`: integer from 0 to 100. Higher means more urgent.
- `source`: usually `task_queue` for files in `tasks/`.
- `context`: optional object with file paths, logs, issue IDs, branch names, or other structured hints.
- `evaluation`: optional array of evaluation specs. The verifier runs every spec and reports per-spec results in the verdict, `LOOP-STATE.json`, and `STATE.md`.

## Evaluation Specs

Each entry in `evaluation` follows this schema:

- `id`: stable spec identifier, unique within the task.
- `mode`: one of `command`, `contract`, `property`, `e2e`, `artifact`, `semantic_review`, `governance`.
- `description`: what this evaluation asserts.
- `required`: default `true`. A failed required spec blocks the verdict; a failed optional spec only warns.
- `command`: shell command for command-style modes. Non-zero exit fails the spec.
- `target_paths`: for `artifact` mode, changed files must hit at least one of these paths.
- `forbidden_paths`: for `artifact` mode, changed files must not hit any of these paths.
- `acceptance`: natural-language acceptance criteria passed to verifier adapters for `semantic_review`-style modes.
- `weight`: 0 to 1 (default 1). Weights aggregate into the verdict score.

Legacy verification stays compatible: every `--verify CMD` becomes an implicit `command` spec, and artifact verification flags/context become an implicit `artifact` spec, so all runs produce per-evaluation results.

Example:

```json
{
  "task_id": "fix-auth-test",
  "capability": "code.fix",
  "prompt": "Fix auth test failures without weakening access control.",
  "priority": 90,
  "source": "task_queue",
  "evaluation": [
    {
      "id": "auth-tests",
      "mode": "command",
      "description": "Auth test suite passes.",
      "command": "pnpm test -- tests/auth",
      "required": true
    },
    {
      "id": "no-policy-bypass",
      "mode": "semantic_review",
      "description": "The fix must not bypass authorization or hardcode access outcomes.",
      "acceptance": "Reject changes that return constant allow/deny values, skip session validation, or remove negative tests.",
      "required": true
    }
  ]
}
```

`semantic_review` specs need a verifier adapter (`--reviewer` / `--checker`). A required semantic spec with no adapter configured fails the verdict instead of silently passing.

## Enqueue Examples

```bash
loop-engineering/scripts/osstack-loop.sh enqueue \
  "Fix the failing scheduler tests" \
  --capability code.fix \
  --priority 90
```

```bash
loop-engineering/scripts/osstack-loop.sh enqueue \
  "Review loop daemon lifecycle handling" \
  --capability review.code \
  --context-json '{"files":["packages/cli/src/daemon.ts"]}'
```

## Queue Hygiene

- Use one task per JSON file.
- Keep prompts actionable and testable.
- Include `context.files` when the task should focus on specific code.
- Use `--archive-completed` during runs that should keep `tasks/` clear.
