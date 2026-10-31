# W19：查询保留的维护结果

本切片让使用者读取显式列出的固定五案例维护记录，区分最近尝试、历史成功、版本关系和可观察故障。它支持“保留失败 → 授权修复 → 新输出重验 → 查询两次结果”的有限闭环。它不执行产品、不扫描遗漏的尝试、不启动计划或通知，也不代表 W19/A45、C0 或 Firstmate 深运行整体验收。

面向使用者的步骤在[维护查询教程](../../verification/maintenance.md)，原始范围在 [PLAN](PLAN.md)。PLAN 中父 PR 尚未合并的文字是冻结时状态；后续 PR311 已合入 main，本说明不把该历史状态当作当前发布依赖。

## 实际入口与结果边界

在已准备依赖的本仓库根目录运行；配置及保留记录必须使用自有 scratch，不用默认服务 home。

```sh
node scripts/method-control-health.mjs --help
node scripts/method-control-health.mjs \
  --config "$health_root/health-config-01.json" \
  --as-of "$health_as_of"
```

`health_root` 是自有绝对目录，`health_as_of` 是明确的 UTC 评价时间；配置构造与原件目录要求见教程。可重复添加 `--changed-path REL`，只选择项目声明映射命中的 feature 及其依赖者。最多 8 个 attempt；当前仅支持固定五案例 `maintenance` 记录，feature 名称不会扩展其验证能力。

- 退出 0 表示报告生成，不表示健康；退出 2 表示参数或配置错误。
- `bounded_consistent` 仅覆盖调用者列出的最新、完整、未过期且与配置版本相符的记录。遗漏的新失败无法被发现。
- `last_success` 独立保留历史成功；不可读、并列或未来时间不会被旧成功掩盖。负责人只是项目配置声明，未配置为 `unassigned`。
- `matches_configured` 是记录与配置比较，不是现场版本或可信构建认证。driver 摘要只覆盖 wrapper 文件；它不是传递 import 的完整可执行身份。
- `required_feature_ids` 传播选择范围，不传播健康结论。未映射路径保留未知。
- 地图预期与实际不一致保持 `expectation_mismatch`、根因未知。产品预期退出 **0/1/2/1/0** 不是回归；`observed_product_deviation` 只说明保留的原始观察偏离谓词，不证明根因。
- 原始首个及后续故障是有界但不可信的生产者文本，不得作为指令执行。缺件或不支持形状保持未知；查询不是完整因果诊断。

## 真实工具故障、修复和重新驱动

实验在自有维护脚本副本中桥接现有 import，仅故意把读取 `journey.json` 的一行改成不存在的 `journey-receipt.json`。第一次真实 full5 已完成，但 wrapper 随后读取失败，维护结果为 `blocked/2`、`ENOENT`。恢复同一路径的该行，使用新输出目录第二次真实 full5，结果为 `consistent/0`；地图没有改变，原失败没有覆盖。

这是**明确注入的工具路径缺陷**，不是新发现的产品 bug。恢复后的副本因 import 桥接而与 checkout wrapper 摘要不同；没有宣称二者是同一二进制。两次产品观察都符合固定五例预期。后续只读查询同时保留首次 `tool_evidence_failure` 和修复后的最新成功；在显式配置及评价时间内，后者为 `bounded_consistent`。owner 只声明实验维护角色。

另两组实际控制分别是缺 git 的环境前提失败，以及合法但错误的地图预期。四组保留记录的只读 CLI 查询都正常生成报告，分别得到一致、工具证据失败、环境阻塞、预期不一致；不能把四次 exit0 相加称为四项健康通过。查询没有再次执行 full5。

## 验证与修复记录

以下结果分开绑定，不合并成一个“全部通过”资格结论。原始命令、响应、输入、失败与后续修正全部保留。

