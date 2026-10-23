# OSBot 独立会话 Handoff

更新：2026-09-13。交接目标：在独立会话中继续定义 OSBot 功能、验证 Rakazo 适配和规划本地服务器部署。本文件可以直接作为新会话的起始上下文。

## 1. 用户原始目标与本次分工

用户明确：

> osstack 是公司和个人内部使用的编程强化工具，主要具有 Loop Engineering 和 Graph Engineering 的能力。同时需要自己的 Grok Bot，例如命名为 osbot，它与 ostag 不同，部署在本地服务器。

用户随后决定：OSBot 的功能另开 session 继续；当前 OSStack 会话集中制定详细升级实施计划。因此，新会话负责 OSBot，避免同时修改 OSStack 图内核或 OStag 业务流程。

已知方向是“持续数字同事”。研究、文件处理、工程任务委托是**建议的试点场景**，不是用户已经逐项确认的功能清单。尚未确认服务器条件、首个具体任务、公司/个人试点顺序和推理方案。

## 2. 三产品边界

| 产品 | 长期定位 | 状态与动作责任 |
|---|---|---|
| OSStack | 内部编程强化引擎 | 工程 Loop/Graph、受管仓库候选修改、验证、worktree 与代码执行账本 |
| OStag | 组织协作、业务工作流与治理 | 来源线程、业务 case、actor/频道权限、收据、连接器、跟进与现有发布流程 |
| OSBot | 自托管的持续数字同事工作台 | bot 身份、mission、长期上下文、记忆、routine、工作电脑及浏览器任务 |

个人研究只需 OSBot；直接编程只需 OSStack；业务表更新只需 OStag。跨域任务按需组合。不要为了统一而要求所有任务都经过三个产品。

OSBot 可以在隔离环境运行 Python/临时脚本处理数据或生成文件。正式工程交付委派 OSStack；限制的是受管仓库写入与发布权限，不是禁止一切代码执行。不能仅用 scratch 目录或 system prompt 当作权限隔离。

公司系统记录写入交 OStag 的受控业务能力。个人资源操作按 OSBot 自身的明确授权办理。公司 OSBot 收到新增授权需求，转所属组织收据流程，不能由 bot 自答；按目标资源和父授权链判定，不按最后一跳界面判断。

## 3. 已完成研究与本地资产

### Rakazo

