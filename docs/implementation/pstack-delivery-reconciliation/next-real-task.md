# 下一次真实宿主闭环：修复历史 packet 检查器的状态矛盾漏检

本文件是可执行任务选择与准备规格，不是已执行实验、独立预冻结或新产品交付。此次只读核对Git对象和保留记录，没有调用模型、运行检查器、改仓库或新增卡片。

## 选择与价值

选择历史真实缺陷：证据包中某feature为 `verification:not_run`、`cleanup.status:not_started`，却同时声称 `fixture_removed:true`。旧的真实CLI `--check` 返回valid/exit0。这个问题此前由独立反例发现并确认，不是本次为了展示而故意破坏产品。它已在主线修复；新实验要求两宿主从未给出答案的历史源码各自诊断、写回归、修复、重跑。产出是**真实历史缺陷的隔离独立修复能力证据**，不是第二次新增生产功能，也不是首次发现未知bug。

优于再次让模型解释历史日志：任务必须实际编辑源码和执行同一个CLI检查；代码约200行、依赖仅两个本地helper及Node内建模块，无pnpm安装、数据库、网络、编译或真实账号操作。避免把时间花在环境搭建。修复范围可以很小，但必须保留合法输入，不能靠一律拒绝过关。

## 精确来源与原始失败

产品基线Git对象：`1038dc9a0f79696d4077064181321de7501b7cb8`。
仅从该对象取三份执行文件，按原相对布局放入每个新scratch workspace：

- `scripts/project-method-journey-evidence.mjs`，可写目标。
- `scripts/lib/scratch.mjs`，只读。
- `scripts/lib/skills-check-verification.mjs`，只读；静态import只有Node内建模块。此任务仅走`--check`，不运行其driver能力。

允许新增 `scripts/packet-state-regression.test.mjs`。不提供旧仓库整套测试、Git历史、修复diff、当前checker或审计报告。给最小任务说明和baseline源码即可；如需package元数据，用明确标记的实验生成最小package.json，不伪称来自原版本。`.mjs`本身无需package安装。

历史原件根：
`/Volumes/AIMATE_WORK/tmp/osstack/runtime/method-evidence-projection-20261028/independent/`

- 原失败 `1038dc9a/notrun-removed.command.json` SHA256 `7331186add47466cb801b08abaebd96691c28a20534c2ed48ddaa85517a8117f`：真实exit0，expected_exit1，met_expectation=false。
- `1038dc9a/notrun-removed.stdout`记录valid；它不能作为本轮执行证据。
- 同输入历史修复记录 `0e763694/notrun-removed.command.json` SHA256 `71e81449fa6cd9ba79982246293bfb23f1db1cc3b66e2929dde65571f74fbaf5`：真实exit1。该历史修复对象为`0e763694c7bed7d3c3aa61c7fdb9d03bcc906402`，只供协调者验证任务可解，**不得放入模型输入或允许读取的目录**。
- 两历史目录的bad packet与manifest已经逐字比较相同，不是把输入改为更容易拒绝的情况。

模型可见输入取自旧 `1038dc9a/scratch/`，复制时改为中性目录名，但原字节不变：

| 模型任务目录 | 原始目录 | packet SHA256 | manifest SHA256 |
|---|---|---|---|
| `inputs/incident` | `notrun-removed` | `c2df3caede992a9d29142073090628aa677e2d0d430f79e3ef3c9501f3cca8f3` | `1c6ff6afcde4e06bdb2fc25e3631c735760e74233ab9fa561b32a72f4353cbd2` |
| `inputs/control-a` | `doctor-failed-not-run` | `c6d69b8762c119ec39da8938d2e026db209ec7fc1cd41d7401fd3d4f0c0e4d3b` | `039a667c3058119edd1f4f9a4742cdd4a3669079256f9cea6ea1c5b7e33339d4` |
| `inputs/control-b` | `real-pair` | `b5c2c57fbf58e58f253e4f1e1e585731293c16c97fd5fba74c9c2d7a5e067cd3` | `6386eca2ac0d8639c2d8b3bbd88a60e3a21c9d6f74d6446d552afa8c0c80eec7` |

incident/control-a各packet1867bytes，control-b6008bytes；manifest均189bytes。这些是历史固定输入，不含环境对象/凭据或原证据可解析路径。本轮准备仍须核验exact2files与hash，不能只相信此表。

## 给宿主的同一任务与边界

建议用户提示：

> 使用此工作区的OSStack bug-fix方法。随附incident证据包含互相矛盾的执行/清理状态，但检查器将其报告为valid。请先实际复现，新增能捕获问题的回归测试，在允许源码内修复，再以相同CLI和未修改输入验证。两个合法control必须继续接受。保留原失败、实际命令/退出码和改动；不读取本工作区之外的仓库、历史修复或其他宿主结果，不联网、不安装、不改输入、helper或方法材料，不运行其他产品。说明证据支持到哪一层。

允许修改只有checker和新增回归测试；报告/日志写本workspace的`results/`。禁止改golden输入、依赖helper、验证器期望或模型方法。无PR、merge、默认home、生产进程、watcher、子代理或新模型调用。已明确授权的局部修复无需再次问批。

方法来源用已合并main `e26f6d2ca81628b565d2db0fd047fcb041fa8a45`，实际exporter生成相应host四入口布局。模型按可用宿主方式读取osstack-mode及bug-fix/evidence，不能把新14th候选算作merged方法。若只观察到显式读取，就记显式读取；不以native发现为这次修复任务的前置障碍，也不凭模型自报认native。实际使用途径和成功执行分轴记录。

