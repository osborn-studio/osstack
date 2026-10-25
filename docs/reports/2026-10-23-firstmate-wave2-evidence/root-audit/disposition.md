# Root integration challenge disposition

Requested Claude Code model: `claude-haiku-5-5`. Raw requested/returned model identifiers and CLI unrecognized-model warnings are retained; this is not an attestation of underlying model weights. Four static rounds; no review is substituted for executed tests.

- Fixed aggregate replay payload allocation: each page returns at most 64 KiB of payload JSON, with separately bounded envelope fields. This does not bound SQLite physical reads or certify p95 latency. Cursor progresses through smaller pages.
- Fixed resolved-event projection: status and choice/answer must exactly match the original approval/clarify authority row for the same run. Conflicting or malformed echoes leave a sticky gap and cannot grant authority. Hermes schemas require choice/answer even on timeout; malformed legacy events remain unknown.
- Fixed pending references: SQL returns only IDs of 1–256 UTF-8 bytes, at most 20 per family, alongside full count and explicit truncation. Oversized references cannot inflate persisted subject JSON; the reducer's separate 4096 UTF-16-unit limit is an event-validation limit. The bounded window can omit later valid IDs, so IDs are hints, never a complete authority list.
- Fixed unresolved worker-delivery relation: an explicit same-message/session `abandoned_unknown` resolution removes the active wait; the historical uncertainty flag remains. Terminal workers retain history with no active wait.
- Accepted conservative worker availability boundary: one invalid row fails its whole page with `source_unavailable`; keyset pagination cannot skip it. This is intentionally not a partial success or healthy empty response. It requires source repair and remains a documented limitation. The third review labeled it P1; final round treated the explicitly documented boundary as nonblocking.
- Unknown waits remain unknown when no verifiable decision exists. Subject `observed_status` is the last verified event observation, not current process state; sticky gap and unknown liveness remain alongside it. Source-specific state metadata is not a cross-source state machine.
- Corrected readonly status compatibility for schema42, which only adds event cursors; future schemas still fail closed.

Final static round reports no confirmed blocking defect. Raw prior reports, including their higher severity labels, are preserved unchanged. Full suite qualification is separate and recorded after this final source delta.
