# Actual Sonnet 5.5 review

The actual CLI used `claude-sonnet-5-5`, with tools disabled and no MCP tools. Original prompts, responses, actual modelUsage, exit codes and hashes are retained in [audit.tar.gz](audit.tar.gz), indexed by [audit-manifest.json](audit-manifest.json).

- First review: methods candidate `efd53f6e` REVISE. The same call independently returned PASS for unrelated PR289 test candidate `4dddf67a`; those conclusions are separate.
- Revised candidate `99096018`: limited closure review PASS for prior B findings. The reviewer did not execute the archive validator; the root separately verified all 98 member hashes and the changed Markdown links. Two nonblocking wording/future-experiment notes remain in the raw review.
- The revision narrows claims, discloses supplied-but-unread inputs and CLI warnings, records author/evaluator overlap and differing inputs, and explains archive redaction. Historical evidence itself is unchanged.

Documentation and ledger validation: 241 Python tests passed. This does not validate host behavior or show that the new wording improved outcomes. No further host trial has run.

The documentation candidate's actual fresh install/build/export check and `pnpm test` at `99096018` completed: 7,129 passed, 5 skipped, zero failed. Package source and method material digests were stable. Central-ledger/document-only updates during that run are not claimed as a frozen full-tree test. The four generated tracked dist files were restored afterward. [Validation records](validation.tar.gz) and [their manifest](validation-manifest.json) preserve commands, source digests, original logs and restoration proof. The post-288 ledger also passed 241 document checks.
