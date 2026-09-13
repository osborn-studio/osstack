**结论先行**：三个产品可以并存，但只有在 osbot 采用「跟踪式 fork Rakazo、最小补丁」且 OStag/osbot 都不再自带代码执行能力的前提下才成立。否则应砍成两个。

## 一、三者定义

**OSStack**
- 服务对象：写代码的人和他们的编码 agent，个人与公司共用同一工具、不同 OSSTACK_HOME。
- 核心场景：仓库范围内的交付。Loop 负责质量迭代，Graph 负责显式节点 I/O、并行汇合、失败处理与停止规则。
- 唯一负责的状态与动作：worktree 与候选执行、任务关系图、图 checkpoint、动作 ledger、写锁与 repo scope、编码 agent 的 invoke。
- 不做：业务系统写入、审批、群消息、持久化非编码身份。它不是公司工作流平台。

**OStag**
- 服务对象：在飞书、钉钉、Slack 群里协作的业务、产品、运营团队。
- 核心场景：群线程触发受治理的 run，对系统记录（需求表、任务、Issue、PR 发布）做提案、审批、执行、回执。
- 唯一负责：receipt 状态机、actor 权限与频道策略、连接器执行、run ledger、follow-up、ambient 监控、线程回复。
- 已实现部分即上述；愿景部分（MFS 深化上下文、admin 控制台、沙箱化代码执行器）中，「代码执行器」应当放弃，改为委托 OSStack。

**osbot**
- 服务对象：个人与小团队，需要持续存在、能用电脑和浏览器完成非仓库工作的数字同事。研究、邮件、文档、网页操作。
- 唯一负责：bot 身份、单一连续会话、私有记忆、routine 计划提示、Team/Private Computer 的持久工作状态与浏览器身份。
- 明确边界：部署在本地服务器只保证控制面和文件在本地，模型调用与 OpenRouter/浏览器访问仍然出网。这必须写进产品说明，不能被表述成数据不出网。

## 二、共享、不共享与调用关系

- 共享：模型 provider 配置的选择理念，审计的「先记 intent 再执行」原则，以 stable effectKey 做幂等。
- 不共享：三者各自的数据库与账本不合并。OStag 的 JSONL ledger、OSStack 的 SQLite、osbot 的 Postgres 各自权威，跨系统只传引用和签名事件。
- 调用方向：OStag 与 osbot 只产生意图并接收结果。任何涉及仓库的执行一律进入 OSStack。osbot 需要治理写入业务系统时经 OStag 连接器，不自建飞书写入。OStag 的 kimi_cli/codex_cli 编码后端应退役或改成调用 osstack。

**是否过多**：真正重叠在 OStag 与 osbot 都是「从聊天出发让 agent 干活」。切分规则只有一条：碰系统记录走 OStag，碰持久身份和电脑走 osbot。如果你不打算认真运行 Team Computer 与浏览器身份，osbot 没有独立存在理由，应并回 OStag 的 backend。

## 三、osbot 路线与四个问题

**路线**：选跟踪式 fork。Apache2 允许，Pi runtime、Graphile Worker、Docker supervisor 从零重造代价太高。规则是 upstream 分支持续合并，自己的改动限于品牌、认证、以及一个对外的执行器契约，让 OSStack 与 OStag 作为外部 provider 接入。薄适配不够，因为你需要自有身份与账号边界。从零造是错误选项。风险要记录：beta 漂移，supervisor 持有 Docker socket，不能宣称完全隔离宿主。

**1. 编码执行所有权**：OSStack 是唯一执行者与唯一调度者。OStag receipt id 或 osbot request id 作为 effectKey 写入 OSStack ledger，重复提交只返回同一结果。OStag follow-up 与 osbot routine 只做提醒和轮询，不重放执行。

**2. 个人与公司分离**：OSStack 按 OSSTACK_HOME 分家。osbot 公司与个人各跑独立实例，不靠单实例 Space 隔离，凭据只存在 bot 电脑的身份 checkpoint 里，永不进入 OStag 或 OSStack。OStag 按 actor 与频道授权。三者不做跨实例记忆同步。

**3. 一条飞书需求**：群内 @OS Tag，OStag 建 run 与需求表 receipt，审批后写表。需要改代码时，OStag 建受治理任务交给 OSStack，产出 PR 后再由 OStag 的 SHA 绑定发布回执收口。仅当需要浏览器调研或非仓库产物时才经 osbot，结果仍通过 OStag 回执落地。纯表更新只走 OStag，个人写代码只走 OSStack，个人研究只走 osbot。

**4. 首期研究边界**：交付三份东西，不写产品代码。第一，所有权矩阵，每种状态有且只有一个 owner。第二，两个集成契约草案，OStag 到 OSStack 的任务提交与结果回执，osbot 到 OSStack 的执行 provider。第三，Rakazo 在本地服务器的自托管冒烟记录，含 Docker computer 资源占用与 socket 风险清单。成功指标是矩阵零重复 owner，一条端到端场景的交接点与幂等 key 全部标出，以及 fork 与否的决策被明确记录。可执行图运行时与 osbot 部署都不在本期。
