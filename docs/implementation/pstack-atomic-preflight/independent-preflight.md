# 独立预检草案：不同历史缺陷的原子修复任务

状态：准备可继续；未正式冻结、未批准派发。本轮只读，没有模型调用或产品执行。

已核 A 的 8 次留存离线记录及 16 个日志摘要、16 个源码绑定、4 组 old/fixed 输入树。混合 LF/CRLF 事件在旧版错误导出、修复版明确 link_missing_or_escape 且不创建输出；两合法控制均成功，普通非法链接均拒绝。固定 Git 回归包含同一 incident 字节。这是作者执行结果的独立核对，不是本角色重跑。

1. **behavior_red**：真实 CLI 在同 incident 字节上违反已定行为；新增测试在原源码上因该行为断言失败。缺文件、import、权限拒绝、output 已存在均不是行为 RED。
2. **stable_test_and_inputs**：保存 test RED 时的测试全文/hash，GREEN 使用完全相同测试；所有 incident/control 输入和只读 helper/material 字节不变，只有预定源码、测试、results 可写。
3. **legal_controls**：至少两个有区别的合法控制 old/fixed 均成功；普通非法链接拒绝作附加非目标回归。检查导出内容/目标存在性，不仅 exit。
4. **scope_isolation**：这是另一历史 exporter 缺陷；不提供旧 packet 修复、fixed implementation、历史解释或其他 host 答案，不改写旧实验成绩。
5. **atomic_permission**：每次 Bash 只一条预定 helper 命令，首次实际原子拒绝即结束，不包装、重发、fallback 或扩权限；拒绝与测试 exit1 分开。
6. **stage_and_output**：原 source baseline→新增测试行为 RED→最小修复→同案例/同测试 GREEN 的真实事件顺序；每阶段新 output 位于 owned results，测试临时输出同样受限，避免 output_exists 伪 RED。
7. **raw_vs_visible**：分别记录完整 raw stdout 与实际模型获送文本/preview/后续 Read；原始完整输出不自动证明模型完整读取。native Skill、显式 Read、模型发起 helper、协调者重验分别归因。
8. **holdouts**：正式隐藏反例在模型前分别跑 old/fixed，验证属于本缺陷且合法控制不受损；保存失败的 oracle/harness 校准记录，不能看模型结果后改标准。
9. **resource_and_evidence**：新封闭 adapter 的精确 argv/cwd/env/源码 hash、10s/输出预算、一次调用/无重试、完整 inventory 和原始失败先核；没有 OS 读/网络围栏或完整后代清理证明，不做这些声明。

未决：旧 packet helper 不适用 exporter，需要新封闭 case adapter 的精确绑定和协调者正负例；所有导出/测试临时产物应在 owned results、每阶段使用全新路径。正式 hidden old/fixed 校准、完整 final-context/resource/catalog 及批准 guard 尚未完成。B 草案的既有边界可保留，但不能称旧 helper 无需变化。

此草案不改变旧实验结果，不认证独立 principal、模型优劣或方法因果收益。

补充已核最终 selection.json（4f386a75…）：历史 fixture 而非用户现场输入、当前 main 已含修复，来源说明准确；修复 SHA 的祖先关系已实际核对。建议模型仍执行 8 条 helper（incident + 两合法控制 + RED/GREEN test），plain-invalid 保留为协调者独立控制，不冒充模型执行、不默增至 10 条。此取舍仍为未冻结提案。
