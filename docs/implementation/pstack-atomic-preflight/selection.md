# 下一次 Claude 原子命令修复任务选题

推荐：**历史方法导出器把混合 LF/CRLF 代码围栏之后的坏导航链接忽略**。这是实际产品历史缺陷，已经修复并进入当前 main；本次是固定旧版重演，不是发现新的 main 缺陷，也不是再次测试旧 1038 packet/not_run 问题。

## Git 与真实 incident

- 选题基线 main：`493caa4e46e616b1d7e9e1c87ed0a5775eae3ad1`。
- 旧版：`4611fd6de998868e09fef042dc142bb52efaa6dd`。
- 实际修复：`a1cb1779d62107d2c4f101b98311f3ec39116ae1`；已核验它是基线 main 祖先。
- 实际 CLI：`scripts/export-osstack-methods.mjs`；待修模块：`scripts/lib/osstack-method-export.mjs`。均只用 Node 内建库。
- 原修复在 `scripts/export-osstack-methods.test.mjs` 添加真实回归 `code masking cannot hide real navigation: LF opener CRLF closer`。本次使用该精确 incident 字节，在历史原方法包副本的 mode 入口替换内容；这是历史回归夹具，**不是声称来自现场用户文件**。

围栏以 LF 行打开，结束围栏带 CRLF，随后为普通 Markdown 的缺失目标链接。旧版遮蔽错误导致后续链接跳过检查，实际输出包含坏链接；修复版应拒绝且不创建输出。不要向被测模型给出这段机制解释、修复 diff 或测试实现，只给症状与中立输入。

## 已执行的离线验证

协调者从 Git 提取两版实际生产源与旧方法包，在本目录的独占 `probes/` 副本运行真实 CLI，未安装依赖、未调用模型、未写仓库或创建 worktree。每条命令 10 秒超时；实际 0.054–0.068 秒。

| 输入 | 旧版 | 修复版 | 实际意义 |
|---|---|---|---|
| incident（原历史回归字节） | exit0、创建导出；坏链接字节仍在、目标确实缺失 | exit1、不创建输出 | 真实产品错误被修复 |
| 原始完整方法包 | exit0 | exit0 | 合法正常导出保留 |
| 纯 LF 代码示例包含同一缺失目标 | exit0 | exit0 | 不能靠拒绝所有代码示例变绿 |
| 围栏外普通缺失目标 | exit1、不创建输出 | exit1、不创建输出 | 原有坏链接拒绝保持 |

精确 argv/cwd/干净环境、源码 SHA/哈希、8 次 stdout/stderr、耗时和输出状态在 `probe-results.json` 与同名 raw 文件。所有输入/源码运行后哈希不变。`export-fix.diff` 仅为协调者来源证据，不进入模型输入。

实际入口：

```text
node scripts/export-osstack-methods.mjs --host claude --output NEW_ABSOLUTE_OWNED_DIRECTORY
```

## 下一次最小任务边界

模型只可改旧 `scripts/lib/osstack-method-export.mjs`，新增真实行为测试 `scripts/method-export-regression.test.mjs`，写 results。CLI、输入、材料和执行 helper 只读。准备一个固定原子 helper：`check CASE LABEL` 为每个固定输入复制当前候选两源文件与冻结方法包到新的 owned stage，再运行上述实际 CLI；`test LABEL` 只运行该新测试。这是待冻结的有限准备规格，本轮未实现 helper，也未证明 Claude 原生权限可用。

使用之前已提出的分阶段原子协议：先实际 CLI 复现；写行为断言并取得 test RED；最小修复；同路径、同输入重跑 incident/两合法 controls/原拒绝 control 及原测试。不要提供未来实现、历史提交消息、修复 diff 或独立隐藏期望。独立者先冻结拒绝坏导航、保留真正代码示例与合法导出的要求，并检查测试不是缺文件/语法错误造成的假 RED。

先在新的任务预算内验证第一条真实原子 helper 调用。保持窄工具/写入权限、无网络/安装/默认 DB、10 秒子命令界限。不得用更宽 Bash 规则解决复合命令选择错误，也不能从旧试验继承调用预算。此任务只验证一次实际修复可行性，不认证全部 Markdown、全部方法效果或联合 gate。

## 比较过但不选

第二候选：导航回归测试贪婪正则漏算同一行多个目标。旧 `b8bfc83ceee2065cf8192e9de083c24707c13976`，修复 `9cbb463af972d6fc0ad5265971b966ba2c35523e`，文件 `scripts/export-osstack-methods.test.mjs`。本次只读了真实 diff，未重新运行。它是测试判据质量缺陷，产品用户路径不如导出器案例直接，所以不选。

另核对 `ff6bfeb6` 是 merge，不是 Git exit/close 修复 SHA；没有沿用摘要猜测它是修复，也没有把它计作第三候选。
