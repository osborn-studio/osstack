# OSStack 入口命名约定

状态：用户已确认的产品命名，2026-10-28。用于后续实现、用户提示、帮助、技能展示和委派模板。命名确认不代表这些入口已经安装、注册或通过实际宿主验收。

| pstack 来源名称 | OSStack 正式名称 | 职责 |
| --- | --- | --- |
| `/poteto-mode` | `/osstack-mode` | 总入口：理解任务、选择 playbook、组合适用技能 |
| `/poteto-help` | `/osstack-help` | 解释适用技能、流程和原则，提供可用提示词 |
| `/setup-pstack` | `/setup-osstack` | 配置不同角色使用的模型与推理预算 |
| `poteto-agent` | `osstack-agent` | 供被委派 Agent 使用的工程方法包装 |

Codex 与 Claude 的用户材料使用相同的 OSStack 名称。宿主的技能发现、调用语法和配置格式仍分别适配并实测；不得因文档写有斜杠入口就声称宿主已注册命令。`osstack-agent` 是方法包装名称，不自动创建进程、授权或独立验收身份。`setup-osstack` 不因被提及就修改模型配置或预算。

原始研究报告、来源路径、固定提交链接、原始审计和历史证据保留 pstack 原名。能力追溯以本表映射，避免改写来源名称导致锚点失效。新增面向用户的入口不得再以 poteto/pstack 命名；本轮未添加旧名称兼容别名。

当前 `osstack-methods` 是已交付的共享方法材料名称，保留其现有四项方法入口；不将它的存在冒充以上四个专用入口全部实现。后续实现应分别验证：入口可发现、方法选择正确、角色配置符合宿主支持范围、委派包装保持任务边界，并保存 Codex/Claude 实际执行证据。

## 全包适用规则与源码扫描

用户进一步确认：**所有吸收进 OSStack 的功能、技能、Agent、包与配置入口，品牌 token `poteto`、`pstack` 均采用 `osstack`**，不仅上述四个入口。已只读扫描固定上游 `99b609a72323b70204eab407c622f436e858e112` 的 200 个文件：58 个注册技能（其中 24 个原则技能）、3 个未注册自动化技能、2 个 Agent、23 个内部 playbook；193 个文本文件共 359 行命中。完整逐项映射、路径/哈希和来源见[扫描清单](entry-point-source-inventory.md)及[机器可读清单](entry-point-source-inventory.json)。

扩展映射包括插件 `pstack` → `osstack`、宿主具备对应命名空间时 `/pstack:<skill>` → `/osstack:<映射后名称>`、`pstack-models` → `osstack-models`、`poteto-mode-tools` → `osstack-mode-tools`，以及相应目录、文档入口与缓存标识。无品牌 token 的叶子技能名保持原名；内部 playbook 不因此变成独立命令。

扫描未发现上游树内部的目标名称冲突；宿主已有安装仍须在安装阶段检查。不得伪造 `osstack@cursor-plugins` 安装坐标，也不沿用未获授权的 `@cursor-skill` 发布归属；清单中的包名映射不是发布指令。既有 `.osstack`、`OSSTACK_HOME` 和 `skills.config.yaml` 必须复用其既定职责，不能被上游模型规则覆盖。

替换按品牌标识进行，不按任意子串批量替换：`upstack`、`pendingUpstack` 等虽然含字符 `pstack`，实际表示 PR 堆栈操作，必须保留。作者账号 `poteto`、Lauren Tan、许可、原始安装坐标、固定源码 URL 和历史证据保留真实身份。导入图像若含品牌需另行检查；本轮文本扫描不声称完成图像识别。