- 上游：[elie222/rakazo](https://github.com/elie222/rakazo)。它自称开源 Grok Bot alternative，不是 xAI 官方源码。
- 本地路径：`/Volumes/AIMATE_WORK/Developer/CodeX/rakazo`。
- 检查提交：`b286fc4a5d0f608005000ef35bee4c473c31a165`。Apache-2.0，README 标为 beta。
- 本轮仅 clone 与读取；**没有安装依赖、运行 Docker、调用模型或部署服务器**。最后检查 clone 为 clean；新会话仍应重新核对状态。
- 主要栈：TypeScript，Web/Electron/Expo，API/worker，Postgres/Prisma，Graphile Worker，Pi agent runtime，Docker/E2B/Daytona/Box computer provider。
- 已有持久 bots、memory、routines、peer/subagent 委派、computer/desktop/browser 工具。具体场景可靠性未实跑。
- Pi 在 API/worker 中运行，电脑 provider 是独立执行环境；不要假设模型运行在电脑容器内。
- 自定义 MCP server 的登记代码已在 `packages/adapters/src/executor.ts` 核实，README 也支持 MCP/OpenAPI 工具接入。完整 OSStack job bridge 尚未实现或验证。

### OStag

- 路径：`/Volumes/AIMATE_WORK/Developer/CodeX/OStag`，检查基线 `5098f9141864d413718d776c9ae783951ea4b5c1`，完整 SHA 在证据 manifest。
- Python 项目，已有来源线程、业务治理、receipt、connectors、follow-up 和 Copilot relay。
- `ostag/workflows/github_vercel_release.py` 实际调用 SHA 绑定 GitHub APPROVE 与 Vercel Production 发布；不能假设它只是通知层，也不能在 OSBot 再部署一次。
- OStag 既有工作区可能有其他任务改动；此 OSBot 会话应以读取和接口协作为主，不覆盖它。

### OSStack

- 路径：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack`，检查基线 `b476bcc3fbbfcc11953abd3d154e59f7f85c4660`，当前研究分支 `codex/graph-readonly-pilot`。
- `graph explain` 只读；真实可执行图有方案但未实现。
- 图方案首选 LangGraph.js 独立 worker + 受控 broker + checkpoint/动作账本；不要求 OSBot 也改用 LangGraph。
- 已有的 12 项离线图实验不是 Rakazo、OSBot 或跨产品部署验收。

## 4. 默认采用路线

先使用**固定上游版本 + 独立部署配置 + 窄集成**。OSBot 可先是内部服务名称，不必整仓改名。Rakazo 已有自托管、身份与持续 bot，不能以“需要自己的身份”为理由直接 fork。

只有功能验证证明现有扩展点无法满足必要工具政策、协议、身份边界或 UI，才做最小 tracking fork，记录补丁目的、上游版本与升级验证。不要从零重造持久电脑、桌面接管、通用 agent runtime 和多端聊天。

不读取主分支名称就认为是稳定发布。上游 self-host 文档默认 image tag 为 edge；真正试点应固定经过核实的版本或 digest，并记录可恢复的备份。当前没有选择镜像 digest。

## 5. 阅读源码时必须记住的发现

1. **浏览器文档有漂移。** `VISION.md` 描述 Team browser identity 共享方向；当前 `docs/computer-runtime.md`、`packages/core/src/node/desktop-runtime.ts` 和 `infra/sandboxes/supervisor/src/browser-profile.test.ts` 描述 per-bot 独立 profile，不相互复制。不能把共享登录当作已验收能力。
2. **Team 文件不按 bot 安全隔离。** `bots/<id>` 只是目录组织；同 Team 的 bot 可访问共同工作区。公司与个人不能共用这个边界。
3. **Docker supervisor 是高信任服务。** `infra/compose/docker-compose.yml` 挂载 Docker socket；普通 bot 容器不应得到 socket。容器化不等于对宿主的完全隔离。
4. **秘密有不同存储位置。** 模型 provider 凭据、服务端加密的 connector 凭据、浏览器 cookie/profile 分别处理；不能说全部只在电脑 checkpoint。
5. **没有 API key 不等于没有写能力。** GitHub/Vercel 等浏览器登录状态也是写通路。首期公司 bot 不配置能绕过工程/业务治理的高权限登录、repo 写凭据、正式仓库挂载或直连写 connector。
6. **持久身份不等于无期限单任务。** bot 可以长期存在，但每个 mission/子任务仍要有完成、暂停、失败和停止条件。
7. **自托管不等于零外发。** 本地控制面、本地推理、浏览器/连接器网络访问是不同选择；分别定义。

## 6. 本地服务器方案的已定与未定

已定方向：OSBot 控制面常驻自有服务器。OStag 可在同机独立服务或已有宿主；OSStack 工程 worker 可在服务器或现有 Mac。不要为“都在本地”把生产代码目录、控制面 DB 和所有个人账号挂进 bot 电脑。

首期建议个人/公司分实例、服务身份、数据卷和密钥。同一物理机仍共享管理员和故障域。若资源只够一个试点，先选择一个数据域，不混入另一域真实账号。

需要新会话澄清的条件，尽量一次收集最影响方案的部分：

- 首个实际任务是什么，最终成果在哪里验收？日常是否真需要浏览器/桌面，而不只是聊天？
- 个人还是公司先试点？首批由谁使用，哪些信息、账号、应用可接入？
- 服务器在哪里，OS/CPU/内存/磁盘是什么，有没有现成 Docker 和备份？
- 只内网/VPN 访问，还是需要域名与远程入口？
- 采用哪些模型、本地还是外部 API，日常成本上限和允许外发的数据范围？
- 有哪些真实写操作需要第一版支持？哪些已具备明确授权？

这些是部署和功能设计输入，不需要为了继续阅读源码逐项等齐。依赖尚未明确的信息用假设标注；不要把用户另开功能会话误解为已授权安装、连接账号或对外发布。

## 7. 与 OSStack / OStag 的接口约束

优先 `submit / status / cancel / result`，存在真实暂停点再支持 `resume`。HTTP/MCP/OpenAPI 是传输选择，不能用“接上 MCP”代替语义设计。

必须具备：

- 来源 principal/tenant、父 mission/case、子 operation、workspace/scope、deadline/预算、委托授权与版本化输入。
- 稳定幂等键绑定来源、父子任务和一次发生；inputDigest 只覆盖规范化业务字段。相同 key 不同内容拒绝。
- 提交超时查询原 job，不新建 key 盲重发；未知投递/副作用明确显示。
- 状态保留 ready、approved、applied、published 的区别；附产物与权威证据引用。
- 同一个叶子动作仅一个执行 owner；父任务可提醒和追踪，不能重复其内部重试。OSStack 回结果/授权需求，不反向创建无限业务任务。
- routine occurrence 冻结 scheduleRevision；编辑不改写在途任务；默认 skip_busy 并记账，可选有界排队。旧 occurrence 同 key 不同输入拒绝。
- 按需传最小上下文，不复制完整记忆库、cookie、密钥或底层 DB。

首期 OSStack 工程委托结果停在候选分支与证据，不自动 merge。若合并触发生产部署，合并本身属于发布授权范围。实际 merge 与 deploy 各登记唯一执行者；不能假设 OStag 已有 merge 功能。

OSBot 自身的第一版不依赖工程 Graph 完成。新的 graph v1 委托接口要等 OSStack G24 契约冻结；此前可用 stub 验证产品交互，或在明确需求下单独验证已有受控 session 接口，但不得把 stub 或旧 session 宣传成已实现 Graph 联动。

## 8. 新会话建议推进顺序

1. 核对本 handoff、三产品定义和本地 repo 状态；把用户的新想法合并到功能范围。
2. 选定一个任务、一个数据域、一个 bot 和明确验收样例，确定其最小权限与必要电脑能力。
3. 做 Rakazo 能力映射：已有功能、配置即可、需要 connector、需要核心修改、未知待测；据此决定是否 fork。
4. 形成具体功能规格和服务器部署计划，区分控制面、数据、secret、电脑、备份、访问和更新责任。
5. 在新会话获得相应实施范围后，用隔离试点验证持久文件、暂停恢复、停止、用户接管、权限和结果，再接真实受控数据。
6. 最后验证工程委托和 OStag 业务闭环；可以先用 mock provider 测幂等与结果协议，不依赖未完成的工程 Graph。

建议验收：一次目标任务真正完成；重启后工作可继续；重复提交不重复子任务；取消未确认时不伪报停止；公司/个人数据不越界；有真实产物和成本/时间记录。

## 9. 现有完整文档

- [三产品定义](/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/design/2026-09-13-os-products-definition.md)
- [三轮产品评审纪要](/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/reports/2026-09-13-os-products-claude-review.md)
- [原始评审与源码 manifest](/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/reports/2026-09-13-os-products-evidence/README.md)
- [OSStack 工程图设计](/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/design/2026-09-13-executable-graph-plan.md)
- [OSStack 新的详细实施计划](/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/implementation/2026-09-13-osstack-graph-upgrade.md)
- [Rakazo README](/Volumes/AIMATE_WORK/Developer/CodeX/rakazo/README.md)、[self-host](/Volumes/AIMATE_WORK/Developer/CodeX/rakazo/docs/self-host.md)、[computer runtime](/Volumes/AIMATE_WORK/Developer/CodeX/rakazo/docs/computer-runtime.md)

此前 Claude Fable 5.1 的三轮意见已经记录并经源码纠正。不要直接照搬第一轮的“立即 fork”“禁止所有脚本”或“所有凭据只在浏览器 checkpoint”判断。

## 10. 可直接粘贴的新会话起始指令

> 请先阅读 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/handoffs/osbot/handoff.md`。本会话独立负责 OSBot 的具体功能定义与本地服务器试点规划，OSStack 工程图升级由另一会话负责。结合我接下来提供的功能需求和 Rakazo 当前源码，确定首个用户场景、功能边界、采用上游或最小 fork 的依据、与 OStag/OSStack 的接口，以及部署验收计划。请保留 handoff 中已核实的边界，区分已实现能力、待验证假设和本次实际执行结果。