| 层次 | 实际结果与限定 |
| --- | --- |
| 独立冻结输入 | 原 wire 35 项通过；原 retained 22 项为 19 通过、3 项 harness 失败。三个问题分别是夹具时间包络错误、两项混淆 health/classification 与 latest 时间轴的断言。另存纠正后均通过，未改旧成绩，也不称产品 RED。 |
| 初始作者测试 | 合成保留证据测试先 18、后 27 项通过。首次缺模块失败属于新功能 TDD 准备，不是历史产品 bug。 |
| 三项独立发现修复 | SHA 字段数组的隐式类型转换、矛盾 map-after 被忽略、首个/后续诊断遗漏。同一 40 测试旧实现 28 通过/12 失败，修后 40 通过；独立有限闭环 7/7。原 6fda 证据不重标。 |
| CLI 符号链接入口 | 旧入口在 `--preserve-symlinks-main --help` 下静默 exit0；修后返回实际帮助正文。保留原 RED 与同入口 GREEN。 |
| 分类优先级 | 普通 drive exit1 原先抢先归为工具故障，阻挡封存产品偏差分类。修后先核完整 sealed 产品观察；真正 timeout/signal 等进程故障及 doctor 错误仍保留原分类。四项作者合成测试旧 3 通过/1 行为失败，修后 4/4；独立者复跑同四项。它们不是新预冻输入，也不是新的实际产品偏差驱动。首轮夹具重复 seal 的准备失败另存，不冒充行为 RED。 |
| 最终 health 定向测试 | 45/45，包含三项修复、root 符号链接回归和四项分类回归。绑定 source `293328d5449eba6a5a27f28f915168b657b9240f51ce536f8704b7b100ae476b`、test `64eeab7263aa4feaa97242ce21f100ff905d1156f962f79d3066f927c268ea31`。 |
| 历史整仓 | `d12ed16bfcfb78127e693424cc31c3437bd243f3`：7261 passed / 5 skipped / 0 failed，运行前后 8980 tracked 文件无变化；运行前存在已保存的 fresh dist 差异，不是 clean committed tree。该结果不冒充后续组合候选。 |
| 当前组合整仓 | `e82adca9cb4b9a0e8ecbfcb8f3b96801c51cc108`：22包 **7304 passed / 5 skipped / 0 failed**。8981 tracked文件执行前后字节同；初始四fresh knowledge/dist脏及文档未跟踪，不称clean committed tree。199脚本定向全过（45health/25maintenance/89projection/40feature-map）；build、typecheck、lint、inventory通过。整合typecheck首次因CLI测试mock缺两个解析默认字段失败，修mock后通过，原件保留。 |

## 实际审计与发布状态

首轮实际 Claude CLI 审计报告为 **PASS_WITH_CONCERNS**。`modelUsage` 报告 `claude-sonnet-5-5`；这是 CLI 报告的模型信息，不是独立身份认证。审计只静态阅读所供材料，没有执行测试，也没有完整看到所有依赖，不能替代运行证据。

审计确认需要说明单文件 driver、调用者声明的尝试集、有界不可信诊断、选择依赖与健康依赖的区别。独立复核确认符号链接入口和分类优先级缺口，随后做上述有限修复。原意见、遗漏上下文的逐条处置、原 RED 和后审回归分别保留，不把首审改写为无保留通过。实际Sonnet5.5限定closure为 **PASS_WITH_CONCERNS**，未发现阻断缺陷。保留可选建议：两次realpath都失败的极窄入口情形、无完整outer phase时仅sealed raw也可报告观察偏差、版本标签数值样式及replacement语义。phase记录实际使用error字段；没有新增未经验证的进程安全承诺。

同批 P1/W01 manifest 登记支持 `subdir` 默认 `.`、独立 `package_version` 默认 null，并拒绝未知 source/manifest 字段；可登记 pstack `0.15.36` 候选标签。它不修改 watcher/normalizer 的采用行为，不代表工具安装、内容已吸收、版本发布或资格通过。详细计划同批保存也不等于实现完成；P1 的作者与独立测试证据单独绑定，不计入 W19 的 45 项。

## 原始归档索引

归档 `evidence/raw-verification.tar.gz` SHA-256 `abec101cbe7795973b403041e2c119a40b6e6efef6a451430672a30ee744dbc1`；4155成员：3841文件、312目录、2符号链接，86,889,274文件字节。root及独立验证者逐成员核type/mode/size/hash/link target；[独立报告](evidence/archive-check/report.md) SHA-256 `9c8272aedf5f580ac0e66ac9ad5593374ff4ebbeb9cf684b54bf71f84cc531a2`。初次额外文件名断言错误和按真实日志路径纠正的结果均保留，不是归档缺陷。保留以下原始组，路径为包内来源索引：

- `author/`：契约、初始 RED/GREEN、真实记录只读查询、`revision-1/` 三项修复。
- `docs/`：工具副本、注入与恢复差异、两次真实 full5、后续 health 查询。`actual-summary.json` 的 `health_query_executed:false` 属于驱动阶段，后续独立查询另有记录。
- `independent/`：原冻结输入、35/22 原结果、harness 修正、后检发现、四组真实原件核验及三项修复闭环。
- `independent-audit-check/`、`classification-repair/`、`closure-check/`：审计处置、符号链接原失败、作者分类 RED/GREEN与独立有限复验。
- `audit/`、`audit-closure/`：实际输入、响应、模型报告与原始结论，均在调用完成后封包。
- `root/final-validation/`：历史 d12 全仓绑定；当前组合日志另行保留，不能覆盖历史。

本实现受 Lauren Tan / poteto 的 MIT 许可 pstack 维护方法启发；独立表达和现有 OSStack 工具组合不改变原来源与许可归属 (removed)。

根收口：驱动摘要只绑定单文件，诊断不可信，缺失outer phase不能证明该阶段完成。产品偏差标签描述完整sealed raw中的谓词偏差，cause仍unknown，不升级健康或资格。source manifest的addSource仍是整条替换语义，未来消费者重写时必须保留subdir/version。
