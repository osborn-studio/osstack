# Graph 运行时兼容矩阵

范围为本地内部 beta：固定模板、独立 Node worker、artifact-only 交付。原全库 engines 没有被提高。

| 形式 | 验证/行为 |
|---|---|
| macOS arm64 / Node 20.6.0 | 下载官方运行时并校验 SHA256；单独编译 ABI 115 的 better-sqlite3 12.10.0，SQLite 3.53.1。294 项内核/IPC/RPC/checkpoint 测试通过；整合后的最终迁移/DB 45 项通过。 |
| Linux arm64 / Node 22.23.1 | 独立磁盘上的干净安装/构建；实际 native SQLite、进程启动身份、丢失 host、held action、候选导出/恢复。最终 389/389 通过；专用 VM 的两套时间同步冲突已消除。 |
| macOS arm64 / Node 26.5.0 | 全库构建、类型、测试、故障矩阵、性能及真实 DeepSeek 试点。 |
| Node <20.6 | Graph 显式拒绝 `GRAPH_NODE_VERSION_UNSUPPORTED`；未借此提高旧命令的全库地板。 |
| Bun 单文件 | `GRAPH_DISTRIBUTION_UNSUPPORTED`；`--version`、help、Loop doctor、graph explain 帮助仍通过；无 daemon 内嵌引擎降级。 |
| 发布基线 @osstack/autonomy 0.17.0 | 实际从 npm tarball 调用旧 acquire：strict parser 拒绝 managed lock，新锁字节不变。更旧版本未准入共用活跃 graph home。 |

pnpm 11 是构建工具，CI 在 Node 22.23.1 安装与构建，再切换 Node 20.6.0 运行 Vitest 与匹配 ABI 的 SQLite。native module 必须重新编译/安装，不能把 Node 26 二进制复制给 Node 20。GitHub CI run 35550018695 中两个版本的 Graph runtime job 均通过；完整 CI 的状态另外记录，不能把矩阵通过等同于整条 CI 已完成。

干净安装发现 esbuild 原先仅是间接依赖，本机残留的根 `.bin/esbuild` 掩盖了缺失。现已把锁定的 0.28.1 声明为根 devDependency，不再依赖偶然的 hoisting。

## 仓库、产物与锁

- 仅 SHA-1，完整历史；拒绝 shallow、submodule、skip-worktree/sparse omission、冲突 index 和不安全路径。
- Full-history bundle 最大 256 MiB，捕获原始文件总量最大 256 MiB、100000 条。批量 cat-file 的协议开销独立计入，上限不能挤占合法原始内容预算。
- 原始二进制、空文件、重复对象、换行路径、符号链接和执行位有真实 Git 回归。原仓库删除后仍可验证/恢复历史；恢复目标必须全新。
- managed lock 持久记录 `recovery_policy:reconcile`。新入口即使主动指定 `recover_stale:true` 也不能回收；旧 0.17.0 解析器拒绝新字段；foreground Loop 入口也经实测拒绝保留锁。
- 真正 unknown 的执行/费用保留，不支持强制清理。这是明确的恢复边界，不能以兼容性为由删除锁或回退数据库。

完整结果和文件哈希见[收口报告](../reports/graph-upgrade-completion.md)。
