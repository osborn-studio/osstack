# R7及C2最小联合依赖补充（只读）

历史联合审计当时的69项新增JA产品场景全部未执行；另有66项Firstmate+48项pstack=114项继承场景，不能混称为69原始场景。当前main新增JA清单已为72项，本句保留历史时点而不回写旧统计。

精确出处：`docs/design/2026-10-27-joint-engineering/claude-audit.md:109`，Git blob `c9d1a94b4d7fe2954c71a9e4f403c442013202c4`，版本`e4643324b9de1d2db51c744e59ccd7c05146b0a6`。当前 `docs/design/2026-10-27-joint-engineering/acceptance-cases.json.cases` =72 JA；同目录`legacy-case-map.json.items`=66 FM+48 PS。另一个`docs/reports/2026-10-26-pstack/acceptance-cases.json`才是本报告原48项。不是同一个分母。

## C2依赖的明确边界

- 目标J09.scoped→J08.scoped；其直接前置为J03.scoped、J07.scoped、J12.scoped、J08.recovery、J01.scoped。J01包括无副作用但真实宿主的J08.admission_boundary。材料/检查/产物链和E0决定不能删。
- 本地broker关闭路径：J11.scoped精确home/method schema规格→J12.bootstrap_preflight+J12.scoped→本次J08.schema_spec/J08.recovery。只限定本次实际版本/DDL/fixture/candidate/恢复build，不是先实现所有未来迁移。
- J08必须实现FULL事务内单root+permit原子消费、精确幂等、内部预算与已有graph_actions准入、崩溃后查询/停止/对账而不重发unknown。J12必须真实owner/operator/无自动迁移打开、白名单bootstrap、hold后态与绑定候选恢复验证；离线DDL不够。
- 不要求先做J12.full_recovery/J17.recovery、通用broker容量、远端主管、全部后续recipe迁移、默认启用或J32收益结论；若启用broker则不能沿用local例外。
- 这是已有依赖图的摘录，不是新设阻塞。逐gate原字段、行号、完整递归前置和Git blob见supplement.json；门槛仍是specified_not_run。

原a、a-audit-trace与root-review-a均不修改。
