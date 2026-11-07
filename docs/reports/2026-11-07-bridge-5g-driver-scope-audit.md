# 5-G 驱动实际效果与覆盖审查

日期：2026-11-07。独立静态读取对象：`scripts/smoke-bridge-revision-sandbox.mjs`，提交 `0153682f`，文件 SHA-256 `0e7ffbbd4f6473a85b8562840df0379d2b1970f3b1e19ed962b869e6205a472b`。该文件来自独立 N10 分支，本 docs 分支没有复制或修改它。行号均指该版本。

本次没有运行 preflight、`--execute`、构建或外部写入。审查不代表 5-G 通过。对照：[阶段 5 §5.7](../design/2026-11-06-bridge-same-pr-revision.md#57-沙箱端到端5-g)。

## 实际效果范围

| 入口/位置 | 实际动作 |
|---|---|
| 默认 `runSmoke`（344–347） | 只进入 preflight，不调用 execute。但 preflight 不是全 HTTP 只读：97–100 调用三个 App token source 的 `token()`，其真实实现会 POST installation access token。没有创建 PR、推送或发 review |
| preflight（77–110） | 从 ADR 读沙箱、核对固定仓库名/id 和未用分支前缀；检查私钥与 Codex auth 文件权限；执行 Codex `--version`、Docker info/image inspect；加载构建后的工厂；检查 ruleset 存在且 active。它没有真实执行 Codex proposal 或验证容器任务 |
| execute 初始化（126–171） | 分配私有 smoke scratch/home；写隔离 App/issuer/授权配置，clone 沙箱；打开该 home 下的真实 SQLite，生成内存签名密钥；构造真实 ports、Host 和生产工厂。Codex 使用 `gpt-6.1-sol`，Docker 使用预检得到的 daemon/image id |
| 根与子 Mission（207–247） | 根经 `host.start`，修订经 live scan/host tick；真实 Codex/Docker/App A/App B 效果由生产 ports 执行。入口是内部 Host/工厂，不是常规 CLI `serve` live 启动；不能据此宣称常规 live 验收门已打开 |
| review（203–205、263–264） | 两轮/第三轮/通过 review 使用沙箱测试 Reviewer App；未登记账号探针使用宿主 `gh`。测试 Reviewer 不是阶段 6 App D，也没有启用既有 Grok Reviewer |
| 越权探针（249–273） | 宿主凭证尝试推当前运行的分支；App A 用 REST `PATCH git/refs` 尝试强制回退；宿主账号提交未登记 CR；Codex 接收工作流注入请求并等待 T2 |
| 取消/撤权（274–290） | 对已 dispatch、尚未首次 host tick 的子取消；重建 Host/bridge 对象并 recover；另一个子在首次 tick 前删除 write scope |
| 清理（312–338） | 停本轮服务；按运行分支前缀补查本轮 PR；用 App A 关闭记录的 PR。保留受保护分支、私有 DB 与证据；没有合并、删除分支、修改 ruleset 或 App 设置的代码路径 |

`assertRequest` 限制的是该 helper 的 method/path，不是覆盖所有效果的总代理。实际 git push、根 PR/App B check 由 ports 执行，宿主未登记 review 由直接 `gh` 命令执行。审查必须覆盖这些路径，不能仅以 helper 单测通过声称所有外部写入都受它拦截。

## §5.7 逐项映射

| 设计要求 | 实现位置与断言 | 覆盖边界/缺口 |
|---|---|---|
| A：两轮修订后通过 | 238–241 调用 `rootMission`、`twoRounds`，测试 App 对实时 published head 发 APPROVE，等待 `ready_for_human`；227–234 核对两轮 head 前移、子 `pr_opened`、confirmed push 数量 | 有真实效果路径。当前没有读取两次远端 push 的 actor/快进事件作为独立 App A 归因证据；依赖受审生产代码的凭证路径。verify 只检查目标文件非空，不断言 `stage N` 精确内容 |
| B：第三轮转人且不能超过 2 | 242–248 等待 `rounds_exhausted`，核对 reservation 数不增加，并拒绝 rounds=3 的 renew preview | 有执行和结果断言；`assert.rejects` 未限制具体拒绝码。仍需真实执行记录 |
| 宿主凭证推 Mission 分支被拒 | 249–257 创建真实 commit-tree，使用宿主 helper push，要求失败和 porcelain `[remote rejected]` | 有真实 smart-HTTP push 探针；本次未执行。未把该探针的完整失败证据写入最终报告，只记录场景布尔值 |
| App A 非快进被 history 规则拒绝 | 258 发 App A REST 强制回退，180–182 要求 403/422 和规则拒绝文本 | 真实 GitHub ref 写入探针；不是 `git push --force-with-lease` 负向路径。智能 HTTP 的 lease/非快进证据仍要引用独立 P-13，不能混称同一探针 |
| 未登记账号 CR 忽略 | 260–267 读宿主 user，确认不在 reviewer registry，发真实 CR，scan 后链仍 ready | 有真实 review 路径和链状态断言。该账号有无所需写权限仍需预检/执行证据 |
| 注入 `.github/workflows/` 被 T2 拒绝 | 268–273 请求受保护路径，等待 `halted/tier_escalated` 且含 `PROTECTED_PATH`，要求没有 push 意图 | 对应明确分类断言；真实 Codex 是否提出该候选需实际运行，不能以提示词存在替代结果 |
| 取消后重启不推送 | 274–283 在 dispatch 后、执行前取消，关闭并重建 Host/bridge，recover 后要求取消状态且无 push 意图 | 覆盖“执行前取消 + 对象重建”。复用同一 ports、DB、owner；没有启动新的 OS 进程、重开 DB 或 owner generation，因此不是完整 daemon/进程重启证据，也不覆盖在途发布时取消 |
| 删除 write scope 后栅栏拒绝 | 284–290 在首次 tick 前删 scope，等待 `grant_invalid` 或子 awaiting_decision，要求无 confirmed push | 证明执行前授权守卫路径；没有把子推进到 publishing/W13 已登记未 release 点，因此不能单独证明发布 release 栅栏拒绝撤权 |
| 时间线与账本逐提交/逐 head 一致 | 292–307 将 confirmed open_pr/push ranges 拼接，与 compare 返回提交列表对比；逐 head 查询 App B check，要求名字、App id、external id、head 与 success | 有范围/check 对照；以下终态远端 head、range 完整性和 App A actor 缺口仍需修复/补证 |

## 必须分开的证据缺口

1. **最终比较的终点来自本地账本。** 298 行读取 `root.start_commit...c.published_head`，没有独立重读实时 PR head 或 `ls-remote` 并证明其等于 `published_head`。如果远端在最后一次 live cycle 后多出提交，当前比较可能完全不包含它。要证明“无多余提交”，需先读真实远端 tip，再对实际 tip 的完整范围对账，保留读取一致性/并发变化处理。
2. **时间线 helper 的后置条件不完整。** 115–118 对缺 range 使用空数组回退；119–122 的 check head 来自 intent.new_head，没有同时证明它等于对应 range 的最后一个提交。独立 sandbox CLI 已报告三个确定性 RED：GET URL 规范化越界、confirmed intent 缺 range、check head 与 range tip 不一致。本审查没有运行这些测试；其实际证据归该 CLI 的记录。脚本所有者负责修复，本 docs 节点不改脚本或测试。
3. **App A 归因没有远端读回。** 最终只读取 compare 和 App B checks，没有 PR commit/timeline actor 的读回。真实 App A ports 是执行依据，但与“远端两次 push 均由 App A、均快进”的独立验收证据不同。
4. **重启与撤权的时点较早。** 对象重建、执行前取消、执行前撤权都是真实路径，但不能替代发布中断/真实进程重启或 release 前撤权。对应 W13/5-F 的故障测试须单独列证据；如要把它们计作 5-G 端到端覆盖，应补充真实进程和发布阶段控制点。
5. **最终报告压缩了探针证据。** 场景多数只保存 `passed:true`；33x 行快照保留 chain/intent/head，却没有完整 PR/head/review/check run id、push 归因、规则拒绝返回的逐场景证据引用。应把可复核输入/结果和脱敏原始引用写入报告，而不是靠成功退出重建过程。

代码中的 `report.qualified=true`（308）只代表这一版脚本现有断言全部返回，不能抵消上述缺口。修复代码、保存确定性验证证据并完成经授权的真实沙箱执行之前，本报告将 5-G 结果记为 **not-run / 尚不能判 pass**。它不是空驱动，但也不是阶段 6 平台已接通或生产 live 已启用的证明。
