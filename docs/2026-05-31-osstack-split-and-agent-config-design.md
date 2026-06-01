# OSStack 独立化 + 角色化 Agent 配置 设计稿

**日期**: 2026-05-31
**作者**: osborn (with Claude Code)
**状态**: Implemented

## 目标

1. 把 OSStack（项目经理 Agent）从 Partner OS 框架中拆出，成为独立产品/独立仓库，上 GitHub，邀请 `harrisdudu` 共建。
2. 给 OSStack 增加**角色化 Agent 配置**：按机器（Mac Mini / MacBook Pro）配置
   Coding / Test-Verify / Design 三类 Agent 的「主力 + 回退序列」，启动时探测本地是否安装，
   未装则按回退序列替换。全部可自定义。这是 OSStack 自身的能力，不是独立子品牌。

## 仓库拆分

| 仓库 | 路径 | 内容 |
|---|---|---|
| `gilosbornhello/osstack` | `~/Developer/osstack` | 核心包（agents/core/cli/**config**/hermes-adapter/runtime/plugins/skills/skill-registry）+ docs + hermes-skill。剔除 `partneros-*`。 |
| `gilosbornhello/partner-os` | `~/Developer/partner-os` | 6 个 `partneros-*` 包，依赖 `@osstack/*`。 |

原 `~/Developer/osbstack` 保留为备份/超集。

## 角色化 Agent 配置

包 `@osstack/config`（仅依赖 `@osstack/core` 的类型）。三层：

### 1. 配置（`~/.osstack/config.yaml`，YAML）

```yaml
version: 1
active_profile: auto          # auto=按主机名匹配；或写死某 profile 名
profiles:
  mac-mini:
    match: { hostnames: ["OsborNs-Mac-mini.local", "OsborNs-Mac-mini"] }
    roles:
      coding:      { primary: claude-code,   fallback: [codex-cli] }
      test-verify: { primary: codex-cli,     fallback: [claude-code] }
      design:      { primary: claude-design, fallback: [google-stitch] }
  macbook-pro:
    match: { hostnames: ["<在该机用 osstack config bind macbook-pro 绑定>"] }
    roles:
      coding:      { primary: codex-cli,     fallback: [claude-code] }
      test-verify: { primary: claude-code,   fallback: [codex-cli] }
      design:      { primary: google-stitch, fallback: [claude-design] }
defaults:
  roles: { ...同 mac-mini... }
```

角色 → 能力 kind 映射：
- `coding` → `code.write` / `code.refactor` / `code.debug`
- `test-verify` → `code.test` / `code.review` / `release.verify` / `release.check`
- `design` → `design.prd` / `design.architecture` / `design.review`

### 2. Profile 选择（`selectProfile`）
优先级：`OSSTACK_PROFILE` / `--profile` 覆盖 → `active_profile`(非 auto) → 主机名匹配 → `defaults`。

### 3. 角色解析（`resolveRole`）
按 `[primary, ...fallback]` 顺序，跳过未注册/不提供该角色能力的 adapter，
逐个 `isAvailable()` 探测，首个可用即选中；都不可用时可选 `autoFallback`；仍无则报清晰原因。

## Design adapter（诚实标注）

`claude-design`、`google-stitch` 声明 `design.*` 能力 + `isAvailable()` 探针，可被选中/回退。
**执行层为 scaffold**：`invoke()` 发 run.started → progress(design.scaffold) → done(completed)。
配置/探测/回退是真实可用的；执行接 designer-*/stitch skill 是后续 sprint。

## CLI 表面（`@osstack/cli`）

全部归入 `osstack config`（不需 daemon）：
- `osstack config [show]` — 生效 profile + 每角色解析结果（含回退原因）。
- `osstack config doctor` — 探测所有 adapter 可用性，按角色分组。
- `osstack config pick` — 交互式逐角色选主力。
- `osstack config init` — 写默认配置到 `~/.osstack/config.yaml`。
- `osstack config use <profile|auto>` / `osstack config bind <profile>`。
- `osstack config get [path]` / `osstack config set <profile>.<role>.<primary|fallback> <值...>`。

## 共享 adapter 注册

`@osstack/agents` 的 `defaultAdapters()` 返回 5 个 adapter，daemon 与 config CLI 共用。

## 测试

- `config/config.test.ts`、`config/resolver.test.ts`（15 测试）。
- Design adapter 单测（design.test.ts）。
- 两仓各自 `pnpm install && build && test` 跑通。

## 命名说明

早期草案里这套能力曾叫 "OS Deck"。最终定名：它就是 **Osstack** 自身的配置能力，
不另立子品牌——包名 `@osstack/config`，命令 `osstack config`，去掉所有 "deck" 字样。
