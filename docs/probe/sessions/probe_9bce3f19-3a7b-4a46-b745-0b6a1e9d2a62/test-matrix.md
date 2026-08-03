# Test matrix delta

Probe session: probe_9bce3f19-3a7b-4a46-b745-0b6a1e9d2a62  
Revision: 10

## How will each acceptance obligation map to repeatable evidence?

全新安装以安装记录和 CLI/daemon 版本一致性为证；doctor 以无阻塞项的 JSON 结果为证；Neat 以修复前后快照、ReportV2、事务回执和复扫结果为证；Probe 以 ledger、render manifest 及 live/fresh-home gate 一致性为证；安全边界以文件哈希、写入白名单、凭证哨兵和日志扫描结果为证。

Destination: docs/probe/2026-08-02-production-acceptance-test-plan.md (applied)

## What test data is representative without exposing secrets or personal information?

Use synthetic fixtures and redacted structural samples by default. Never copy real records; retain only schema, hashes, and aggregate scale or distribution metadata. Credential fixtures must use obviously fake sentinel values. Reject any fixture containing secrets or personal identifiers before persistence, logs, reports, or rendered artifacts.

Destination: docs/probe/2026-08-02-production-acceptance-test-plan.md (applied)
