# 实际历史 packet 修复：独立验收

**Codex完成了这一个历史缺陷的实际修复闭环；Claude本次因其批量命令形式被权限规则拒绝而停止，未完成修复。** 两个launcher exit0不能合并成“两宿主通过”。

Codex实际工具流先执行原CLI（incident错误valid/exit0、两control合法exit0），新增真实回归后在原源码得到2通过/1失败，再仅修改not_run条件，原输入/同CLI变为拒绝exit1，回归3通过/0失败。测试字节RED/GREEN一致，所有八条helper记录都保留。独立协调者另在副本执行旧/新源码回归及九个原始/隐藏检查，共11命令；合法unknown/not_run仍接受，换位/false去除声明及中性路径矛盾拒绝，损坏hash拒绝。它们是独立复验，不冒称模型执行。

完整前后/当前inventory显示Codex只修改checker、新测试和results，六个原输入及helpers/方法原字节不变。event8显式读取的mode/bug-fix/evidence全文与文件一致。三个assistant消息均已审阅；“native unavailable”只是自报，当前只能确认没有native调用，不能确认宿主不支持。resolved模型未暴露，保留not_attested。

Claude实际native Skill加载osstack-mode。Bash读取参考文件的raw stdout完整，但对应模型消息是约2KB persisted-output预览，无后续完整读取事件；不能据工具读到全文推断模型已收到/理解全文。它随后以for/echo包裹多个helper的Bash请求被拒绝，未尝试已允许的单条helper；没有产品执行、测试、源码编辑，results为空。最终如实说明未完成。结论是本次命令形式/权限表面阻塞，不能扩张为helper不可用或模型无法修复。

两个调用均1turn/0retry、600秒内结束，Claude原始modelUsage报告sonnet5.5；Codex仅请求模型可见。宿主采用不同权限表面，本次结果不能用于模型优劣、方法因果收益或通用修复能力比较。产品命令只用清环境helper，Codex测试继承的process.env是该最小产品环境；最终分析读取的是本任务记录，没有观察到live host环境/凭据读取。没有OS级读/网络围栏证明。

原H06预检错误和首次Claude读取判定失败均保留，未改旧标准翻绿。所有formal gate为未签发；这是已修历史缺陷的隔离执行证据，不是新生产修复。工作区尚保留，清理另由owner授权并出新回执。
