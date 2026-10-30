# 固定 bug_fix 方法接入现有调用边界

本批提供项目局部准备入口与现有 execution-context host 接线，服务“一张当前缺陷卡 → 固定 pstack 方法 → 既有 deliver/Loop → 候选验证 → 同卡证据”。没有新增 scheduler、自动卡消费或 Firstmate 深运行。

固定来源为 pstack **0.15.36**，cursor/plugins commit `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`，subdir `pstack`。Lauren Tan/poteto/MIT 来源保留；旧研究版本、旧宿主 FAILED/LIMITED 观察不改写。本批不激活全局 source-lock、不自动升级上游。

## 已实现的用户路径

1. 显式提供目标仓库、任务意图、三角色完整材料、来源结构与摘要、必需产物、功能前提，以及复现/回归/主验收检查声明。
2. `compileBugFix` 纯编译为 `executable:false` recipe/proposal 和角色 MethodInput。缺义务、未知检查引用、含糊 primary、仓库不匹配、来源/材料摘要矛盾与预算超限拒绝。
3. `node scripts/prepare-bug-fix-method.mjs --input REQUEST --output NEW_DIRECTORY` 写出全新项目局部 `compiled.json`、三份角色正文与 `context.json`。不读看板、不调用模型、不注册 host policy、不授权执行；已有目录不覆盖。
4. 现有 `deliver --execution-context` 可接收配置。宿主读取完整编译文件并重跑纯编译，比较整个 canonical 输出，再绑定 task/repo/proposal/所有角色声明与所选角色材料；调用前同步复核编译文件和材料 bytes。缺失、漂移或预算不足时 adapter 不被调用。
5. 方法正文进入单独的 untrusted reference 数据块，不能覆盖 host/user 指令。现有持久收据记录 prepared 与 adapter_observed、完整最终 prompt 摘要、角色材料和编译文件摘要。

[使用教程](../../verification/bug-fix-method-handoff.md) 给出真实入口、输入表、错误恢复与既有 V2 deliver 草图。仓库 fixture 只是合成示例。检查 registry、版本、source facts 与 capability 标签仍是调用方声明；现有 V2 host policy、路径/预算/候选验证仍独立生效。

## 明确边界

- P4 处理一种 bug_fix recipe，三项检查逻辑角色，primary 必须为 acceptance；不生成正式 admission、MethodBinding、TrialPermit 或资格。
- 每角色正文最多32KiB，三角色总96KiB，编译输入/输出512KiB；宿主另核完整 framed prompt。helper 使用紧凑 JSON，避免美化导致合法结果超过宿主读取预算。
- 宿主仅在 methods 配置存在时动态加载编译器；没有 methods 的既有路径保持兼容。配置 methodContext 而 mode 为off或省略时显式拒绝，不能静默绕过必需材料。合法 Loop 子工作树的 execution_repo_path 可以不同于材料 workspace，两者分别记录。
- 路径/hash检查不是 OS 并发隔离，receipt 只证明 agent task prompt 边界，不证明 provider wire、模型理解、native slash 调用或模型独立身份。JSON duplicate key 仍为解析器 last-wins。
- 编译文件需由匹配的构建生成，整个输出（包括说明字段）参与重编一致性比较；未来编译器语义或文案改变后旧包可能需要重新准备。`proposal_digest`不是整个文件摘要，完整文件由`compiled.sha256`另行绑定。live task prompt不与intent做语义等价认证，角色/capability映射仍由调用方声明，context.json本身不带固定hash。available_feature_ids及assurance/limitations不属于proposal_digest，仍由完整编译文件绑定。同步读取/JSON解析有512KiB上限，未声称无延迟。
- 准备目录逐文件写入，不是原子多文件发布；I/O 失败可保留无成功回执的残留，必须保留后用新目录恢复。不会覆盖旧结果。
- 尚无自动 card→合同或 receipt→同卡幂等投影。现有授权下可人工关联原收据；投影失败不应重跑模型。

## 实际材料与独立验证

本轮再次从固定 Git 对象读取并核验11组件51唯一文件、174474bytes；是实际源码复核，不是 caller version 标签认证或正式采用激活。SourceSnapshot 由这些结构事实构造，未把旧 declared candidate digest 冒充 snapshot digest。

完整递归引用闭包超过角色预算。实际组合采用四份完整操作材料（bug-fix/investigation/code-review/evidence）和 sources 中完整当前0.15.36命名区段，另加角色/范围说明；三角色分别32286/32303/32309bytes，总96898bytes。没有任意截前N字节，也不声称包含所有条件路由；任务需要 refactoring/engineering-decision 时必须重新选择完整材料和编译。

真实准备入口已产出该包；独立公共 host factory 以受控 adapter 核三角色完整正文和6份持久收据。受控 adapter 不执行原生模型/产品修复，不计作 P6 或 U2 完成。

