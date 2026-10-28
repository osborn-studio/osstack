# 下一批有限切片预检（新宿主事实后的排序）

只读基线 main `ca95aba1c186d9c3a9e70a45143b7a277db84404`，PR293 `1372cb3fc065fb663b22c22cc21a3c01aee95a01`，PR294 `5929180db44a6d05f0f6f2de1cb731fd273665dd`。原pstack pin `99b609a72323b70204eab407c622f436e858e112` 的真实Git源码已读取。v1草案原样保留。

推荐第一项：固定双案例证据投影。原始完整机器证据与模型可读输入有不同需求，不能一边提供包含environment的完整command记录，一边要求模型不读其中environment。此次只提出未来修复，Codex本轮边界limited及Claude507词超限原结论不变。

新事实直接读取 scratch 中 independent/host-journey/phase1-graded-results.md、phase2-graded-results.md 和原phase2 prompt：没有live环境/凭据读取证据；问题是提供记录字段与冻结规则冲突。词数超限是另外一条失败轴，不能由投影修复冒充关闭。

## 1. 固定双案例旅程的模型可读证据投影与可执行输入边界

原始来源：[pstack/skills/create-verification-skill/SKILL.md L25–L40](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md#L25-L40)

**现状/缺口**：PR294保留完整机器审计环境、command/raw/manifest，并以其验证fixture隔离和真实操作。 本轮Codex phase2正确解释两案例，但读取给定记录内非秘密environment字段违反冻结字面规则；无live env/credential读取。Claudephase1正确路由但507词超过500，未重试。 同一份原始审计文件不能同时满足需要查看command证据与禁止读取environment字段的现有协议。应分离模型任务输入和完整机器审计原件，并在模型调用前检验输入结构，而不是事后重新解释成功。

**独占文件**：`scripts/project-method-journey-evidence.mjs (new fixed projection)`；`scripts/project-method-journey-evidence.test.mjs (new)`；`docs/implementation/method-evidence-projection/README.md (new)`

**验收**：
- 输入只接受现有固定双案例journey目录；输出只创建新的专属目录，不改原证据、不运行driver/model。
- 输出closed-schema JSON：案例ID、实际product/driver exit、verification、cleanup状态与not_attested、固定scope、source/build摘要、原manifest与选中raw SHA、相关stdout/stderr的安全精确小片段；未知自由文本默认不传递。
- 完整command/environment/binding清单留机器审计区；模型包不得包含environment对象、HOME/PATH/socket绝对值、原始整command JSON或指向可读原件的本地路径；以hash/逻辑ID引用原件。
- 调用前独立validator逐字段/大小/键名/路径校验和文件清单核对；注入嵌套environment、额外原始文件、路径逃逸/符号链接、原manifest不匹配、缺receipt必须拒绝生成或拒绝发布packet。
- 成功与失败/未执行case均保留真实状态，不把missing-ref变健康，不因投影删掉cleanup unknown，不声称投影具备全量审计能力。
- 用冻结新B实际两案例raw构造投影并检查原文件hash未变；再以现有记录错误变体做反例。禁止重写旧host结论。
- 未来两host实验需新协议明确只读projection、可见字段和词数；预先公布并离线测试相同wordcount函数。仅规定长度不保证模型遵守，超限仍保留失败，无自动重试。

**依赖**：
- 依赖PR294固定证据格式或已发布精确head；不依赖J gates/provider资格
- root独占host harness/prompt与完整机器证据，作者仅三个新文件；可和材料接线候选独立开发
- 用现有manifest和case验证结果做输入完整性边界，不制造认证oracle，不复制整个旅程验证器
- 新模型调用由root另行授权预算；当前任务和该实现定向测试无需模型/默认DB

**不做**：不重跑本轮507词/环境字面限制失败；不削弱原机器审计完整性；不建通用redaction平台/任意命令runner；不把retained environment违规称凭据泄漏或产品破坏

**切片大小**：建议首选：1固定格式投影脚本+1负例测试+1接口说明；先解决实测输入协议冲突

## 2. 将已实现的双案例真实旅程接入可导出的 osstack-mode 方法材料

原始来源：[pstack/skills/create-verification-skill/SKILL.md L25–L40](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md#L25-L40)

**现状/缺口**：PR294 提供固定 doctor→healthy→missing-ref、持久证据校验与两行功能地图；接口只接受 --output。 PR293 导出六方法与四入口；create-verification 仍仅指向 engineering-decision，feature-map-template 亦只有该例。 冷启动宿主阅读导出材料时无法从材料发现已实现的简洁 skills-check 旅程。现有固定双案例能力停留在仓库实现说明，不在跨宿主可消费共享 reference 中。

**独占文件**：`osstack-methods-skill/references/skills-check-journey.md (new)`；`osstack-methods-skill/references/create-verification.md`；`osstack-methods-skill/references/maintain-verification.md`；`osstack-methods-skill/references/feature-map-template.md`；`scripts/export-osstack-methods.test.mjs`

**验收**：
- 新增实例 map 精确指向真实目标checkout的 scripts/method-verification-journey.mjs --output ABSOLUTE_NEW_ROOT；不捏造 wrapper --doctor/--dry-run。
- 说明默认/显式 scratch root、parent existence、no overwrite、compiled prerequisites、目标checkout与export目录区别。
- 逐行说明 healthy product0 与 missing-ref product1、driver0；原始 failed source 未恢复，不当作全产品健康。
- 两宿主四入口导出都含新 reference，链接解析通过，无占位符；固化 cold caller 所需唯一受支持命令及边界测试。
- 新材料验收在冻结候选执行一次真实pair并对照材料，每案manifest/cleanup有证据。后续host读取/执行实验单独授权预算，不以人工文字匹配冒称native。

**依赖**：
- PR293/294合并或精确合成这两个候选，单owner改shared references/export tests
- Node/依赖/compiled CLI可用；本地Git fixture，不需provider/auth
- 普通D2a，不依赖J01/J03/J11或identity issue；不得签gate

**不做**：不扩driver cases/API；不添加通用runner或调度器；不改central ledger/runtime/host配置

**切片大小**：紧随其后的小材料接线；不优先于已实测的输入边界冲突

## 3. 验证一次原生 osstack-mode 选择后由宿主实际执行固定真实旅程

原始来源：[pstack/skills/create-verification-skill/SKILL.md L13–L21](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md#L13-L21)；[pstack/skills/create-verification-skill/SKILL.md L25–L40](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md#L25-L40)

**现状/缺口**：Claude v2已有native osstack-help加载证据；Codex v1整体观察仍inconclusive。 host-assisted模式由root执行产品，模型选择/读receipt；不能证明宿主本身驱动。 尚缺原生mode读取create-verification后经宿主工具实际运行固定journey并读收据的证据。

**独占文件**：`docs/implementation/method-native-journey/protocol.json (new)`；`docs/implementation/method-native-journey/README.md (new)`；`scripts/smoke-method-native-journey.mjs (only if a reusable fixed host harness is explicitly approved)`

**验收**：
- 先冻结与旧help不同的实际执行目标、新预算、工具权限；两宿主每个最多一次目标执行，无自动retry。
- 材料从真实export目录发现，模型不预注入SKILL正文；目标只允许固定doctor/旅程及输出读取，独立fixture/evidence。
- 需有宿主原始工具调用与实际exit+receipt证据，可验证是宿主发起；root代跑必须标host-assisted。
- 有缺认证/宿主读写限制则blocked/inconclusive，不改用户全局设置、不升级为runtime资格。
- 记录directchild/fixture cleanup边界，既有四次help预算不复用也不重试失败。

**依赖**：
- 先完成模型输入投影与新协议冻结；当前实验无重试
- 候选1使冷调用路径可发现
- root明确新模型调用预算及必要native shell工具边界；本任务没有执行授权
- 可用host版本/auth/build，保留native和host-assisted差别

**不做**：不把help成功等同mode执行；不加新的身份或安全系统；不因J gates待定阻断普通工程实验

**切片大小**：价值高但宿主权限/成本更高，应在最小材料接线后独立排期

## 边界与下一最小任务

先开发候选1，不改当前已发布PR。定义固定投影schema和失败状态，再由独立测试者预冻结嵌套禁止字段/多文件泄漏/摘要断链/unknown cleanup反例；作者只写上述新文件。模型包只能暴露允许的字段和逻辑引用，原始机器证据另存，不通过可读路径把全量文件重新暴露。未来实验分开评分：方法选择、实际行为解释、可读输入边界、输出格式。词数规则在调用前写明，并用同一函数本地测试，但不默认更宽字数或追加重试。

D2a执行依据为PR293 execution.md第136行：普通工程工具增量不产生J01/J11/J03/J09资格，identity issue也非该增量前置。本预检没有执行模型、产品、测试或写产品；没有新增框架/资格/调度层。组合树已删除并prune，仅保留分支和scratch。
