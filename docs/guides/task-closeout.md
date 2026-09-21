# 任务结束后：用 neat 检查，再整理文档和交付

[返回 README](../../README.zh.md#知识卫生neat) · [neat 完整指南](neat.md) · [常用命令](command-reference.md)

可以把 neat 放在每轮开发收尾中。它负责检查知识与文档卫生，不能独自完成代码变更总结、产品说明更新和 GitHub 发布。目前没有一条 `osstack neat` 命令可以自动完成这些步骤。

## 1. 明确本轮改动范围

在任务所在 Git 工作副本运行：

```sh
git status --short
git diff --stat
git diff --cached --stat
git log --oneline origin/main..HEAD
git diff origin/main...HEAD --stat
```

阅读实际 diff，记录新能力、行为变化、删除项、CLI 参数变化和已知限制。不要把其他未提交任务混进本轮总结。origin/main 必须是你想比较的基线；合并后它可能与 HEAD 相同，此时改用已知的合并前提交或该 PR 的 diff。

## 2. 选择 neat 检查范围

报告写到仓库外，避免报告本身改变被检查的 diff：

```sh
export NEAT_REPORT_DIR="$(mktemp -d /tmp/osstack-closeout-XXXXXX)"
# 未提交工作树改动（默认模式）。
osstack neat check --repo . --json --fail-on none > "$NEAT_REPORT_DIR/worktree.json"
# 已提交分支改动：当前分支相对主线。
osstack neat check --repo . --base origin/main --head HEAD --json \
  --fail-on warning > "$NEAT_REPORT_DIR/branch.json"
# 全仓已识别的知识表面；不做 Git 变更合同评估。
osstack neat check --repo . --all --json --fail-on none > "$NEAT_REPORT_DIR/all.json"
```

只运行与你的阶段相关的模式即可；想比较 origin/main 到包含未提交修改的工作树，用 `--base origin/main`，不加 `--head`。从开发 checkout 调用 CLI 时，须事先设置独立私有 OSSTACK_HOME。

看 findings、覆盖范围及跳过项，不只看退出码。默认 `--fail-on none` 下存在警告也可能返回 0；`warning` 会阻断 warning/error。规则由 `.osstack/neat.yaml` 配置，例如本仓库 CLI 实现变化要求检查 README 或命令清单；它不证明每个新增参数已经得到正确解释。

## 3. 更新使用文档并验证

根据 diff 和检查结果完成：

- README：功能解决什么问题、怎么安装、最短可运行示例、当前支持边界。
- 使用指南：新增命令/参数、默认值、前置配置、成功结果和失败处理。
- 生成清单：按清单文件头指定的脚本重新生成，不手改生成文件。
- 发行说明：区分 main 已实现、内部已部署、npm 已发布；保留验证依据。

核对 CLI `--help` 和参数解析器，检查相对链接；在隔离环境试跑无副作用的示例。真实执行、付费模型、部署示例必须标明影响，不能把未执行的流程写成已验证。修改后重新跑相关 neat 检查，再运行适用于代码改动的测试；neat 不替代测试或代码 review。

`neat fix --from REPORT` 默认只预览受支持的低风险补丁；当前机械 fix 主要支持缺失指令镜像的单行导入，不是通用 README 编辑器。semantic 是显式启用并调用 judge 的审计；narrative/memory 使用独立的计划、批准和执行事务。详见[完整指南](neat.md)。

## 4. 提交到 GitHub

先检查最终 diff 和验证证据，只暂存本任务文件，再创建提交和 PR。neat 不会替你 commit、push、审批、merge 或发布。经过仓库要求的 CI 与独立审批后，合并才会更新 GitHub 默认分支 README；PR 分支内的 README 可提前查看。

## Loop 自动附带检查

```sh
osstack loop run --workspace . --source task_queue --auto-agent \
  --verify "pnpm test" --report --scorecard --proof --neat-finalize --json
```

这是会运行任务的命令，不能为了 neat 报告随便重跑已完成任务。`--neat-finalize` 只在 Loop 成功后执行全仓知识检查，附加非阻断证据；检查失败不会改写 Loop 业务结果，也不会开启新循环、自动修复或提交。普通任务已完成时，直接运行上面的 `neat check` 即可。
