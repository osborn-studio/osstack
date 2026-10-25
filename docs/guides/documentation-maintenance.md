# 用 osstack neat 维护双语文档

[English](documentation-maintenance.en.md) · [文档导航](../README.zh.md)

`neat` 检查仓库知识资料，不负责翻译文档或生成完整 README。请结合检查结果、源码、已安装 CLI 的帮助和发布证据更新内容。退出码为 0，并不代表每条描述都仍然准确。

## 1. 建立基线

使用已安装的 CLI。开发 checkout 必须设置独立的 `OSSTACK_HOME`，方法见[安装指南](install-upgrade.md)。从仓库根目录运行，将报告存放在 checkout 外：

```sh
export OSSTACK_SCRATCH_ROOT="${OSSTACK_SCRATCH_ROOT:-${TMPDIR:-/tmp}/osstack}"
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"
DOC_REPORT_DIR="$(mktemp -d "$OSSTACK_SCRATCH_ROOT/runtime/docs-audit-XXXXXX")"
osstack neat check --repo . --all --json --fail-on error > "$DOC_REPORT_DIR/before.json"
```

阅读 `result.report.completeness`、`summary` 和 `findings`，也要查看被抑制的 finding。完整的确定性检查覆盖已识别资料、引用及配置的契约；它不验证外部服务，不翻译内容，也不认证生产部署。

## 2. 同步更新两种语言

在同一次变更中更新中文与英文文件。通过[文档导航](../README.zh.md)找到对应文件。保持以下内容一致：

- 已发布版本、源码提交和验证日期。
- 命令名、参数、占位符和预期输出。
- 前置条件、授权要求和读写影响。
- 尚未验证的集成及恢复边界。

使用短句和直接的动词。先写条件，再写操作。每条指令只包含一个主要动作。保持技术标识符不变。这些原则借鉴 ASD-STE100，不代表正式符合该标准。请遵循 [Prompt 语言规范](prompt-language.md)。

保留带日期的审计输入及历史报告，更新当前指南，不改写旧结论。自动生成的清单应通过生成器刷新，不手工翻译或修改。

## 3. 检查结果

```sh
osstack neat check --repo . --all --json --fail-on error > "$DOC_REPORT_DIR/after.json"
osstack neat check --repo . --base HEAD --json --fail-on warning > "$DOC_REPORT_DIR/changes.json"
git diff --check
```

`--base HEAD` 包含当前工作树修改。提交后使用 `--base origin/main --head HEAD` 检查分支范围。两种范围都要检查；全仓扫描无错误，不能替代变更契约检查。

预览支持的修复时，先生成 `neat fix` 所需的 V1 输入：

```sh
osstack neat check --repo . --base HEAD --schema-version 1 --json > "$DOC_REPORT_DIR/fix-input.json"
osstack neat fix --from "$DOC_REPORT_DIR/fix-input.json" --json
```

V1 已弃用。这里只用于当前 fix 输入契约，普通检查报告使用 V2。上述操作只生成预览。按仓库策略应用前，先审查补丁。默认的 V2 检查报告不能直接作为 fix 输入。付费语义审计和自动应用都是独立的显式操作。

创建 PR 前，验证相对链接，对比中英文命令示例，并通过 CLI 帮助核对命令。将 neat 摘要和剩余限制记录到 PR。
