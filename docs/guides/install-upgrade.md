# 安装与升级 OSStack

[English](install-upgrade.en.md) · [文档导航](../README.zh.md) · [README](../../README.zh.md)

## 发布状态

2026-10-25（北京时间）核对：npm `latest` 为 `@osstack/cli@0.22.1`，对应 main 提交 `37136bd17578865cfc965cbe814629d1a77d72e7`。Firstmate 能力工作已整合。24 项映射使用新增命令及既有机制，不代表 24 条独立子命令。

main CI 已通过：5,779 项测试通过、7 项跳过。macOS 发布运行有 5,781 项测试通过、5 项跳过，所有发布前检查通过。其 OIDC 上传返回 E404，随后使用维护者已验证的 npm 账号，从同一提交完成发布。自动 OIDC 发布失败仍是独立的发布流程问题，不能把该次工作流称为成功。

发布后验证：19 个公开包的版本、依赖与 `latest` 标签检查全部通过。19 个压缩包均可下载，SHA-512 与 registry 记录一致。在隔离 npm prefix 中从公共 registry 安装 CLI 0.22.1，11 项安装及命令检查通过，`loop doctor` 返回 `ok: true`。这不涉及远程服务器升级。

[main CI](https://github.com/osborn-studio/osstack/actions/runs/40169983929) · [macOS 检查与 OIDC 失败记录](https://github.com/osborn-studio/osstack/actions/runs/40169983974)

## 安装或更新 CLI

本指南的安装检查使用 Node.js 22 LTS。在每台目标主机执行：

```sh
node --version
npm view @osstack/cli version --registry=https://registry.npmjs.org/
npm install -g @osstack/cli@0.22.1 --registry=https://registry.npmjs.org/
command -v osstack
osstack --version
osstack --help
```

期望版本：`osstack 0.22.1`。明确希望安装最新发行版时，可将 `@0.22.1` 改为 `@latest`。npm 安装只更新当前 npm prefix。Codex 和 Claude Code 必须通过各自执行环境的 PATH 找到新程序。如果仍报告旧版本，请在对应执行环境运行 `command -v osstack`。CLI 更新不代表既有 daemon 已重启。

检查需要使用的命令：

```sh
osstack scout --help
osstack worker --help
osstack sources --help
osstack remote-home --help
osstack follow-up-delivery --help
osstack homes --help
```

刚发布的包如果返回 404，请等待 registry 元数据和压缩包可用后重试安装。不要为解决读取延迟而重复发布同一版本。

## 验证目标环境

在目标项目运行 `osstack doctor --workspace .`，逐项阅读结果。使用 `osstack loop doctor --workspace . --json` 检查 Loop 前置条件。帮助命令通过只证明 CLI 入口存在，不代表主机集成已经配置好。

替换生产服务前，记录可执行文件路径、版本、serving home 和服务管理器配置，并保留可恢复的数据库备份。按目标主机的部署流程更新。仅降级 npm 包不会撤销数据库迁移。本次 npm 发布没有升级远程服务器。

开发 checkout 或隔离实验必须使用独立 home。不要让开发 CLI 打开生产数据库：

```sh
export OSSTACK_SCRATCH_ROOT="${OSSTACK_SCRATCH_ROOT:-${TMPDIR:-/tmp}/osstack}"
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"
export OSSTACK_HOME="$(mktemp -d "$OSSTACK_SCRATCH_ROOT/runtime/verify-home-XXXXXX")"
chmod 700 "$OSSTACK_HOME"
```

## 仍需真实环境验证的部分

| 集成 | 生产使用前的验证 |
|---|---|
| GitHub 交付 | 在沙箱仓库验证目标与正文规范化，以及交付回执。 |
| 远程 home | 验证两台主机、固定 SSH 访问、断连和未知结果对账。 |
| Worker 查看器 | 验证实际配置的 tmux/cmux 查看器和受 grant 约束的输出访问。 |
| 托管升级 | 验证 launchd 安装、产物与计划摘要，以及中断或断电后的恢复。 |
| 真实模型 | 验证 provider 登录、可用性、留出集评估、计费和进程终止。 |
| 外部跟进交付 | 验证 host transport、精确目标和签名授权。任何重发前，先对账未知结果。 |

Graph 交付仍为 artifact-only。本版本可以安装，但这些尚未验证的集成不能据此获得统一的生产部署结论。命令边界见 [Firstmate 手册](firstmate-commands.md)，逐项能力证据见[交付账本](../reports/2026-10-24-firstmate-capability-completion-ledger.md)。
