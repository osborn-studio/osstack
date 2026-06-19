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