独立初阶段：27编译向量、28宿主向量、8准备流程均通过，各自保留初始 harness 错误及修正。追加预冻结19编译绑定向量、3符号链接入口向量、8准备流程与真实材料控制通过。旧19向量使用旧兼容 wire，5合法通过、14新要求仍invoke；这是旧契约缺口基线，不冒充相同 wire 的旧产品 RED。

## 已确认并修复的问题

1. 独立发现从文件/目录符号链接启动 helper 时，旧 main guard 静默 exit0 且无产物。相同新增测试旧2失败/1import控制通过，修成物理文件比较后全部通过；import 无 CLI 副作用。
2. 初宿主仅记录 caller proposal 摘要，未重新核验完整编译结果。root 识别缺口后冻结新要求，再增加全产物重编、所有角色配置对应和 invoke 前复核。
3. 独立算术及实际编译发现 JSON 美化可能越过读取预算；相同用例旧写525771bytes而测试失败，改紧凑 JSON 后通过，独立近界输入也通过实际 loader/sync。

4. Sonnet静态审计指出公共wrapper在mode=off或省略时可静默忽略methodContext；原host factory始终local不受此路径影响。相同新增2测试旧失败、29兼容测试通过；增加入口拒绝后76宿主定向全过，独立同五控制另行保留。

原首次 helper 测试误导入不存在 digest helper、原 inventory 命令名写错、CI日志ANSI初解析不到包、文档验证首次系统Python缺jsonschema（切既有带依赖venv后241通过），以及独立 fixture/harness错误均保留；它们不被改写为产品失败。

## 验证绑定与下一步

首版精确 `a9a45116079b7e633565d27bcd2e89b0ea8ee0db`：22包7403passed/5skipped/0failed，9106已跟踪文件运行前后字节同；初始4fresh knowledge/dist脏，不称clean committed tree。第二轮精确`ac9e67c6b2d5c2063bc525b5265ea432234d3a56`（包含compiled/alias/serialization修订）22包7420passed/5skipped/0failed，9106tracked字节未变；初始4freshdist和未跟踪教程。后续mode入口拒绝仅另跑定向和类型检查，未重标这次full为最终whole-tree。

当前定向：编译34、宿主76、准备16；新鲜CLI build、typecheck、TS lint、inventory通过。MJS未被Biome覆盖，不称lint覆盖。启动中位数version47ms/help112ms，分别低于150/500ms；新增叶模块独立导入约15–17ms，no-methods lazy哨兵另外验证。

实际Sonnet5.5初审PASS_WITH_CONCERNS：两条协议疑虑经7个实际探针证实已被协议拒绝；公共mode绕过确认并修复；PR313旧配置归因经Git证明不成立；双依赖已声明。匹配build、caller事实、完整文件/部分proposal摘要范围及同步IO限制均保留。限定复核仍PASS_WITH_CONCERNS，确认F3修复并撤回F1/F2/F4相关误判；匹配build及caller事实等限制不变。root另核完整源码hash与b3fa提交逐字一致，未冒充第三次审计。初审全文、证据和限定复核单独留存，静态审计不等宿主使用或独立provider认证。

**下一步是 P6 实际使用，不再扩维护平台。** 选一张尚未关闭且可复现的当前真实缺陷卡，冻结允许路径、预算、原子复现/回归/primary与独立预期；把此包配到现有V2 deliver/Loop支持的一个实际host，保留RED→修复→同入口GREEN→最终候选核验→同卡持久收据。先人工明确卡/合同和回写步骤可以标assisted；不得把缺失自动化、模型身份或资格说成通过，也不要求Firstmate深运行或32项联合验收先完成。

P4/P5组件证据不升级原24PS/19W/48A、整个C0/C1/C2、32J正式状态或用户S1–S3签收。

## 可复核的原始记录

`evidence/raw-verification.tar.gz` SHA256 `ef0900ac9672c5d7cc0c48ef268bd97510235ad3e58c56dbb981a836f486511e`；manifest `dde230cd3c1c09ac79bbb59082ac8524cedcc1810a15a2e49ad7d71e1acdde2f`。共1578成员（1109文件、461目录、8符号链接）、16997593文件字节；root逐type/mode/size/hash/target对照原件，不解引用符号链接。独立逐成员复核通过，回执`2953b9e26433af64e76c6cb78cfb23db09f4882c96b446a7a87d6df777cdc352`另存`evidence/independent-archive/`，并核16源码Git对象、两审计输入及受控调用绑定。包含两次full、两次静态审计完整输入/响应、所有RED/修订、实际固定源码/材料准备与受控调用、独立准则/原harness错误、PR313父栈最终CI原日志和三板回读。冻结原scratch后新输出写publication/archive-check，未重跑已封存packet。
