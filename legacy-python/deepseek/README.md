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
