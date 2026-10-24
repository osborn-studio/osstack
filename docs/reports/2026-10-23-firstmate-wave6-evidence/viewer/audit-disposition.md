# V2 static audit disposition

Three isolated Claude Code CLI audits requested `claude-haiku-5-5`, tools/hooks/MCP disabled via explicit empty settings. Raw prompts, results and stderr retained. CLI emits `unrecognized_model`; results report the requested model, but actual model identity is not independently authenticated. These are static reviews, not runtime proof.

Round 1: no P0/P1, four P2 entries despite summary saying three. Fixed callback-only output error guard leak by delayed cleanup after Node error dispatch; independent 1000ms local read deadline; help output EPIPE; distinct scope-binding diagnostic. Red/green evidence retained.

Round 2: no P0/P1. F1 confirmed interrupt exit-code race during final diagnostic: red/green fixed. F2 generic transport timeout is deliberately unknown, documented. F3 never-completing shared output retains bounded one chunk/guard intentionally to catch delayed EPIPE; added explicit test and residual documentation. F4 source identity concern was marked unverified due missing schema in that prompt; authoritative encrypted token binds actual source and scope, supplied in rounds 1/3; no authority expansion. F5 expanded escaping assertions for BEL, bidi and Unicode format controls.

Round 3 final exact source snapshot: pass, no confirmed P0/P1/P2. Two accepted residuals remain documented (one late-error guard on stalled shared output; generic transport timeout detail). Source hashes in source-manifest.json.

Runtime evidence: 63 focused tests; real WorkerViewService read with no DB changes; real OS SIGINT and pipe close against compiled viewer with fixture transport. Production route/socket integration belongs to parent. tmux, logs, process liveness and model qualification are not claimed.
