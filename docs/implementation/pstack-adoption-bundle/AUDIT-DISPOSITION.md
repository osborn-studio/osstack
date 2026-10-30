# 静态审计与限定修订处置

本批实际 Claude CLI reported `claude-sonnet-5-5` 首审为 PASS_WITH_CONCERNS。输入、原响应、用量与绑定完整保留；tool-less 静态读源码不是实际 host 使用、独立 provider 身份认证或产品资格。

| 意见 | 处置与证据 |
| --- | --- |
| D1 跨材料同来源路径矛盾 hash | 采纳。同新增断言旧16pass/1fail；跨 binding Map 拒绝 provenance_source_conflict，新115 exporter/provenance全部通过。 |
| D2 来源角色含糊 | 采纳。闭合 role 枚举 adopted_guidance/context_only/identity_license；arena为context_only，plugin/LICENSE为identity_license；缺失/未知role拒绝。 |
| D3 canonical五份材料无防回归 | 采纳。新增精确五份文件、固定版本/commit/candidate digest和当前bytes回归。 |
| D4 版本未标调用方声明 | 采纳。candidate输出package_version_identity:caller_asserted；旧候选保留，修订后digest重新绑定。plugin另有Git原件，不伪装纳入组件闭包。 |
| D5 错误无路径/预算魔数 | 采纳。material_missing/material_drift附路径；boundedRead显式limitLabel，增长读取同类预算拒绝。 |
| D6 dry-run/实际receipt不一致 | 采纳。实际导出返回同manifest provenance摘要，有实际写出回归。 |
| D7 duplicate JSON key边界隐藏 | 采纳公开说明。仍JSON.parse last-wins，在manifest limitation与EXPORT.md明确；不声称已拒绝重复key。 |
| R1 canonical输出膨胀未分类 | 经独立旧版复现确认。仅输出序列化超额映射RESOURCE_LIMIT，不提高预算；旧35test中2fail，新35pass。 |
| R2 nested组件未覆盖 | 新增共享文件合法去重及膨胀拒绝控制；允许有意重叠，未改为禁止嵌套。 |
| R3 跨组件大小写路径冲突 | 旧策略已FILE_CONFLICT拒绝，独立控制保留；新增回归，非新修复。 |
| R4 legacy provenance保留名 | 有意新增声明保留名；没有该文件的legacy路径保持，未知同名声明拒绝。新bundle根多provenance有文档，不保证外部未声明消费者。 |
| R5 repo/version输入宽松 | 保留通用inspector兼容，身份/版本明确caller_asserted；API无网络/认证/执行。真实本批只固定公开https仓库。未声称输入等认证。 |
| R6 Zod解析大数组 | in-process调用方资源限制仍存在；输出/声明配置预算不等OS内存围栏，未扩大本批接口。 |
| R7 跨候选/来源证据仅手工 | root执行final-provenance-proof.json：逐binding与候选SHA核对，plugin独立身份原件；独立真实Git重读与两布局导出另列。 |

旧candidate `fcdbd6132ae716be4b1723d4b91bf7b5b7e41050a66c39164a395d6a466fca8b` 保留。修订candidate `699ffdbbdd848f4e55dc0f7466d6bf21807b87306f2ff45ee436dc26ab26d7d3` 来自相同保留inspection重组，非又一次Git读取。候选只验证声明闭包，非自动语义依赖发现、正式SourceSnapshot或真实host送达。

full通过绑定2389dcd9修订前代码，不重标新版本；Node26 transform兼容失败及首次Node22原生ABI不匹配/重建步骤完整保留。限定复审只评估上述修订与声明边界；后续记录其实际结论。

实际限定复审结论PASS，明确只静态检查修订存在且一致；未确认测试执行、Node环境、host行为或来源真实性。R1模块未见/R7脚本未见/plugin单独读取和版本措辞建议保留。独立实际6向量及root逐对象proof提供各自范围的实测证据，不把静态意见升级为运行证明。