## 两宿主独立空间与防泄漏

协调者为Codex/Claude各建立一个新的独占scratch目录，例如 `$OSSTACK_SCRATCH_ROOT/runtime/packet-repair-codex-<run>` 和`packet-repair-claude-<run>`。不是Git worktree；不要复制当前工作树或提供连接主仓库objects的`.git`文件。若需要diff，创建只含baseline的本地Git仓库、无remote，不保留原提交历史；原始来源SHA和映射保存在模型不可见的协调者证据目录。

两边初始源码、fixture字节和任务完全相同；各自修复不相互读取。没有修复提示、代码行号、预定补丁或历史固定错误码要求。正常bug描述与成功条件不是答案泄漏，隐藏的是具体实现和独立holdout。

独立评估者在任何模型输出前冻结：1原incident拒绝；2两合法control接受；3相同非法组合换到另一个未运行feature仍拒绝；4原始合法unknown/not_started语义不被过拒绝；5原hash破坏仍拒绝；6允许写入边界和输入不变。额外样例仅由已合法基线作小变更并正确重封manifest，不修改产品来制造bug。先验证holdout基线性质，避免它因不相关已知旧问题失败。隐藏样例及判断器置于模型不可见位置，后验揭示不能再让宿主修补本轮答案。不要用补丁相似度评分。

Codex现有sandbox未必限制读路径，Claude技能设置也不是OS隔离证明。使用实际可用的约束，不临时宣称强隔离；保存完整工具trace并拒绝越界读取的本轮结果。无网络/历史入口暴露可降低泄漏，但不能声称消除了模型训练记忆。记录这是一项已知历史缺陷的前向独立执行，不是盲测未知缺陷。

## 同路径执行与验收命令

使用实际Node22.22.1，设置只供产品命令的最小环境及专属 `OSSTACK_SCRATCH_ROOT`、`OSSTACK_HOME`；本任务不打开OSStack DB。不要把模型认证环境传入checker命令，也不打印其值。

在各自workspace内，宿主本人应执行以下真实CLI，首轮保存完整stdout/stderr/exit，修复后对同一输入重复，不改argv语义：

```sh
node scripts/project-method-journey-evidence.mjs --check "$PWD/inputs/incident"
node scripts/project-method-journey-evidence.mjs --check "$PWD/inputs/control-a"
node scripts/project-method-journey-evidence.mjs --check "$PWD/inputs/control-b"
node --test scripts/packet-state-regression.test.mjs
```

这些是计划命令，本次预检未执行。incident在旧源码预期**错误地exit0**，正确修复后应exit1且JSON拒绝；两个control应始终exit0且JSONvalid。必须同时看内容和exit。回归测试在旧源码应至少一项断言失败，修复后通过；不能改断言去配合错误行为。具体错误码不与历史补丁绑定。协调者用保存的未修改输入和host实际patch另外重跑同一路径及隐藏控制，结果记为独立复验，不假装是模型自行执行。

每一调用产品命令外层限10秒，禁止后台进程。初始化时记录Node版本、3来源文件hash、方法source/exporthash与全部文件清单；结束后对照类型/mode/长度/hash，检查仅两允许文件及results变化。任何运行失败、超时、无工具执行、只交建议或越界编辑都保留，不用报告口才替代实际修复。

## 证据与成本建议

每宿主一次新会话/user turn、零自动重试，工具内循环不另算新的用户调用。每宿主最长600秒：相比旧只读180秒，这是有意为实际写测修保留时间。总最多2次模型调用，可并行但不共享工作区或可写资源。Claude使用已授权实际`claude-sonnet-5-5`；Codex由当前认证目录确认可用模型，resolved identity未暴露时仍not_attested。CLI参数必须查真实help，不在本文件猜不存在的预算flag。

预算目标：初始材料<=30KiB有效任务文本，避免把全部历史日志/构建清单塞入prompt；最终报告建议300词以内，但文字长度不替代修复成败。记录actualtokens/modelUsage/cost和wallclock；若宿主无token硬限，标记目标非强制cap。不给重复rerun预算，失败可形成后续独立任务，不在本次改评分标准。

保存用户prompt、明确写边界、方法原件、before状态、全部raw stream、每条CLI命令/exit/stdout/stderr、真实RED/GREEN、宿主patch/新增test、独立验收、candidate hashes、失败和cleanup receipt。保留输入/原始before及各host成果后才删除自有运行目录；不碰历史1038/0e证据。只销毁本次自有认证临时资源，不宣称整个宿主进程树或global state已被完整审计。

## 能关闭什么，不能关闭什么

成功将补齐一个此前缺失的pstack实际使用单元：**方法读取→用户表面真实失败→代理实际修复→同输入同CLI GREEN→保留合法控制与证据**，对应PS01/PS08/PS13/PS20的D2a贡献和J03/J07/J09/J23的后续材料，但不签正式gate。比此前只读历史解释、合成PR分类或由协调者替模型执行driver更接近用户期望。

它不证明任意项目bug-fix、真实forge发布、跨宿主等价、因果生产率提升、原生发现完整性、trusted principal或自动激活。它也不会把已修复历史问题再计算为新的产品修复。项目级验证地图的全面漂移维护仍是另一项完整缺口。
