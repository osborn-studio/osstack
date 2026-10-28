# Skills check：来源检查失败不能报告成功

这是 verification 方法的一个真实 bug-fix 闭环，与 PR #288 的工具交付无合并依赖。实际基线运行所在 HEAD 为 `348aed70`，其 skills 产品源码与 main `fd9cac81` 相同。该基线的 `skills check` 在来源 ref 不存在时打印 `unreachable: no_matching_ref`，却因漂移计数为0退出0。调用脚本无法据退出码识别检查失败。

候选 `9a063b97a06dfb46fdb20f77a6e984b4206518e6` 分别统计失败与漂移：任何失败退出1，仅有漂移退出2，全部检查成功且无漂移退出0，空来源列表也保留0。未 bless 的来源仍按既有 watcher 逻辑计为漂移；退出1也可能表示既有CLI用法错误，调用方应结合诊断判断。原漂移汇总文字保留，另增失败汇总。

## 同一路径的真实验证

| 输入 | 基线 | 候选 | 验证结论 |
|---|---|---|---|
| 自有 file:// Git 仓库，不存在ref | no_matching_ref、退出0 | 同一ref与manifest字节、退出1 | 回归GREEN；来源检查仍如实失败 |
| 同仓库存在ref、blessed完全匹配 | up-to-date、退出0 | 同输入退出0 | 正控制通过 |
| 新的自有克隆新增真实提交、blessed仍为旧提交 | 未用于基线RED | 退出2、漂移1 | 漂移语义保留 |
| 真实漂移加不存在ref | 未用于基线RED | 退出1、失败1/漂移1 | 失败优先且两种信息保留 |
| 空列表 | 既有语义0 | 退出0 | 兼容性保留 |

所有运行均使用显式隔离 OSSTACK_HOME、Git 配置、file-only 协议，不访问默认配置或远端网络。源码和实际 dist 摘要在主复验前后核对，输入没有被改成成功场景。原始RED、候选GREEN、审计和摘要清单在交付归档中；这不依赖模型对正确性的投票。

12项定向测试包含缺ref、timeout、spawn失败、混合失败/漂移两种顺序、多个失败、仅漂移、健康与空列表，并断言不写manifest。两文件Biome检查通过。全仓与最终发布状态见 `delivery.json`，不能用本段代替最终head CI。

实际 Sonnet 5.5 对代码与测试给出 PASS；审计未执行命令，因此真实运行由独立保存的 argv/cwd/stdout/stderr/退出码/输入摘要提供。已检查CLI dispatcher直接传播返回码，未发现仓内按旧汇总全文解析的调用者；外部脚本应区分退出1与2。watcher 的 exit/close 尾部输出问题是既有非阻塞后续项，本PR不修改watcher。

这次修复不安装技能、不改变授权、数据库或J门槛。OSStack卡片 `card_02dd7ae1`；用户 gilberthello 审批合并。


## CI follow-up

The published head encountered two inherited native-upgrade test timeouts. [The follow-up](ci-followup/README.md) preserves the failure and separates real upgrade preparation from cleanup verification without removing assertions or changing production code. Candidate `4dddf67a` passed 37 focused and 7,138 workspace tests (5 skipped), CLI TypeScript and actual Sonnet 5.5 audit. Fresh published-head CI remains required.
