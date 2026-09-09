# pnpm 环境准备：Claude Fable 5.1 两轮挑战

两次工具禁用的真实 `claude-fable-5-1` 调用，返回均为 `is_error=false`，两份 `modelUsage` 均包含 Fable 5.1（另有辅助 Haiku）。输入只含新写通用设计，未发送私有源码、审计或配置。

## 采纳与修正

- 采纳 workspace importer 精确集合、内部 link 必须被锁定、拒绝提交/沿用 node_modules、配置值与别名白名单、环境变量白名单、两份独立回执。
- 修正第一轮沿用 pnpm 10 设置的意见：当前支持 pnpm 11.4+ 的 11.x，使用 pmOnFail/error 与 no-runtime，并关闭 Corepack 自动下载；用真实 11.4.0 命令验证。
- 澄清 allowBuilds：保留它用于兼容已有工作区声明，但 install 的 ignore-scripts 更严格；真实 root 和 dependency postinstall 标记证明它们未执行。
- 未接受“第二轮允许修改锁文件后重算摘要”：当前候选范围明确保护 manifest/锁文件，变更必须失败，而不是扩大已经确认的权限。
- 不把缓存路径或版本号当成工具二进制身份签名；不把依赖输入摘要当成 node_modules 全量一致性证明。
- 实际集成测试发现 pnpm exec 也会加载 pnpmfile，因此把冻结的 Corepack 配置和 pnpm hook 禁用策略贯穿两轮验收；另用仓库 .corepack.env 试图改写缓存位置的 fixture 验证它被忽略。
- 真实 pnpm exec 进一步暴露了 pnpm 11 只读取 PNPM_CONFIG_*，且默认可能隐式重装。修正前的失败被保留为开发过程证据；修正后禁用 verifyDepsBeforeRun 自动重装，完整两轮 pnpm exec 验收通过。
- 不接受因失联就按租约释放占用；需要先证明旧进程停止并核实写入，仍由后续恢复切片处理。
- Corepack 中立探测使用冻结 packageManager 临时 manifest，安装前检查实际仓库源码与同一冻结输入一致。暂不支持 hash-suffixed packageManager、多注册表或自定义 runtime。

以下保留原始模型意见，未标为采纳的“阻断”措辞并不自动等于已确认代码漏洞。

## 第 1 轮输入

请用中文挑战一个通用的新设计，不含私有源码/配置。可信本地操作员的一次授权到草稿 PR 流程已有 Builder、独立 Reviewer、固定验证命令、补丁重建、第二轮干净验证、分别持久化 push 和 PR dispatch。不是 hostile-worker OS sandbox，不启用后台委托。
下一片增加显式 --prepare-deps pnpm。预览绑定 base SHA、root packageManager 精确 pnpm 11.x 版本、当前 Node 版本/平台/架构、pnpm-lock.yaml 摘要、所有安装配置由 base tree 绑定、固定安装策略（frozen lockfile、忽略生命周期脚本和 pnpmfile、不下载切换 package manager/runtime、私有 HOME 和每阶段独立 store）。安装在 Builder 前一次，在从保存补丁重建的 clean checkout 复验前再一次。安装前后检查仓库源文件/index不变；只允许未跟踪且被忽略的 node_modules 缓存。保存开始/完成/失败的环境准备回执及版本，不记录可能含凭据的原始安装输出。仍允许明确网络获取依赖，不宣称环境字节可复现或网络隔离。原生包若依赖安装脚本则失败而不偷偷启用脚本；原验收门不会削弱。安装失败/超时保留阶段占用，不自动重试。
请指出4个最有价值的漏洞或产品取舍，尤其工作区配置/外部本地依赖、包管理器版本切换、安装前后时序、私有 store 是否足以支撑 clean replay。优先给能证伪的测试。最多900字。只能依据此文本推理，不声称看过源码。

## 第 1 轮回复

以下仅基于设计文本推理，未见源码；每条标注“推理”与“可证伪测试”。

