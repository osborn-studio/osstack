# 固定来源的读取探针

采用规划来源固定为 pstack **0.15.36**，仓库 `https://github.com/cursor/plugins`，commit `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`，子目录 `pstack`，tree `4719e1c4b4c43bac85d4206a8b41dd2899769c1c`。它与此前观察到的 `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe` 具有相同 pstack 子树。作者 Lauren Tan / poteto，MIT 许可。完整逐文件绑定见 [source-lock.json](source-lock.json)，`automatic_upgrade:false`、`active:false` 保留原值。

这是一组调用现有 `inspectGitSource` 的来源读取探针，不是执行上游 skill、安装、激活或正式资格。旧 `99b609a7` / 0.15.32 来源锁及历史成绩保持原样；新 pin 不反向升级旧运行。

## 原始尝试

下列文件均原字节保存在 [raw-verification.tar.gz](evidence/raw-verification.tar.gz) 的 `source/`，脚本和结果一一对应；初次结果未被后续成功覆盖。

| UTC开始时间 | 脚本及结果 | 观察 |
| --- | --- | --- |
| 2026-10-30 08:18:57 | `probe-source.mjs` → `source-inspector-probe-wrong-binary.json` | 将 gitBinary 配成 `/opt/homebrew/bin/git`；pstack 与 statechart 两次均 `INVALID_INPUT`。这条保留为 Git binary 配置错误，不算来源检查成功 |
| 2026-10-30 08:19:40 | `probe-source-v2.mjs` → `source-inspector-probe-partial-store.json` | 改为 `/usr/bin/git`，仍使用原 refresh checkout；两子树均 `PARTIAL_STORE`，读取器拒绝部分对象库 |
| 2026-10-30 08:21:26 | `probe-source-v3.mjs` → `source-inspector-probe.json` | 使用自有 `upstream.git` 对象库：完整 pstack 返回 `RESOURCE_LIMIT`；同 pin 的 `pstack/skills/statechart` 返回 `source_inspection` |

完整锁有 **573 个文件**，超过现读取器的 `FILE_LIMIT=512`；本次没有提高限制、截断清单或伪造全子树通过。后续需设计有界采用集合/引用闭包或明确资源预算后再接入，不能把注册 subdir 当成已经消费了子树。

statechart 返回 **408 项**，其中 407 项 source、1 项 `pstack/LICENSE`。其内容摘要为 `662fc97d46f69a1b0c68b937f213db26abc1d1c43955bebcc3c5bd18354eac98`，inspection 摘要为 `a1cb8bf2fc73f6e9b6519f32954d79d90466b2320306808e3411634136c30221`。原结果明确 `dependency_resolution:not_performed`、`repository_identity:caller_asserted`、`expected_digest_checked:false`，不能改称已认证依赖闭包、安装成功或 statechart 功能通过。源码文件里的命令均未因归档而执行。

原探针脚本保留绝对执行环境路径；JSON有每次开始时间和原始结果，但没有完整shell argv/cwd/结束时间/退出码封套。本次不事后编造这些字段。它们与 W01 的命令日志是不同种类证据。

## 来源原件与归档检查

`source/pstack-v0.15.36.tar` 原件 SHA-256 为 `1cd236f1c6d2b142903e56cb145bb3e85f99a64ec0de1850aad5959e76af9345`，大小 6,840,320 bytes。归档核对再次逐个比较其中573文件与source-lock的路径、长度、SHA-256及Git普通/可执行模式；Git tar中的0664/0775模式按执行位归一到100644/100755比较，不假称两种mode表示完全相同。未提取或执行任何上游文件。结果见 [source-member-checks.json](evidence/source-member-checks.json)。

`source/minimal-product-chain.md` 是原只读建议，原字节保留。其中提及旧 `1038dc9a` 历史checker修复仅是当时候选；**协调者明确不采用该旧实验路线**。本轮实际选择的是 W01 来源注册增量。原建议不是当前执行授权，也不是已经接通的 bugfix 入口。当前路线以协调者维护的 [PLAN.md](PLAN.md) 为准。
