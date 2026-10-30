# 首批修复材料的实际采用

本批在OSStack基线 `dd63b1c5` 上，实际读取固定Git对象并修改五份授权材料。目标是让现有单张看板卡，通过现有Loop/deliver修复一个当前缺陷，把真实证据关联回同一卡。材料可由当前host显式读入；本批没有运行产品、模型、上游脚本或DB，没有证明该任务链已自动接通。

## 精确范围与实际变化

固定来源是cursor/plugins的pstack **0.15.36**，commit `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`，子目录 `pstack`。实际核对plugin.json版本与LICENSE：**Lauren Tan（poteto），MIT，Copyright (c) 2026 Lauren Tan**。这里独立表达采用方法，不复制整段技能，不安装上游工具。

| OSStack材料 | 之前已有 | 本批实际增加/修正 |
| --- | --- | --- |
| bug-fix.md | 复现、机制、最小修复、条件式回归测试、同surface复验 | 路径与历史分开；选最能排除假设的实验；先确认机制再扩设计；跨边界调用草图；同卡/Task/注册检查/host证据；TDD不值得时保留真实替代检查 |
| investigation.md | 只读、有引用、事实/推断/未知 | how式触发/数据流/所有权；why式动机证据分层；矛盾记录与未读来源；已有调查后修复授权持续有效 |
| code-review.md | 路径分析、实际复现或静态论证、finding处置 | 新Interrogate的run-verified finding必须有命令、实际/期望输出；静态concerns单列not run；旧candidate不升级；同卡处置且不自动merge |
| evidence.md | 执行/行为/harness/清理/覆盖分开，原件保留 | doctor与异常恢复；工具修复必须fresh re-drive；同卡/task/run/method/check/receipt关联；投影失败不重跑模型 |
| sources.md | 0.15.32与Firstmate历史归属 | 新增精确0.15.36选择范围与来源；旧pin保留；不把14方法目录改称整包0.15.36 |

新Interrogate已无旧rubric.md、lead-judgment.md、code-quality-review.md。实际读旧rubric路径得到Git exit128（路径不存在）；改读新入口及arena依赖，明确OSStack适配差异。其他两个旧引用的不存在由树列表核对。旧链接保持0.15.32归属，不能简单换pin。

## 实际读取的固定来源对象

此表是已读留存集合，不代表全部递归依赖或全部功能已采用。blob是Git对象标识；SHA256是原始文件bytes；两者不互换。

