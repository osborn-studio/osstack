# Actual Codex and Claude explicit-material exercise

Two actual local CLI calls consumed identical exported material bytes from `4b0f2267b7a64519ed296eff9713e055daaf6e06`: four entry skills and five pertinent references, with six previously frozen requests. Each request was explicitly simulated; neither host was asked to execute commands. The prompt supplied the absence of a PR291 execution checkout, but did not supply expected answers. Other linked references were omitted and the raw prompt preserves exactly what was provided.

Codex CLI returned exit0, 768 whitespace-delimited words, zero tool events; the stream did not attest its model identifier. Claude CLI returned exit0, modelUsage `claude-sonnet-5-5`, 1032 words, zero tool events. Both met the disclosed 1200-word total limit, used the identical input hash and left the material snapshot unchanged. No retry was made.

Both identified the four entries, kept configuration proposals scoped, treated unavailable model IDs as unknown, refused to treat old-SHA screenshots as current verification, and did not claim persistent recovery or automatic merging from method text. These are observed proposed-action responses, not observed execution of those actions.

The prefrozen criteria were not all established: neither answer fully explained expected-negative product exit1 versus verifier success; concrete per-host invocation guidance and authority/handoff evidence were incomplete; delegation, cleanup and input preservation were not executed. Claude additionally proposed a broad per-action merge confirmation requirement that should not override existing user authorization. These limitations remain in the root assessment instead of being erased by another model attempt.

This exercise gives no native discovery, product-driving, comparative benefit or formal-principal evidence. Later exporter and host-usage-document repairs do not change the bytes supplied to these calls, but the calls remain attributed to the original `4b0f2267` export. Full raw prompts, JSONL responses, identities, input hashes, frozen requests and assessments are archived with this batch.
