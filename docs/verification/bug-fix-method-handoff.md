# 把一张缺陷卡的方法材料交给现有 Loop

本教程使用仓库 helper `scripts/prepare-bug-fix-method.mjs`。它把显式输入编译为非执行 proposal，写出角色材料与现有 `deliver --execution-context` 配置。它不建卡、不选择待办、不启动 Loop，也不授予执行权限。

目标是同一张当前缺陷卡：问题与检查 → 方法材料 → 既有 V2 deliver/Loop → host 候选核验 → 同卡证据。本批尚无 P6 真实任务或 native skill 使用证据，自动看板回写也未接通。

## 输入与前提

从匹配构建的 OSStack checkout 调用。Helper 加载 `packages/skill-registry/dist/bug-fix-compiler.js` 和 `packages/cli/dist/method-context.js`，必须使用支持当前契约的同批构建。准备过程无需模型或数据库。后续 deliver 会运行配置的 agent 和检查，需已有任务授权、隔离 home、profile 和 V2 合同。

请求 JSON 只有以下顶层结构：

```text
schema_version: 1
compilation: BugFixCompileInput
host:
  workspace_path: 已存在目录的真实绝对路径
  package_version: "0.15.36"
  capabilities: [{role, capability_id}, ...]
  max_prompt_bytes: 最终整个 prompt 的字节预算
  max_knowledge_bytes: 可选 knowledge 的字节预算
```

Capabilities 须覆盖 builder/reviewer/verifier，每个 capability ID 只能映射一次。填实际执行链使用的 ID；角色名称不证明模型身份或权限。

| compilation 字段 | 内容及检查 |
| --- | --- |
| schema_version、target_repository | 版本 1；目标与 host.workspace_path 的真实路径一致 |
| intent | MaterialIntentFrame：task/revision、goals/non_goals、observations、hypotheses、unknowns、source_refs；观察与假设分开 |
| source_snapshot、source_snapshot_digest | 协议 SourceSnapshot 与重算摘要；调用方提供的结构事实，不是编译器认证的 Git 内容 |
| materials | 三角色各一份 {role,text,sha256}；核实际 UTF-8 bytes，拒空材料、漂移或重复角色 |
| required_artifacts | ArtifactRequirements，recipe_version 为 bug-fix.v1；intent_frame/reproduction/candidate_checks 由 builder，independent_review 由 reviewer，cleanup_receipt 由 verifier，均 required |
| required_feature_ids、available_feature_ids | 明确且不重复的 ID，available 须覆盖全部 required；不证明功能已实测 |
| check_registry | CheckRegistry：命令 bytes 摘要、pass/fail exit codes；这里只是声明，不执行命令 |
| check_binding | repo、primary ID、三个必需 check：reproduce/regression/acceptance 各一个；primary 为 acceptance；引用须已注册且映射无歧义 |

每角色材料最多 32 KiB，三角色总计 96 KiB；编译输入/输出限 512 KiB。请求 JSON 文件也限 512 KiB。材料 framing、任务说明、host 安全说明与合同还占最终 prompt 空间；能编译不代表整个 prompt 装得下。超限拒绝，不截断必需内容。

不能把 `declared_adoption_candidate.candidate_digest` 填成 source_snapshot_digest，也不能把上游方法库当目标产品仓库。来源、版本、功能可用性、registry 和材料 hash 都不能代替任务权限或 host policy。

## 准备全新局部产物

先写好完整请求，选择 workspace 内全新绝对输出目录；父目录已存在且路径不经过 symlink。输入必须是普通文件；helper 拒绝输入文件 symlink。不覆盖已有输出，包括失败残留。

```sh
node scripts/prepare-bug-fix-method.mjs --input "$REQUEST_JSON" --output "$NEW_HANDOFF_DIR"
```

参数顺序为 --input 后 --output。成功 stdout 为 JSON，含 status:prepared、executable:false、output、context_path、task_id、proposal_digest，exit 0。失败 stderr 为 status:rejected 与错误 code，exit 2。准备成功不是修复执行成功。

| 文件 | 用途 |
| --- | --- |
| compiled.json | 非执行 recipe/proposal、三角色 MethodInput、检查绑定、必需义务及摘要 |
| builder.md、reviewer.md、verifier.md | 与输入 text 完全一致的角色 bytes |
| context.json | 指向编译结果与三份材料的 local execution-context 配置 |

`methods.compiled` **必需**为 `{path,sha256}`：相对 workspace 的 compiled.json 路径及其实际文件 bytes hash。`methods.roles[].materials[]` 绑定角色材料相对路径/hash。不要删除 compiled 来兼容旧构建。Helper 不生成正式 MethodBinding、TrialPermit 或 admission。

## 合成示例与测试

仓库 synthetic-bug-fix-compilation.json (removed) 是合成输入。其来源事实、命令摘要、角色正文与“观察”都是测试构造，不是当前缺陷证据。

准备演示时，复制到自有 scratch；将 compilation.target_repository、compilation.check_binding.repository、host.workspace_path 同时改成演示 workspace 的真实路径，再加完整 host envelope。若改 source snapshot 或 material text，重算相应摘要。`test.builder` 一类 capability 不是实际 host 配置，不能直接用于真实 deliver。

本教程编写过程未执行演示或测试。精确 helper 测试入口是：

```sh
pnpm test:bug-fix-method
```

使用匹配构建和自有 OSSTACK_SCRATCH_ROOT。该命令验证 helper，不是产品修复命令或 native skill 验收；结论以实际日志为准。

## 接到现有 V2 deliver

从当前卡记录 card/board/repository/task ID、trigger、期望、允许路径和实际注册检查。Helper 不自动读取卡。对齐 intent、V2 合同与 context 的 task ID；配置实际三角色 capability。

