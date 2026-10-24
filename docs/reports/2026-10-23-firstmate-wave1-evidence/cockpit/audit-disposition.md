# Cockpit A1 audit disposition

- First Haiku audit: 0 confirmed P0, 1 confirmed P1. Invalid Attention page query caused browser load to consume a 400 error envelope as a dashboard and stop rendering. Fixed by client page-query normalization, HTTP status checks, bounded fetch and unavailable fallback. Production browser tested with attention_limit=0&attention_after=bad: full page rendered; added regression tests.
- Additional fixes: current wait counts only admitted subjects; items/other_items preserve total state counts; full-screen Attention prioritizes problematic scope; terminal control/bidi filtering; Chinese available label now means observation updated, not business success.
- Conditional findings resolved with actual schema/store: scan_complete/deadline/generation are NOT NULL; default tenant is NULL; registerScope canonicalizes realpath before insert. Real DB tests use the production store.
- Final Haiku result: is_error=false, requested and modelUsage identifier claude-haiku-5-5; 0 P0/P1. Residual P3: zero-width formatting characters U+200B–D and U+2060 are retained. They are display text only, never command/identity parsing; retain natural-language shaping instead of adding a general Unicode normalization policy in this change.
- Existing other TUI sections may carry terminal controls from source strings. This is pre-existing outside the Attention section and was not presented as globally fixed.
- CLI emitted unrecognized_model warning in stderr; saved verbatim. Request/response identifier evidence does not independently authenticate underlying model weights.
- Review is static and does not replace tests or actual host integration. Both original prompts/results retained unchanged.
