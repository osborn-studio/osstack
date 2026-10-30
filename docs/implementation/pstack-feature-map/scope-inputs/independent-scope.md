# W18 下一切片独立范围建议

状态：只读范围设计，未执行产品、模型或冷读实验；没有任何验收项记为通过。以下向量供下一批在接口确定后冻结，不是本批实现验收或完整 W18/W05/W09/A48 的完成声明。

## 原断言与可直接实施的边界

固定 Git：`147c59cfab63de7cb93d0445c63334a52f5c57a0`。原 integration-spec W18 要求先做 3–5 个主要用户场景：入口、前提、动作、可观察终点、恢复可找到；只加载相关叶子；跨入口覆盖明确；过期或缺前提不冒充通过。其依赖为 W06。建议文件路径并非强制产品 API。

建议先交付 **三个现有用户目的的索引、叶子及窄加载器**：①验证本地 skills 来源状态；②检查并维护这张验证地图的期望；③将已留存旅程转换为可分享的安全证据包并检查。复用既有 journey、map maintenance、projection 入口，叶子描述实际命令和前提，不新增驱动器、安装器、服务或事实账本。本轮只设计，不重复驱动这三项。它们构成可用的检索切片，但当前都是 CLI 使用路径，不能据此宣布 A35 跨表面集成通过。

如下一批同时交付 A35，必须另选一个确有两个用户入口、且有必要跨表面旅程的现存场景，作为第四个叶子或现有叶子的多入口扩展；先查真实入口和可观察结果，再定场景。不从两个 CLI 参数、命令别名或 CLI 内部调用 RPC 推断两个用户入口。现有 engineering-decision 功能页提供决策作用及幂等证据，但该页本身不能证明另一个独立用户 RPC 入口已被驱动。

原 A35 还关联 W05，A48 关联 W05/W09/W18。本次窄加载器可验证选择与纠正后的材料变化，不能冒称完整 recipe 路由、主机上下文派发或模型理解已完成。W19 的健康维护与调度不是本切片新增前提；也不能把 W18 尚缺的检索和跨入口能力转交 Firstmate 后视为完成。

## 五组可反证验收向量（均待执行）

| 组 | 输入与对照 | 必须观察的结果及证据 | 范围 |
|---|---|---|---|
| V1 正常检索与无关叶子 | 三个真实目的各有入口/前提/动作/终点/恢复；加入无关叶子，正文含能影响排名的诱饵 | 排名只取一级元数据；记录选择理由、所需叶子、未选范围。通过文件读取记录或注入读函数证明无关叶子正文未读，而非仅输出未显示。选中叶子原字节/身份可追溯；索引与正文矛盾不能把索引当事实权威 | W18 可交付检索主体；不是模型效果 |
| V2 必需与跨入口覆盖 | 一个旅程明确要求入口 E1、E2；只提供 E1 实际证据；正控制再提供两者各自入口/动作/终点证据。另设低排名但 required 的叶子 | E1 成功不得升级 E2；缺必需叶子或预算容不下时明确拒绝完整材料交付，保留缺项，不静默裁掉。选齐两叶子仅证明加载，真实跨入口完成还须各自驱动证据 | 离线关系检查可先完成；真实 A35 未覆盖前保持未验 |
| V3 过期、缺证据与漂移 | 分别改变 source_revision、driver_version、动作引用路径；提供历史运行但无当前对应证据；另有完全无 evidence 的新叶子 | 每种差异明确保留：漂移/待核验，缺证据为 draft；历史成功仍绑定历史版本。没有依据不得自动当新版本成功，也不必删除历史记录。引用不存在不得继续宣称可执行 | A36 与 §12.2；不是 blanket“任何仓库提交都使全部地图失效” |
| V4 缺前提与不适用 | 必需场景缺 data/auth/entitlement/runtime；正控制满足前提；另给未观测前提与声称非适用但无合同许可 | 已知缺前提为 blocked；未观测保留 unknown/缺口，不能算满足。排除非适用必须有明确合同依据，且不计通过；不能删功能、放宽谓词或调用其他环境翻绿。读地图不应自动执行命令或探查凭据 | A36；实际授权和前提观察由现有入口负责 |
| V5 任务纠正与最小材料 | 用户目标先选择“运行验证”，随后明确改为“检查已留存证据”，设置相关/无关方法与叶子 | 形成新的选择记录和材料身份，理由及遗漏可见；不执行旧目标，不抹旧证据；新任务所需验证不得因 top-k/预算静默省略。未知目标应返回缺口或澄清需要，不猜成成功 | A48 的 W18 部分；完整 W05/W09 路由另验 |

V2 的双入口 fixture 可验证算法不误报，但不能替代真实产品双入口运行。对于缺前提，允许受控离线输入验证状态转换，必须标注模拟；不要求为此访问真实账户、默认 DB 或重新做 C0 冷读。

## 既有代码与 schema 的约束