| 仓库路径 | Git blob | SHA256 | bytes |
| --- | --- | --- | ---: |
| `pstack/LICENSE` | `6b5400237fdf6545be0b8fae370d6f2fcff8fb25` | `bc957ca6bee02792566a1a028d105e02e247c6e77cf057061674273da77b200e` | 1067 |
| `pstack/plugin.json` | `14b42b7225231a2f01ab225df1d9d13839c6d616` | `ebc3ee08ceff88b13521cabd714d92b972fbe9c5b77116f94872ee848b225b31` | 619 |
| `pstack/skills/arena/SKILL.md` | `7580c3c9a7770d81b9dd7a537d9caa7362c04279` | `d0adeca6c9b19d43d90ed8f0484f0ddd362f05006d628b8f4cc6c9b55fa4d2b3` | 5598 |
| `pstack/skills/create-verification-skill/SKILL.md` | `140d033a001e8d27acd14b06004506c43053b199` | `d353973547bf8ad8977eca645f4cd4feaed0d32f4b43d1448f906b0a76c4d694` | 6533 |
| `pstack/skills/how/SKILL.md` | `67edc340d4d8a9c7ab0b9e08c663e0e63b8d9125` | `08a00079bb15b4258874ac3ff62d4ca7e94350ffedb521d0fd296dc9dd21904e` | 2651 |
| `pstack/skills/interrogate/SKILL.md` | `169f5b478f4cb53a4c5ab6046576034b4b07cfe8` | `3f3c2e9b8cf6b180dba9f32a4aff85e5691b09805232468e37a0ba45437a9984` | 2314 |
| `pstack/skills/maintain-verification-skill/SKILL.md` | `a2680b91fead45a0b4963d8c367a854956bea59d` | `515c0eaa054b3f6be1b1fb06f2c2f173c80fddb58bbcac57576f89c479bc68e8` | 4922 |
| `pstack/skills/poteto-mode/playbooks/bug-fix.md` | `b5de0bfa63add6ed38a38a8bd668cf36ac009c61` | `66e26542dad131cfd7df80ac0cdf81ed4d85e7b5e3f0eb65b933888760c4831f` | 2359 |
| `pstack/skills/poteto-mode/playbooks/investigation.md` | `cd119f04f23e0b7acb3f8cc5ba13ce4ab7aa6c7d` | `dc66bcf6af3a074fc7f67aa5e12b93ef571a4fb4d8e17f2f1af5ae5359f42e46` | 928 |
| `pstack/skills/principle-prove-it-works/SKILL.md` | `5dc14a3b06f9d579e5c17cd8a7242f432ddb3125` | `ec79a15025bac8d33d62011c54f3b612733fd2a024e623b531b3637aa75070e2` | 1371 |
| `pstack/skills/principle-sequence-verifiable-units/SKILL.md` | `986371260ebccd9a5a6818c9561e88c1d270d0ee` | `2ccbbacc56ace5afdfb8670cef19d7bd009fb2a0033b9a741cbdf2b6baf72187` | 1705 |
| `pstack/skills/principle-test-behavior-not-implementation/SKILL.md` | `78c9389bfe707d6d56485ade32c59150958228f9` | `f7223698623b6a26fea49c751e466b38e6691b1f32ce841d3983e7ffbe2b74a6` | 2614 |
| `pstack/skills/tdd/SKILL.md` | `ca6f24c963001d9d518db2936dfe3d12f29b4e94` | `eeb868e2dfebee528d730a67d7b17498fac4bb85dec2e38bc5c5176aca4d5d2f` | 3143 |
| `pstack/skills/why/SKILL.md` | `b5fe93f8b78f58b06e0bf245a6b5b8faae4300e8` | `144d42e7712723d763e607bc0a969e5f1cdf83ec7228519d87677cc534571bed` | 8903 |
| `pstack/skills/how/references/explainer-prompt.md` | `3a36fb6736c5b74ac2774350841e332a019dec94` | `ddb89cebefc24e2b54517a331aedfe045b6971e101f45c71b8cef4cccff45bff` | 3085 |
| `pstack/skills/how/references/explorer-prompt.md` | `724bacfc7df759865c0c29705bfee641e4c1aeca` | `6300128385ee940fd42ecb84b0e623435440a2dc283eae54ee4a52ba56947ba1` | 1135 |
| `pstack/skills/why/references/epistemics.md` | `b18abf41dfa245ee55e94f1b3a80c0b750eb10cf` | `d54a2361b2d5973bc3fe2edf62f446d87935974d4b40d47f23b9529f956ca758` | 6736 |

读取方式是本地裸库 `git show <commit>:<path>`，没有执行上游。原始bytes、source-components.json与前后材料绑定留在指定scratch `pstack-adoption-bundle-20261030/materials/`。首次旧引用失败保留于映射的failed_old_reference_probe。这是读取失败，不是产品bug。

建议来源组件声明区分：adopted_guidance（bug-fix/investigation、tdd、interrogate、test-behavior、prove-it-works、sequence-verifiable-units、create/maintain-verification，以及how参考结构和why epistemics）；context_only（how/why的平台编排、arena）；identity_license（plugin.json/LICENSE）。每项保存repo/commit/subdir/path/blob/SHA256/bytes、采用用途与排除部分。此为schema建议，不是已实现API。仅repo/subdir/version的manifest不能声称表达了逐材料采用关系。

## 依赖和排除部分

