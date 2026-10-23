# 三产品定位：Claude Fable 5.1 评审纪要

日期：2026-09-13。输入为用户最新目标、OSStack 图方案、OStag 本地源码以及 Rakazo 固定源码。三轮主评审均使用 `claude-fable-5-1`，禁工具与嵌套 skill；原始上下文、答复、模型记录见 [证据目录](2026-09-13-os-products-evidence/README.md)。

## 第一轮：独立定义

Claude 支持 OSStack 管编程强化、OStag 管组织业务治理、OSBot 管持续身份与电脑，并指出三者都有 agent 和调度能力，容易重复执行。

它另提出立即 tracking fork Rakazo、OStag/OSBot 禁止代码执行、凭据只放电脑 checkpoint。这些判断随后被挑战，并未直接采纳。

## 第二轮：反例与收敛

主研究以具体场景和源码反驳：OSBot 的数据处理需要 scratch 脚本；OStag 的非编码 backend 仍有价值；Rakazo 已提供自托管身份与 MCP 扩展；秘密分别存在模型/连接器服务和浏览器状态中；routine 可以合法发起新 occurrence，而非只能提醒。

Claude 撤回上述三个过强判断，接受固定上游版本 + 窄 connector 先行，并补充：

- 临时目录不构成权限边界，需限制真实凭据、挂载与发布通路。
- digest 排除请求时间/trace；重试保留 parent/child id。
- routine 版本与 occurrence 固定，声明重叠执行策略。
- 同机不同实例仍共享宿主管理员与故障域。

第二轮中的“OSStack 独占所有仓库写凭据”和“所有 scope 扩张必须回 OStag”等绝对表述未被照单采纳。前者与 OStag 已有 GitHub/Vercel 发布 executor 冲突，后者忽略个人 CLI 使用场景。最终按具体动作、目标资源授权域和父授权链界定。

## 第三轮：源码纠正后的最终核对

补入三个具体事实：Rakazo 已实现 MCP server 注册；OStag 发布源码调用 GitHub APPROVE 和 Vercel Production 发布；Rakazo 的 VISION 与当前浏览器 profile 文档/测试存在差异。

Claude 未发现需要推翻三产品定位的矛盾，但指出四处需补齐的边界；主研究已在最终文档落实：

| 问题 | 最终处理 |
|---|---|
| merge main 可能自动部署，绕开发布回执 | 初期工程联动 artifact_only；登记每仓库 merge/发布唯一 owner 与实际触发规则；自动触发部署的 merge 也属于发布授权范围 |
| 浏览器 cookie 也能写 GitHub/Vercel | 公司 bot 不配置具备受管仓库/发布写权限的登录状态，不能只禁 API key |
| 公司 OSBot 收到 needs_authorization 可能自答 | 按目标资源授权域与父授权链回组织收据；个人资源回个人授权界面 |
| 编辑 routine 后重投旧 occurrence | 保留旧输入；同 key 不同 digest 拒绝并记账 |

这些修订使定义可作为后续试点与实施依据。第三轮没有执行产品代码，也没有验收未来实现。

## 最终决策

保留三个产品职责，但不新造三套底层平台：OSStack 深化工程执行；OStag 保留组织工作流与业务治理；OSBot 优先复用 Rakazo。暂不增加 OSGraph 产品，不立即整仓 fork，不合并底层 DB，不要求每项任务都经过三个系统。

成果：[产品定义](../design/2026-09-13-os-products-definition.md)、[更新 Context](2026-09-13-os-products-context.md)。本轮仅源码阅读与文档交付；未部署服务器、未运行 Rakazo、未修改生产执行代码，也未改动 OStag 源码。
