# PR #237 main 整合证据

这批证据独立于原开发阶段的 frozen archive。审计通过 Claude Code CLI 请求 `claude-haiku-5-5`，禁用 tools、hooks、MCP 和会话持久化。CLI stderr 的 unrecognized_model 警告完整保留；response modelUsage 仅是服务端返回标识，不代表独立权重认证。

第二轮结果是工具标签/重复文本，属于无效审计，不计入通过。其余原始结果及原始输入保留；输入使用 .txt 扩展名，避免把被引用源码中的链接当本文档链接。迁移 proof 验证 main 的 1–39 SQL 未修改，新增 Attention 为 40–41。

本地历史失败保留，不可将失败批次解释成通过。最终资格以整合报告、对应提交的 CI 与测试记录为准。