| 上游引用/机制 | 本批处理 |
| --- | --- |
| bug-fix中的how/why/tdd/sequence | 已读列出的原件；采用路径、历史、条件式TDD与可复验顺序，不自动重排Git历史 |
| architect、Opening a PR、poteto-mode运行规则 | 不递归迁入；跨边界写调用草图，现有OSStack架构与发布权限控制动作；不称这些入口完成.36采用 |
| investigation的unslop | 不作运行依赖；用仓库prompt-language规范表达；未读/运行，不称等价移植 |
| how两参考prompt | 已读；取解释结构和边界，不采用固定模型、Task参数和人数 |
| why epistemics | 已读；其他source-playbook、服务prompt、MCP七类并行未递归采用；不因此获得连接器或外部访问权限 |
| interrogate引用arena A/B/F | 读arena入口来辨清依赖；取复验思路，不采用模型/候选调度、跨family judge或后台默认 |
| create-verification引用feature-map-example | 不生成新技能/地图，不复制模板；只取doctor、真实路径/副作用、隔离与证据存活；W18资格边界不变 |
| show-me-your-work、build-the-lever | 不递归引入；保留产物实查与可重放证据；不自动提交全部原始数据 |
| maintain-verification的周期、每feature子代理、PR | 不自动周期/通知、不强制并发；维护地图不授权修改产品，真实bugfix按独立任务授权执行 |

默认模型、云、Grok配置、Cursor slash/规则、自动PR/merge、Firstmate深运行均不采用。最多3本地槽、人类merge约束保持。14命名方法数不变，其他旧pin材料不迁移，不抹去历史成绩。若再分发完整上游源码，保留MIT全文；本批独立表达不是整包官方适配。

## 当前首用调用草图

选当前真实卡，记录明确card/board/repository/task ID、触发、期望、允许路径和注册检查。让当前host显式读bug-fix与evidence；需要时再读investigation/code-review。读文件现在可做；无需新scheduler；卡body不是命令注册或授权。

以下参数已从 `packages/cli/src/deliver-command.ts` 核对，**本轮未执行**。这是调用形状，变量须来自实际任务及已配置host。执行会运行agent与检查、创建候选状态；仅在授权与隔离就绪后调用。

```sh
OSSTACK_HOME="$TASK_HOME" OSSTACK_SCRATCH_ROOT="$TASK_SCRATCH" node packages/cli/dist/bin.js deliver "$TASK_GOAL" --workspace "$TASK_REPO" --autonomy guarded-local --contract "$TASK_CONTRACT" --profile "$TASK_PROFILE" --execution-context "$TASK_CONTEXT" --json
```

前提：从匹配构建的OSStack checkout调用；TASK_HOME是显式自有、非默认/保留home，scratch为自有绝对目录；目标repo为Git工作树；V2合同为当前base/head、task、goal、policy与budget匹配的implement合同，completion为local_verified；profile/角色可用；context文件通过现schema；host policy已注册实际复现/回归检查。不从卡body拼shell，不虚构contract JSON，不用V2不允许的--execute绕过adapter。

V2检查命令来自host policy，额外--verify不在集合内会拒绝。CLI错误/blocked不是产品行为RED，保留错误code与原始输出。exit0仍不足，核host receipt、最终candidate和required checks。local_verified不含merge或发布。

现有内部接口：deliver的enqueueTask→LoopEngine；V2本地路径用inputTasks与sources:[]限定任务；prepareVerification、verificationFence、guardedLocalCandidate.inspect；buildDeliveryVerificationReceipt/persistDeliveryHostRecord/verifyPersistedDeliveryReceipt。这些已存在，不是本文新增API。

**仍未接通：**自动从指定board/card编译V2合同；mandatory方法注入及绑定核验；卡期望到registered checks映射；最终receipt幂等投影回原卡。--execution-context不意味着已支持新方法字段，不自行添加未定义字段。KanbanRepository已有getCard/progress/patchCard/moveCard可复用，但必须核board/tenant，不能只取最近同task卡。自动接线前可通过已有授权看板界面人工关联证据，明确这是人工步骤。

同一卡分别显示：原始失败、最小补丁、同入口通过与邻近控制、host最终候选核验、证据回写成功/未同步。先保留收据再回写；失败只处理投影，不重跑模型，不直接标完成。缺真实缺陷/合法检查/隔离则阻塞，不回放旧packet/W19/已关闭问题冒充首用。

## 验证边界

本批完成Git对象读取、材料实改及静态参数/路径/归属核对。没有执行deliver、打开DB、建卡、安装激活或证明host收到材料。下一验收需当前真实卡的RED→修复→同入口GREEN和host收据；材料校对不能替代实际结果。bundle作者应绑定实际材料hash，本文件不发资格凭证。
