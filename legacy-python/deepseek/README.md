# OSBORN deepseek capability

System-level DeepSeek code review tools for OSBORN-style workflows.

## Commands

### ds-review

Reviews a git diff via the DeepSeek API and emits a structured Markdown report.

```bash
git diff | ds-review
ds-review --file diff.patch
ds-review --strict
ds-review --output reviews/ds-review/latest.md
ds-review --model deepseek-chat
```

Input priority: `--file` > stdin > `git diff` in `$PWD`.

## Environment

| Variable             | Required | Default                      | Notes                                  |
|----------------------|----------|------------------------------|----------------------------------------|
| `DEEPSEEK_API_KEY`   | yes      | —                            | DeepSeek bearer token. Never logged.   |
| `DEEPSEEK_BASE_URL`  | no       | `https://api.deepseek.com`   | Override for self-hosted / proxies.    |
| `DEEPSEEK_MODEL`     | no       | `deepseek-reasoner`          | Override default model.                |
| `OSSTACK_EVALUATION_SPECS_FILE` | no | — | Osstack loop evaluation specs JSON (see below). |

## Osstack Loop Evaluation Protocol

When the osstack loop runs ds-review/ds-verify as a verifier adapter, it sets
`OSSTACK_EVALUATION_SPECS_FILE` to a JSON file of evaluation specs
(id/mode/description/acceptance). Both commands then:

1. Append the acceptance criteria to the DeepSeek prompt and require a fenced
   JSON judgment block in the response.
2. Print one stdout line the adapter parses into per-spec verdicts:

   ```text
   OSSTACK_EVALUATIONS: {"evaluations":[{"id":"no-bypass","pass":false,"summary":"..."}]}
   ```

Without the env var, behavior is exactly the legacy one. Logic lives in
`lib/evaluation_specs.py`; offline tests (fake DeepSeek API included) run with:

```bash
python3 -m unittest discover legacy-python/deepseek/tests
```

## Files

```text
~/.osborn/capabilities/deepseek/
  bin/ds-review           — Python 3 entry point (stdlib only)
  prompts/review.md       — system prompt (override by editing)
  config/config.example.yml — reference config from upstream
  upstream/README.md      — what we borrowed and from where
```

## Upstream

Adapted from [hustcer/deepseek-review](https://github.com/hustcer/deepseek-review).
See `upstream/README.md` for what was borrowed.

## Later Phases

* `ds-verify` — verify high-severity findings have been addressed.
* Streaming output, include/exclude patterns, multi-provider config.