1. `integration-spec.md` §12.2 的 `FeatureJourneyV1` 包含 feature_id/user_outcome/source_revision/driver_version、带 surface 的 entries、分种类 preconditions、drive_refs、observations、recovery_refs、covered_entry_ids、known_gaps、last_live_evidence。它是地图内容结构，存在这些字段不等于已经验证；证据引用须经既有 resolver 校验才可用于说明场景。当前 Git 中该完整类型仍是设计文稿，不能把它说成已提供的公开运行时 API。
2. `method-materials.ts` 的 `MaterialFeatureMap` 是 strict 对象，仅有 schema_version、kind、entry、preconditions、actions、observable_end、recovery、owner。它不是上述完整叶子。文本有非空/UTF-8 16,384 字节上限，数组最多 128；owner 是 Ref，Ref 非空、最多 512、无前后空白/C0/DEL。不能给这个现有严格 body 偷加 revision、evidence 或 covered_entry_ids；也不能用一个字符串 owner 推断已经解决维护归属。
3. joint `ArtifactRequirements`/contract.schema 中的 `material:feature_map` 枚举只说明可要求该类 artifact，并绑定 producer/body_schema_digest/verifier_policy_digest/required；不等于实现了完整 FeatureJourney 或验证了 live evidence。第一切片可以把本地索引/叶子与既有材料投影分层，明确哪层可用、哪层未接线。若确需改变正式 body，应另行显式协议演进，不能本切片顺手放松 strict parser。
4. `searchKnowledgePacks` 当前对传入 packs 的所有 chunks 读取 title/body/tags 并打分，最后 top-k。可复用 BM25 做仅一级元数据的排序，但“直接把全部叶子 body 做 chunks 再搜索”不满足只读相关叶子。新增窄 loader 分两步：元数据选择 → 必需依赖闭包 → 有界读取选中叶子。required 集合不应由纯排名或裁剪决定。具体包装方式由实现者选，不能宣称现有通用搜索已自动满足该约束。
5. §4.6 对必要材料不可静默省略、身份/摘要和派发前核对的要求仍在。窄 loader 可以输出足够的选择记录供后续接线，但没有实际 host 接线不能签署该上下文派发边界通过；read delivery 亦不等于模型理解或 provider wire 证明。

## 真正要在实现前决定的三项，及不必阻塞的事项

- **真实跨入口目标**：若承诺本批 A35 完整验收，必须先找到并明确两个现有用户入口、必要连接及可观察终点；现有 fixed-five CLI 本身不足。团队可只读查源码选定，不需新用户批准。若暂时没有目标，可以先交付三场景检索切片，明确 A35 跨入口尚未覆盖，不能改原验收。
- **新鲜度与前提的事实输入**：选择哪些现有 source/driver/references/运行记录及 resolver 作为比较依据；哪些前提只能由调用者报告或尚未知。没有可靠输入时可以输出 draft/unknown/blocked，不能让 loader 凭文件存在认定运行通过。这是有限输入契约需要确定，不是要求新身份平台或外部认证 oracle。
- **叶子与协议材料的边界**：选择局部 authoring schema 与现有 strict material 的关系，并声明是否本批接入正式材料层。若仅本地 loader，不必改变 joint 协议；若承诺完整 material 注入，现有 body 的表达差异必须先解决，不能静默丢字段。

可自行决定：三级以内目录与文件名、先选哪三个现有 CLI 用户目的、索引关键词、稳定排序、具体函数/CLI 名、局部 closed-schema 校验与路径/大小上限、测试读函数 seam。重复 ID、悬空引用、路径越界、预算超限的失败关闭是建议实现保护，可在下批具体接口冻结时形成负例；不冒称原文规定了某个错误码或 API。无需新增调度、长期 watcher、Firstmate 深运行、全部 58 技能导入或通用读文件安全平台。

## 来源与本次操作界限

只读取固定 Git 对象；未检验未来作者实现，未创建工作树，未运行产品或模型。以下 SHA-256 绑定实际读取的 Git 文件字节。文件哈希是来源一致性证据，不是产品验收或可信 principal 认证。

| Git 路径 | SHA-256 |
|---|---|
| `docs/reports/2026-10-26-pstack/integration-spec.md` | `e2c293dce90793ebcaf360751920050facb71dfd86660f48333415d8ff40ace5` |
| `docs/reports/2026-10-26-pstack/acceptance-cases.json` | `ea6555865ac1478c6ebd10157b7b0f350827d4adba02aba680d65c32a112a25d` |
| `packages/protocol/src/method-materials.ts` | `9e4e8087bff123ab331b0fc91dc6f6413edaf30c7d051551d0bac2142ea9796b` |
| `packages/protocol/src/joint-primitives.ts` | `d0eeb917ea6ef91ed39943706ab78c9be84dc81ba89303f5e98d01cf89adc139` |
| `packages/protocol/src/joint-shapes.ts` | `8056649a4f5a6b6f3e75d188da8cf342fc01ccc2bfe5fa5ff7d718582e5a052b` |
| `docs/design/2026-10-27-joint-engineering/contract.schema.json` | `582af5adede90c8756c3d5b1a0da9baa1782afb19922d5dc85c5396ab1dff534` |
| `packages/knowledge/src/pack.ts` | `e15d79a049e98ece387bfd96f0531caf5e7ca6da52224df7fc73ed43d9ca2a82` |
| `osstack-methods-skill/references/skills-check-journey.md` | `394656665165d6386fd1f4291506e6e28aa142a948d6180a4ef1f038bfb6ce1b` |
| `docs/implementation/verification-kit/feature-map.md` | `1f327f006df35080d9c483fa540b3fcf979fba4aba862f3159c3339cab4699e6` |

记录时间（UTC）：2026-10-30T05:42:44.677610+00:00
