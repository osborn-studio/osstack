# OSStack / OStag / OSBot 更新 Context

日期：2026-09-13。供后续产品设计、Claude 评审与实现任务使用。

最新工作分流：用户决定 OSBot 功能另开 session，专用 [handoff.md](../handoffs/osbot/handoff.md) 已形成；当前 OSStack 升级以 [30 张任务卡实施计划](../implementation/2026-09-13-osstack-graph-upgrade.md) 推进。产品定义不代表上述任务已实现。

## 用户最新意图

OSStack 长期用于公司与个人内部编程强化，核心是 Loop Engineering 与 Graph Engineering。用户还需要部署本地服务器的自有 Grok Bot 类产品 OSBot，并要求区别于已有 OStag。用户给定参考仓库 `https://github.com/elie222/rakazo`。

当前按“综合数字同事”定义 OSBot，首批场景为研究、文件处理、工程任务委派。用户尚未指定服务器 OS、硬件、模型推理位置和具体业务任务，不据此声称已部署。

## 产品定义

- **OSStack**：内部编程强化与工程执行引擎，负责受管仓库的实现迭代、工程图、候选版本、验证、工作区租约和工程动作账本。
- **OStag**：组织中人与 agent 协作、业务工作流与变更治理，负责来源线程、业务 case、actor/频道授权、收据、连接器、跟进与现有发布流程。不是 tagger 或 IM 转发壳。
- **OSBot**：自托管的持续数字同事工作台，负责 bot 身份、mission、记忆、routine、电脑与浏览器上下文。公司首版只读研究、草稿、工程委派；其他授权能力以后扩展。

图执行留在 OSStack 内，暂不新增第四个 OSGraph 产品。三者按需调用：个人开发只用 OSStack，业务记录办理只用 OStag，个人研究只用 OSBot。跨域任务才组合，不强制串行经过所有产品。

## 复用与边界

OSBot 默认先使用固定上游版本的 Rakazo + 独立部署配置 + 窄集成。无需为身份或自托管而先 fork，上游已经有这些能力。只有必要工具政策、接口或 UI 扩展受阻，才考虑最小 tracking fork；不从零重造持续电脑与通用 agent runtime。

OSBot 可在隔离环境执行数据处理脚本，不能借此拥有受管仓库写凭据、生产挂载或绕过 broker 的发布能力。OStag 非编码 backend 可保留纯推理/受限只读工具；真正工程写任务渐进委托 OSStack。

OStag 已有 GitHub/Vercel 发布 executor；不能把“OSStack 管工程”解读为它现在必须接管所有发布或独占所有 GitHub 凭据。按具体动作保留一个执行者；如迁移，显式切换。组织审批归 OStag，执行端仍验 scope/expiry/revocation；同一有效授权不重复询问。新增范围返回原发起方的授权流程。

首期工程联动 artifact_only，不自动合并受保护分支。每仓库登记 merge owner、发布 owner 和 CI/CD 触发规则；能触发生产部署的 merge 按发布效果授权。不能假设 OStag 已有 merge 能力。公司 OSBot 的 needs_authorization 回所属组织收据，不得自答；个人资源回个人授权界面，按资源授权域而非最后一跳产品判断。公司浏览器不配置可绕过 broker 的仓库/发布账号 cookie。

每个领域分别拥有权威状态。OSBot mission、OStag case/receipt、OSStack engineering job 通过引用关联，不合并数据库，不重复重试同一子动作。稳定幂等键与规范化 inputDigest 分开；重试复用原 mission/child；未知投递先查原 job。routine 发生记录冻结 scheduleRevision，有 overlap 策略。

## 实际核实

- Rakazo 已克隆：`/Volumes/AIMATE_WORK/Developer/CodeX/rakazo`，SHA `b286fc4a5d0f608005000ef35bee4c473c31a165`，Apache-2.0，beta。
- Pi 位于 API/worker，computer provider 是另一层；模型工具循环不等于有显式质量契约的工程图。
- 自定义 MCP server 注册路径已在 `packages/adapters/src/executor.ts` 核实，README 也描述 MCP/OpenAPI；完整 OSStack job bridge 未实现/验收。
- Rakazo VISION 的共享浏览器身份与当前 computer-runtime 文档/per-bot profile 测试存在差异；不能宣传共享登录已验证。Team 文件共享不是安全隔离。
- Docker supervisor 持 Docker socket；普通 bot 不能获得它，不能宣称容器完全隔离宿主。
- OStag 基线 `5098f914`，真实发布流程位于 `ostag/workflows/github_vercel_release.py`；源码存在不意味着当前服务器外部验收已完成。
- OSStack 基线 `b476bcc`，可执行图方案尚未生产实现。先前 12 项离线图探针不是 OSBot 或跨三产品集成测试。

## 部署原则与下一步

OSBot 控制面在本地常开服务器；OStag 可同机独立服务；OSStack 在受信任工程 worker（服务器或现有 Mac）。个人/公司分实例、服务身份、卷与凭据，同机共享管理员和故障域。本地托管、模型本地推理、零网络外发是三个不同选择。

下一步可并行开展 OSBot 单数据域试点准备与 OSStack 图 P0 接缝改造；当前仅交付产品定义和证据，没有部署、迁移 DB、替换 backend 或修改业务代码。

完整依据：[产品定义](../design/2026-09-13-os-products-definition.md)、[三轮评审纪要](2026-09-13-os-products-claude-review.md)。既有图实施任务继续见 [工程图计划](../design/2026-09-13-executable-graph-plan.md)。不要覆盖用户修改的 AGENTS.md 或 OStag 其他工作；任何开发 OSStack DB 操作须显式隔离 OSSTACK_HOME。