**1. 包管理器版本自动切换会绕过“不下载”承诺**
推理：pnpm 10+ 默认 `manage-package-manager-versions=true`，若本地 pnpm 与根 `packageManager` 不一致，pnpm 会自动下载并重执行目标版本；corepack 也有类似行为；`.npmrc` 的 `use-node-version` 还会下载 Node。设计说“配置由 base tree 绑定”，若 base 的 `.npmrc` 含这些项，将与“不切换 runtime/package manager”直接冲突，回执若只记录 `packageManager` 字段而非实际执行版本，会记录假象。
测试：base 写 `packageManager: pnpm@11.x.y`（与本地不同）或 `.npmrc` 含 `use-node-version`。预期：准备失败并出回执；断言无网络获取 pnpm/Node 二进制；回执中的版本来自安装后实际 `pnpm --version`/`node --version` 而非字段。

**2. 本地/外部依赖与 pnpmfile 使 clean replay 不“clean”**
推理：`link:../x`、`file:` 指向仓库外路径、`overrides`、`injected`、`catalog` 均由 base 绑定；Builder 阶段可依赖操作员机器上的兄弟目录成功，clean checkout 在其他位置则解析不同或失败，两轮结果不可比。另外 pnpm 9+ 锁文件记录 `pnpmfileChecksum`，`--ignore-pnpmfile` + frozen 会直接报错，等于此类仓库永久无法通过——这是取舍，需明示而非当作缺陷。
测试：base 含 `link:../outside` 与 `.pnpmfile.cjs`。预期：回执标注“外部路径依赖”或“pnpmfile 被忽略导致锁不一致”并失败；不允许两轮均“成功”但 node_modules 摘要不同。

**3. 补丁修改 package.json/锁文件时的时序歧义**
推理：设计把锁文件摘要、安装配置全部绑定 base tree，但第二次安装发生在“从补丁重建的 clean checkout”上。若补丁新增依赖：要么第二轮按 base 锁 frozen 安装而失败（合法补丁被拒），要么按补丁后树安装而违反“base 绑定”。且 Builder 阶段验证命令跑在 base 依赖上，与第二轮环境不同，两轮验证语义不一致。此外“忽略生命周期脚本”后（esbuild/sharp/prisma 等）失败会出现在验证命令而非准备阶段，成因难归因。
测试：补丁新增一个含 postinstall 的依赖并更新锁。预期：文档化的单一策略（例如以补丁后树重算摘要并在回执记录 base→patched 差异）；失败信息指出“依赖需要安装脚本”，而非下游测试的模糊崩溃。

**4. 每阶段独立 store + 私有 HOME 的副作用**
推理：独立 store 意味着第二轮全量重新拉取，锁文件 integrity 保证内容，但不保证可用性（撤包、镜像故障），一次瞬时网络错误因“不自动重试”永久占用阶段。若 base `.npmrc` 设 `store-dir`/`virtual-store-dir`，与“私有 store”谁优先未定义，可能悄然共享。私有 HOME 还丢失用户全局 gitignore，“只允许被忽略的 node_modules”检查可能在嵌套 workspace 包上误判。
测试：a) base `.npmrc` 设 `store-dir=/tmp/shared`，断言回执记录的有效 store 路径为私有路径；b) 第二轮模拟 registry 404，断言失败被标记为“环境/网络”而非“补丁”，且释放路径明确；c) 子包无 `.gitignore`，验证检查结果与预期一致。

优先级：1 > 3 > 2 > 4。

## 第 2 轮输入

