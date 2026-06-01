# Upstream Notes

## Primary Upstream

[hustcer/deepseek-review](https://github.com/hustcer/deepseek-review) — MIT licensed.

Local clone (reference only, not a runtime dependency):
`~/.osborn/sources/deepseek-review`

## Why This Upstream

It already supports DeepSeek-powered code review and local code review workflows.
Its `config.example.yml` contains carefully-tuned prompts (especially `strict-dev`),
multi-provider configuration, and include/exclude pattern handling that informed
our design.

## How OSBORN Uses It

**Adapted, not wrapped.** The upstream `cr` binary is a Nushell script
(`#!/usr/bin/env nu`) and depends on Nushell at runtime. To keep `ds-review`
portable across machines without requiring Nushell, OSBORN re-implements the
minimum viable API-call path in Python (stdlib only) and **borrows**:

1. **Prompt structure** — our `prompts/review.md` is original (drawn from the
   user's P3 spec) but the *idea* of a strict structured-output system prompt
   comes from upstream's `strict-dev` template
   (`config/config.example.yml` contains the original).
2. **CLI flag conventions** — names like `--diff-from`, `--patch-cmd`,
   `--output`, `--include`, `--exclude`, `--model` follow upstream so users
   familiar with `cr` find `ds-review` predictable. OSBORN currently
   implements the subset needed for stdin/file/git-diff review.
3. **Default request shape** — POST to `${BASE_URL}/chat/completions`,
   OpenAI-compatible payload with `model`, `messages`, `temperature`, `stream`.
   Upstream uses `User-Agent: curl/8.9` to avoid rate-limit penalties on rare
   user agents; OSBORN uses a similarly innocuous UA.
4. **Provider-agnostic base URL** — `DEEPSEEK_BASE_URL` env can point at
   SiliconFlow, OpenRouter, Ollama, etc. — same pattern as upstream's
   `providers` block.

## Local Modifications

* `ds-review` is a fresh Python implementation; no upstream Nushell code is
  executed at runtime.
* Output is normalized to OSBORN's "DS Review Report" format. If the model's
  response doesn't conform, the raw text is preserved under
  `## Raw Upstream Review`.
* Strict mode is implemented by appending an additional instruction to the
  system prompt at runtime, rather than by switching to a different prompt
  file.
* No GitHub PR fetching, no streaming, no comment posting — those upstream
  features are out of P3 scope.

## Limitations

* No support yet for SiliconFlow / Ollama / OpenRouter providers — only the
  default DeepSeek endpoint is exercised. Switching providers works in theory
  via `DEEPSEEK_BASE_URL` but is untested.
* No streaming output. The script blocks until the full response arrives.
  `deepseek-reasoner` may take several minutes; default timeout is 600s.
* No include/exclude file pattern filtering yet.
* No PR-fetching mode (`--pr-number`, `--repo`).
* No config file support — flags + env vars only.

## Reference Files

* `~/.osborn/sources/deepseek-review/nu/review.nu` — upstream API call.
* `~/.osborn/sources/deepseek-review/nu/diff.nu` — upstream diff handling.
* `~/.osborn/sources/deepseek-review/config.example.yml` — upstream prompts
  and provider config (also copied to `../config/config.example.yml`).
