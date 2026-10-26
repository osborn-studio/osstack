# Split audit receipts / 拆分复审凭据

The three small JSON responses are original Claude Code CLI results. `modelUsage` identifies `claude-sonnet-5-5`; `is_error=false` for each. The reviewer had no tools, MCP servers or persistent session, and did not execute tests. [Input/output hashes](audit-index.json) identify each frozen input and raw response. Large repeated source inputs and full test logs remain in the task's local scratch archive; they are not included in the code-review diff. The original pilot's separate public archive is indexed [one level above](../archive-index.json).

## Disposition

- Initial split review: the drain test correction passed. A conditional P2 asked whether the drain producer and upgrade consumers landed together. The state PR includes both; the next review verified its actual branch diff and withdrew the finding.
- Closeout: no blocking split-boundary defects found. Final tests, CI and independent GitHub approval remain separate requirements.
- Test-race review: no P0/P1/P2. The failed receipt becomes durable before stop/lease cleanup. Polling `health.active_runs` after that receipt waits for the Session send marker to clear while leaving the daemon runnable. Polling `daemon.drain` after the applied receipt waits for actual drain completion and retains zero-run/zero-hold assertions.
- Non-blocking coverage notes: these two tests do not force the transient cleanup window, inject a lease-release failure, or prove the settle-time scan during drainage. They are synchronization fixes to the existing scenarios, not new qualification for those failure modes. Source-based unit and integration coverage remains unchanged.
- Branch-retention note: keep `codex/capability-registry-pilot`, which retains the immutable original evidence commit. Original CI failures remain historical failures.

[Source equivalence](source-equivalence.json) records 48 byte-identical implementation/Schema files and the one test file with two synchronization corrections. See the [current split report](../../../../reports/2026-10-26-pr251-split.md) for execution evidence and deployment limits.

## 中文说明

本目录保存本次拆分的三轮原始模型返回和输入摘要。第一轮关于 drain producer/consumer 是否一起落地的条件性 P2，已用数据库与升级保护 PR 的实际 diff 消除；第三轮对两处测试等待修正没有发现 P0/P1/P2。非阻断测试覆盖局限如上，未被描述为已通过真实环境验证。测试与 GitHub CI 由各自的执行凭据证明，模型意见不能代替执行结果。