请继续用中文挑战修订后的通用设计（未提供私有代码）。已采纳你提出的外部路径、版本切换、脚本和 store 风险。澄清 pnpm 11 已用 pmOnFail 取代旧 managePackageManagerVersions；限定精确 pnpm@11.4+ 的 11.x，不支持 pnpm12。显式 pm-on-fail=error、no-runtime、runtime-on-fail=error；Corepack下载禁用、禁止latest发现；使用预装的Corepack工具缓存，路径进入合同，依赖store则每阶段新建，不把共享的工具缓存冒充不可变证明。每阶段在中立私有HOME临时manifest中指明冻结pnpm版本，实际查询 pnpm/node --version；缺预装版本即失败。
安装策略：只支持公共npm依赖，拒绝所有npmrc、package.json pnpm/devEngines配置，workspace配置采用小白名单(packages/overrides/catalog/catalogs/allowBuilds)。拒绝file/link/Git/URL源；workspace协议只支持普通版本表达式，lock中的link只允许指向仓库内已提交manifest。lock resolution只接受完整性摘要，不接受自定义tarball/directory。源清单全部来自冻结commit，安装前后对完整源码/index做无变更检查。修订请求不允许改manifest/锁文件等既有受保护路径，故第一轮与重建后的第二轮环境摘要必须相同；原生安装脚本默认禁用，不据此宣称适用于所有项目。
已用真实pnpm+Git实验：一个仓库内workspace依赖在两次独立安装后可require，postinstall及pnpmfile均未执行；Node版本漂移、未提交配置变化会拒绝。下一层接入完整CLI确认到模拟GitHub；不把模拟GitHub当在线试点。准备目录有started/completed/failed不可覆盖回执，失败保留运行占用，不自动重试。网络并无OS层隔离，私有HOME也不是同用户文件沙箱。
还有哪些阻断性问题或实用性缺口？请最多600字；不要将未见源码的猜测当事实。特别关注lock importer来源、workspace配置别名、Corepack中立版本探测和验收证明强度。

## 第 2 轮回复

以下按“阻断性/实用性”分列，均为基于描述的设计推理，非源码事实；pnpm 11 的具体配置名以你的陈述为准，我无法独立核实。

**1. lock importer 来源（阻断）**
- importers 集合由 `pnpm-workspace.yaml` 的 `packages` 通配 + 根目录决定。设计需显式断言：`lock.importers` 键集合 == 冻结 commit 上按通配发现的目录集合；多一个或少一个都应拒绝，而不是依赖 frozen-lockfile 的报错措辞。
- `link:` 目标除“已提交 manifest”外，还应要求其本身是 importer；否则目标的依赖可能不在 lock 中。
- 应拒绝仓库内已提交的 `node_modules`，以及 `lockfileVersion` 与冻结 pnpm 不匹配的 lock（后者是常见实用性缺口）。

**2. workspace 配置别名（阻断）**
- 白名单需覆盖 `overrides`/`catalog(s)` 的**值**：它们同样可写 `npm:`、`link:`、`file:`、URL；仅拒绝 package.json 源不够。
- 明确 `workspace:*`、`^`、`~` 是否属于“普通版本表达式”；当前描述有歧义。
- 键名大小写/连字符变体（如 `allowBuilds` vs `allow-builds`）是否被 pnpm 同等接受需实测，否则白名单可被同义键绕过。
- 脚本默认禁用时，白名单里的 `allowBuilds` 语义矛盾：要么删掉，要么说明它可重新启用脚本。
- 环境变量 `npm_config_*`、`NODE_OPTIONS`、`COREPACK_*` 可越过 npmrc 拒绝；私有 HOME 不清理 env，需要显式 env 白名单。

**3. Corepack 中立探测（阻断）**
- Corepack 从 cwd 向上查找 `packageManager`；若探测在临时目录、安装在仓库内，两者可能用不同版本。需固定 `COREPACK_ENABLE_PROJECT_SPEC=0` 或要求仓库 `packageManager` 与冻结版本严格相等，并在同一 cwd/env 下探测。
- 若 `packageManager` 带 `+sha512`，需说明预装缓存是否校验该哈希。
- 探测应记录 `process.execPath` 与 pnpm 实际路径，而非仅版本号。

**4. 验收证明强度（实用性）**
- 已观察：单仓库、两次独立安装、可 require、脚本未执行、版本/配置漂移被拒。未证明：需构建产物（`main` 指向 `dist`）的 workspace 包可用；多注册表/`catalog:`/`overrides` 场景。
- “环境摘要相同”需明确范围：若不含 `node_modules`，不证明安装确定性；若含，`.modules.yaml` 等含绝对路径/store 路径，每阶段新建 store 可能导致摘要天然不同，需固定路径或排除并说明。
- “未执行”应以标记文件缺失等正向证据记录，而非日志缺失。

**5. 回执（实用性）**
- started 后进程崩溃且无 failed 回执时占用永久滞留；需要显式回收/租约机制，且回收动作本身应留回执。
