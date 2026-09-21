# Graph 性能验证进展

2026-09-20。全仓验收中的启动预算通过：version 中位数 29ms / 150ms，help 83ms / 500ms，各 5 次。真实内部试点暴露的逐文件 Git 启动开销已改为批量 plumbing；冻结从 179,139ms 降到 13,213ms，详见[试点报告](graph-runtime-pilot.md)。

首轮实际测量：非图 socket RPC 1,724 样本，p95 2.853ms（预算 10ms），最大值约 1,300ms；Loop 四轮正常 1 秒间隔测得开销 0.4304%（预算 1%）。最大延迟表明尾部仍存在暂停，不将 p95 通过解释成所有请求小于 10ms。worker 启动约 559ms，checkpoint host service p95 2.760ms。broker 耗时包含真实外部动作，不能当作纯 RPC 开销。

[原始首轮数据](../implementation/graph-upgrade-final-evidence/performance.json)保留全部样本。[最终基准](../implementation/graph-upgrade-final-evidence/performance-final.json)已通过：RPC 1,341 样本 p95 1.452ms、最大 775.565ms；worker 启动最大 330.775ms；checkpoint 20 样本 p95 1.759ms；broker 14 样本 p95 4,902.568ms（包含真实外部动作）；冷/热图耗时 8,906.851/8,857.614ms。31 MiB fingerprint 在 SQLite immediate transaction 内 8 样本 p95 21.267ms；Loop 4 cycles、wall 3,013.89ms、开销 0.460866%。均未提高预算；尾延迟仍作为已知技术债保留。

[宿主隔离证据](../implementation/graph-upgrade-final-evidence/import-proof-result.json)：在宿主 loader 拒绝所有 @langchain 模块的条件下，实际生产 worker 跑到 ready。另有事件循环阻塞回归，区分超时报告与真实退出证明。
