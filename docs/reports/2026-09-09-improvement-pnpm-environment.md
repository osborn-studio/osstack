# 改进任务的 pnpm 环境准备

基于已合并的 #220，增加可选 `improve deliver --prepare-deps pnpm`。一次预览确认内，先为 Builder 准备依赖，交付前再从保存补丁重建并独立安装依赖，然后执行原有验收门。修复“干净 checkout 缺少依赖”这一阻塞；不修改原有验收命令。

## 使用与可观察性

```sh
osstack improve deliver --proposal <id> --execution <stable-id> \
  --registry <path> --profile <name> --prepare-deps pnpm

# 同样的参数，加预览返回的摘要和 --yes；无需再次逐阶段输入 go。
osstack improve deliver --proposal <id> --execution <stable-id> \
  --registry <path> --profile <name> --prepare-deps pnpm \
  --request-digest <preview-sha256> --yes

osstack improve status --execution <stable-id>
```

该选项只用于 `deliver`，默认不安装。确认绑定 root `packageManager` 的精确版本、实际 pnpm/Node 版本、平台/架构、Corepack 缓存位置、已提交依赖输入的 SHA-256 与固定安装策略。摘要改变时旧确认失效。缺少已安装的工具版本直接失败，不自动下载工具或切换版本。

status 的 `environment.candidate`、`environment.replay` 展示各阶段目录和 `not_started / started / completed / failed / unreadable`。每个目录保存不可覆盖的 `started.json`、`completed.json` 或 `failed.json`；失败含 `input_validation / toolchain_check / install / source_check` 阶段，避免与补丁验证混淆。回执不保存原始安装输出，避免把错误信息中的凭据 URL 写入证据。一次目录不能被用来重新安装。

首次成功的环境回执也纳入候选证据 manifest。崩溃可能只留下 started；失败和失联保留占用，不自动重跑或释放。已有 `stop` 在阶段边界生效，不代表进程及后代已被终止。准备命令使用已确认的阶段超时；版本/输入查询另有 30 秒单调用上限，不宣称总墙钟硬预算。

## 首版支持的环境

- 精确 `pnpm@11.4.x` 或更高的 11.x；lockfile version 9。暂不支持 pnpm 12 或 `packageManager` 的哈希后缀。
- 根目录必须提交 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。所有已提交 manifest/锁文件/钩子进入摘要；不接受已提交 node_modules 或嵌套 workspace 配置。
- 工作区配置仅支持 packages、overrides、catalog、catalogs、allowBuilds。packages 支持相对显式目录、单层 `*` 和 `!` 排除；暂不支持 `**`、括号扩展等复杂通配。
- lock importers 必须与这些模式匹配的已提交包集合相同；内部 `link:` 必须指向其中已锁定的包。workspace 普通版本表达式与 catalog 引用可用，外部 file/link/Git/URL 依赖、自定义 tarball 不支持。
- 公共 npm registry，标准完整性摘要。拒绝 npmrc、自定义注册表、manifest pnpm/devEngines 配置和其他 workspace 配置。override/catalog 的值同样不能引入外部来源。
- 安装使用 frozen lockfile、ignore-scripts、ignore-pnpmfile、no-runtime。即使仓库 allowBuilds 指定 true，当前策略仍不执行安装脚本。已有 pnpmfile checksum 与禁用 hook 不兼容时直接失败。
- 每阶段新建私有 HOME 和依赖 store，以 copy 方式导入依赖，禁用全局 virtual store 与 side-effects cache。不接受已有 node_modules 的工作区；安装前后核对源码和 index 不变。两轮验收继续使用相同的 Corepack/版本策略与 pnpm 钩子禁用配置，防止 `pnpm exec` 再次加载 pnpmfile；显式验收脚本仍正常执行；通过 pnpm 11 的 `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` 阻止运行命令前自动重装，避免额外安装或重新触发生命周期脚本。node_modules 必须由仓库提交的 ignore 规则排除，不能依赖用户全局 gitignore。

这是锁文件约束下的依赖准备，不是操作系统沙箱或位级可复现环境。Corepack 使用合同记录的预装工具缓存；该缓存仍是宿主可信工具的一部分，并非不可修改证明。环境变量通过白名单构造，Corepack 网络下载及 `.corepack.env` 读取关闭；公共 registry 选择不是网络防火墙，代理、镜像可用性和宿主权限仍有影响。回执中的输入摘要也不等于整个 node_modules 的内容摘要。

需要 postinstall/native build 的依赖可能安装成功但后续验证失败；本版不会擅自重新启用脚本。需要 `dist` 的 workspace 包也必须通过已授权命令完成构建。本片没有验证所有 OSStack 原生依赖可用，也没有将这样的限制包装成完整 P2/P2b 完成。

## 验证依据

真实 pnpm/Git 的 workspace-only fixture：两个独立安装均可 require 仓库内依赖，root/dependency postinstall 标记文件不存在，pnpmfile 未执行；第二次使用新 checkout 和独立 store。工具版本漂移、未提交输入变动、旧 node_modules、非法来源与 importer 不一致会被拒绝。

完整 CLI 测试：一个确认完成两次真实准备、包含真实 `pnpm exec` 的两轮原验收门，再到模拟 GitHub 草稿 PR；status 显示两个 completed 回执。锁不一致测试保留失败回执和运行占用，Builder 调用为零，重复请求不重试。真实仓库只读预览识别出 pnpm 11.4.0 和 31 份已提交输入；这不是对整仓冷安装或在线交付的验收。

两轮实际 Claude Fable 5.1 设计挑战见[记录](2026-09-09-pnpm-environment-fable-review.md)。Fable 未读取私有源码，模型意见与实际测试分别记录。

下一片优先补充原生构建的明确策略和真实 cold-install 验收，再完成受限 worker/终止证明。daemon 和签名代码委托仍依赖该执行边界；不能因本片安装成功而提前启用后台自治。

来源：[pnpm install](https://pnpm.io/cli/install)、[pnpm workspace settings](https://pnpm.io/settings)、[Corepack 环境变量](https://github.com/nodejs/corepack#environment-variables)、[pnpm 11 配置迁移](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md)。在线 pnpm 文档已显示 12.x，实际命令能力另外用本机 11.4.0 的 help 和真实安装验证。


最终本地验证：`pnpm build`、`pnpm typecheck:check`、`pnpm lint`（两条既有 warning）、inventory freshness、changeset coverage/self-test 均通过。`pnpm test --maxWorkers=4` 全量通过 291 个文件、2579 个测试。默认并发复验曾使未修改的 guarded-local 测试超过既有 5 秒上限，并引出目录清理错误；限制并发后该测试与整套测试通过，未放宽断言或超时。启动预算也通过：version 中位数 36ms、help 204ms（测量时有并发测试负载）。所有 CLI/整仓测试都使用独立临时 OSSTACK_HOME。
