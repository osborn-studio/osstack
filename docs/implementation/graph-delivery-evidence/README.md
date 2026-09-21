# G21 验收证据

最终源 SHA 与准入结论见 [admission.json](admission.json)。原始日志/模型返回保留原字节；.gitattributes 只对本证据目录的原始文本关闭空白诊断，不豁免源码/计划检查。未保存数据库、socket、实际候选目录或任何密钥。

- acceptance-result.json / acceptance-2-STATE.md：真实 OSStack Loop 最终 1 executed、0 skipped、success，6 个 verifier exit 0。
- accepted-full-tests.txt：22 包、3201 passed。build.txt / biome.txt：构建与 18 个改动 TS 文件检查。
- worker-delivery-proof.json：最终验收临时 SQLite 的只读观察，6 条真实交付路径；不代表任意 daemon crash 恢复。
- renewal-proof.txt：真实 worker/G04 的续租窗口压缩测试，最终全库也执行了此场景。
- retry-admission-red.txt → adversarial-green.txt：Claude 指出的重试路由/终态矛盾的真实失败与修复回归；最终全库异常套件为 9 项。
- claude-design/implementation-response.json：两轮真实 Fable 5.1 审查；claude-final-response.json 为额度错误，不能算通过。
- codex-final-review.md：真实 Loop 中的独立 Codex 只读审查 PASS；它没有运行测试。review-adjudication.md 记录建议采纳/反驳和证据限制。
- G21-implementation-*：真实 Loop 编码任务；actor 的 diff-only gate 不作为最终验收。r3/r4 为 actor 定向 Loop 验证，最终验收另列。

首次全库验收已通过 3196 项；随后补齐额外反例并用最终全库 3201 项替代准入。源快照中的测试文件在第二次 Loop 启动后补入续租场景，但最终全库明确执行了最终 9 项异常测试，随后全库 typecheck 通过；生产源码未在第二次验收中变更。