后续调用还需要：当前 repo/base；可用 profile/adapter；当前 goal/task/repo/base/policy/budget 匹配的 V2 implement 合同，completion 为 local_verified；host policy 中实际注册的复现/回归/主验收检查。输入 registry 不能自动注册命令。材料、compiled 和 context 必须未漂移。

以下是现有调用形状，**本教程未执行**：

```sh
OSSTACK_HOME="$TASK_HOME" OSSTACK_SCRATCH_ROOT="$TASK_SCRATCH" node packages/cli/dist/bin.js deliver "$TASK_GOAL" --workspace "$TASK_REPO" --autonomy guarded-local --contract "$TASK_CONTRACT" --profile "$TASK_PROFILE" --execution-context "$NEW_HANDOFF_DIR/context.json" --json
```

TASK_HOME 必须显式自有，不能使用默认/保留 home。V2检查来自 host policy；额外 --verify 不在集合内会拒绝，不用 --execute 绕过 implement adapter。

现有 deliver 的 V2 本地路径使用 LoopEngine，传单个 inputTasks 与 sources:[]，避免扫描其他任务。方法由现有 execution-context host 包装 adapter，以完整 untrusted reference 数据进入任务 prompt；不能覆盖用户或 host 指令。

当前宿主接线的检查顺序为：

1. 在 host workspace 内读取 compiled 相对文件，拒 symlink/非文件/超限，核原始 SHA256 与 UTF-8/JSON。
2. 从编译结果中的原始输入字段重跑纯编译，核整个 canonical 输出等值，含 recipe、role_inputs 和派生摘要。
3. 核 task/repo/proposal，以及所有角色配置与 compiled 材料 hash 的对应。
4. 读所选角色完整材料并核 hash，装配独立数据块，检查最终 prompt 预算。
5. prepared receipt 与 source validators 后、adapter invoke 前，同步重读 compiled 和所选材料，核原 hash。

方法 receipt 含 compiled 的 path/hash/bytes 与 `proposal_binding:recompiled_caller_facts`；identity 仍是 caller_declared。重编不认证源数据、grant 或 registry。代码已加入该连接，但真实 host 使用与 P6 尚待独立证据，不把结构检查写成实际修复结果。

现有 wrapper 在 invoke 前保存 prepared receipt，在 adapter 首个事件后保存 adapter_observed receipt。边界是 `agent_task_prompt_not_provider_wire`，不是 provider 内部上下文、native skill 调用或 token-window 资格。Prepared 不等于已调用 adapter；最终成功还要看真实 trigger、required checks、候选与 host delivery receipt。

## 有界真实材料与恢复

本批 actual-material-plan 草案包含四份完整操作材料（bug-fix、investigation、code-review、evidence）和 sources.md 完整的当前0.15.36来源声明区段，不是整个混合版本 sources.md 或全部递归链接闭包。

原始递归闭包超出32KiB。所选组合 builder 32,286 bytes、reviewer 32,303 bytes、verifier 32,309 bytes，总96,898 bytes，含范围/角色说明。这些数字绑定 scratch 的 compiler/actual-material-plan.json；实际 helper 输入仍应核自己的 bytes/hash。完整命名区段选择不能说成“全文全部采用”。

Engineering-decision 是另一 surface 的可选例，refactoring 是不同意图的条件路由。普通 bug-fix 不执行它们；若真实任务需要，则扩组合、重新编译并核预算，不忽略必需引用。

| 错误/情况 | 恢复 |
| --- | --- |
| MATERIAL_DRIFT / SOURCE_DIGEST_MISMATCH | 保留原输入和错误，查明改变，建立新匹配输入和新输出 |
| CHECK_NOT_REGISTERED / MISSING_FEATURE | 补实际检查声明或前提，不删除 required 掩盖缺口 |
| REPOSITORY_MISMATCH / capability歧义 | 对齐真实repo、task和角色映射，改标签不等于身份认证 |
| EEXIST / OUTPUT_ESCAPE_OR_SYMLINK | 保留原件，纠正路径并选自有新目录，不覆盖或放宽限制 |
| method_context_compiled_invalid / compiled_mismatch / binding_mismatch | 保留失败文件；核compiled、配置与匹配构建，重新准备，不只改单个hash绕过重编 |
| method_context_pin_mismatch / budget_exceeded | 查漂移或真实预算，重新准备；不静默省略材料 |
| 已invoke后失败 | 按现有状态保留事件、候选、检查输出和清理状态，不把投影重试当重跑修复许可 |

成功不要求 stderr 必定为空。按实际退出码、结构化结果和产物解释；工具错误不自动等于产品回归。

## 尚缺的单卡实证

仍需 P6 当前真实卡完成：原始失败 → 最小修复 → 同入口通过及邻近控制 → host候选核验 → 同卡可追失败/成功/材料/receipt。真实模型任务、native discovery、provider wire、自动card→合同与幂等receipt→card投影不能由纯编译或文件产物代替。

自动投影未接通前，可按既有授权通过现有看板界面人工关联证据，并明确这是人工步骤。先保留receipt再回写；失败标未同步，不能丢证据、重跑模型或直接标卡完成。local_verified不含merge/release，人类保留合并决定。

## 构建兼容与声明边界

编译结果须由匹配的OSStack构建生成；宿主重编比较整个输出，包括limitations说明，因此未来编译器变化后应重新准备新目录，不能只替换hash。无methods的既有路径兼容；公共wrapper若提供methodContext而mode不是local，将拒绝配置。proposal_digest不是整个编译文件摘要，后者由compiled.sha256另行绑定。task_id对应不证明live prompt和intent语义相同，capability/role及检查注册声明仍需调用方与既有host policy正确配置。
