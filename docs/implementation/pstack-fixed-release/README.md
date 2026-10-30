# pstack 固定发布：来源证据与 W01

本目录保留新版来源规划和 W01 来源注册的原始验证。当前交付新增 `SkillSource.subdir`（默认 `.`）及独立 `package_version`（默认 null），拒绝来源与顶层manifest的未知字段。显式 pstack/0.15.36 可在 `addSource → writeManifest → readManifest` 往返；ref、blessed_sha 和版本标签分别保留，标签不证明commit对应某次发行。

这仍是**注册能力**。未接通watcher/normalizer对子树的采用、SourceSnapshot依赖闭包、方法消费者、安装或runtime激活；没有正式资格声明。`auto_minor` 默认仍false。来源pin与实际探针边界见 [SOURCE-PROBE.md](SOURCE-PROBE.md)，后续工作由 [PLAN.md](PLAN.md) 管理。

## W01 实际检查

| 检查 | 旧源码 | 新源码 | 原件位置（archive内） |
| --- | --- | --- | --- |
| 作者相同focused两suite：manifest46 + watcher6 | 52项，43失败/9通过；exit1 | 52项全通过；exit0 | `w01/author/red-focused.*`、`green-focused.*` |
| 独立冻结输入与脚本 | 47项，45行为失败/2通过；exit1 | 47项全通过；exit0 | `w01/independent/old.*`、`new.*`、各阶段`results.json` |
| 目标package typecheck | 首次exit2：缺少core/protocol声明 | 构建现有依赖后exit0 | `w01/author/typecheck-1.*`、`dependency-build.*`、`typecheck-final.*` |

作者最早 `pnpm test -- ...` 转发了分隔符，额外收集source-snapshot suite，因依赖尚未构建而import失败；它保留在 `red.*`，不冒充正式focused行为RED。随后修正为 `pnpm --filter @osstack/skill-registry exec vitest run src/manifest.test.ts src/watcher.test.ts`，同一测试文件对旧新源码给出上表52项结果。首次install的missing-bin警告也原样保留。target typecheck失败后的修复是构建依赖，不是放宽检查或改成只查测试副本。

独立检查在作者实现前冻结输入，真实加载schema/YAML，读写只用自有scratch显式路径；watcher的git spawn被拦截，证明逻辑只报告不自动采纳（包括auto_minor=true），不冒称实际联网进程测试。路径逃逸被拒，合法shell/symlink-looking字符串保留为数据且解析无额外IO/执行；不是任意symlink race安全证明。未触默认home、未运行W19或全仓测试。

作者原候选绑定：manifest.ts `d775042ab6befbb09b4e2c363bd8e1240b6ad1cf89a1891072bfd5acf5024795`；manifest.test.ts `269db5bd88083d5cb045822e109969b656df307564df6864ef1f367f524110c2`。独立47项对同一manifest字节通过。归档时root拷入字节与作者相同；**root后续格式化/整合的候选是另一个字节绑定**，其最终验证由root另记，不能把上述原候选hash改写成格式化后的hash或声称旧运行验证了新字节。

## 归档与复核

[raw-verification.tar.gz](evidence/raw-verification.tar.gz) 包含：

- `source/`：三份probe脚本、三份原结果、source-lock、完整pstack源tar、原minimal-product-chain报告。
- `w01/contract.json`：本切片冻结契约。
- `w01/author/` 与 `w01/independent/`：两个目录全部原件，包括错误、测试输入、旧新源/patch、脚本和实际stdout/stderr。未收node_modules。

[raw-manifest.json](evidence/raw-manifest.json) 逐成员记录原路径、type、mode、size与SHA-256（如有symlink则只记target、不解引用）。本次 **66成员：60文件、6目录、0链接，文件总长7,340,069bytes**。archive SHA-256 `46dbd806d0b52b33dbaae9d141e4421769c3429a21d446640b51e143ce2d74ba`。

[verify-archive.py](evidence/verify-archive.py) 只读tar、manifest及可选原scratch；不提取、不运行归档源码。[member-checks.json](evidence/member-checks.json) 为逐项tar/manifest/原件比较，[archive-check.json](evidence/archive-check.json) 为汇总，全部相同；另对嵌套源tar573文件逐一核对source-lock。脚本以排他写入保存检查结果，重核时应在新的归档副本目录运行，避免覆盖本次结果。

原scratch未改，独立归档者只创建本目录新文件，不改PLAN、产品、Git或中央账本。未打包完整upstream.git对象库、无关看板快照或node_modules；源字节以完整tar+source-lock保留。原建议中的旧1038历史bugfix路线由协调者明确不采用，不作为本轮成果或下一步强制门槛。
