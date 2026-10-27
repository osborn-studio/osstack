# PR #279 terminal-fence 独立预检

结论：当前实现与最新 main、#278 当前代码可以无冲突组合；限定范围的测试通过。未发现需要修改产品代码的确认缺陷。#279 保持 Draft，继续等待 #278 合并及正式审计；本报告不构成 Ready 或运行时能力验收。

## 冻结输入与交付

- main：`8fed83136611948ee068801ab5cc1fd471f90078`。
- #279：`cae25bc612e6e6884cf548e5bc8d3a745863a909`，base 仍为 `codex/session-start-cleanup`。
- #278 当前代码：`39c5df28cea120630f39a8267235c2f7ff5985b4`。
- 独立组合提交：`4cdf36e3aed91ad1733c09a8c7dac549817fcad7`。
- 补充测试提交：`aaa4aa00379361a3f9f28880c007ffedf6652345`，仅修改 `packages/cli/src/session-send-receipt.test.ts`，30 行。可 cherry-pick 到正式 #279 分支；不要把个人组合 merge 提交当正式 PR 历史。
- 个人分支：`codex/joint-terminal-preflight`。无远端推送，无 PR base/Ready 修改，无主 checkout 修改。

## 契约与依赖检查

#279 使用既有 `AgentSessionEventSchema` 和 `confirmAdapterStopped`，没有直接依赖或修改 J01/J11 结构契约。成功条件是收到 completed terminal 且迭代正常结束；后续 throw/failed 仍进入停止确认。缺失 terminal 时，start 失败，send 保留不确定送达语义；只有可信适配器停止确认才释放 admission。正常 completed 流仍可直接释放，不要求所有内建适配器提供 stop verifier。

#278 的 cleanup 异常隔离与 #279 的 terminal 判定组合后均保留：cleanup 异常不覆盖已持久化结果；停止未确认时仍保留 lease。该组合不提供 J11 的持久化恢复或跨进程 retained-hold 恢复。DEBT02 的这些欠账仍成立。

## 已执行验证

- Node 22、独立 OSSTACK_HOME、统一 scratch 根；`pnpm install --frozen-lockfile --offline` 通过。
- `pnpm build`：全仓构建通过。
- `pnpm --filter @osstack/cli typecheck`：通过。
- `pnpm exec biome check packages/cli/src/session-send-receipt.test.ts`：通过。
- `pnpm --filter @osstack/cli exec vitest run src/session-send-receipt.test.ts src/session-rpc.test.ts src/session-wait.test.ts src/session-command.test.ts src/daemon-drain-recovery.test.ts src/adapter-lifecycle.test.ts`：6 文件，89 测试通过，0 失败。
- 新增 4 个矩阵场景：start/send × 空事件流/完全缺少 confirmStopped。断言 agent_failed、物理 cleanup 0 次、drain 仍有 1 个 hold；send 额外核对 failed receipt 和没有新增 turn。
- 有界变异：暂时移除 start terminal guard，并恢复 send 提前 settled。新增 4 测试全部失败，识别错误成功/提前释放。恢复产品代码后，4 测试全部通过（26 个其他测试被筛选）。变异 patch 和日志保留，变异没有提交。

## 下一批执行步骤

1. 等 #278 实际合并并记录 merge SHA，重新 fetch main。
2. 在正式 #279 分支合入最新 main，确认 diff 仅有 terminal-fence 相关内容及单独采用的补充测试；如果 #278 在本报告后改动，需要重新检查组合。
3. 采用补充测试时只 cherry-pick `aaa4aa00`。重新验证范围包含构建、类型、lint、完整测试、changeset 和实际 PR 差异。
4. 主入口运行 Claude CLI Sonnet 5.5 审计并保留原始结果，确认问题修复后重新验证。
5. 更新 OSStack 账本与 code SHA 绑定证据，通过后再将 #279 转 Ready，用户审批合并。

没有执行全仓测试、Claude 审计、live provider 停止验证或跨进程恢复实验。现有 same-process daemon restart 只能证明 receipt replay，不证明外部生产者已经停止，也不证明重启后的 hold 可见性。

原始 install/build/typecheck/lint/focused/mutation/restored 日志与 SHA-256 索引见同目录 `metadata.json`。原始测试先运行后提交，提交只包含当时通过的测试补丁，产品代码与组合提交一致。
