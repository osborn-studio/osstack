结论：无颠覆性矛盾，但有 3 处真实边界冲突需各定一句，另有 1 处定义缺口。

**1. 合并到 main 的归属未定（最重大）。** OSStack 持受管仓库写凭据并拥有"候选修改+质量验收"，OStag 用 `github.approve(head_sha)` 加 `vercel.deploy_production` 拥有发布。若 OSStack 自己合并到 main，而 main 又触发 Vercel production（Vercel 默认行为），OSStack 事实上成了发布者，OStag receipt 被绕过；若把合并算作发布，则"OSStack 唯一拥有候选修改"必须收窄到分支/PR，且 OStag 需要合并权限。两条现有表述同时成立时互相打架，必须明确"合并是工程动作还是发布动作"及 main 是否自动部署。

**2. 浏览器 cookie 与出网控制的防绕过前提自相矛盾。** 防线声明"靠无受管 repo 写 credential/mount/发布通路与出网控制"，但凭据三分类里浏览器 cookie 是独立类，且 Rakazo 现状是 per-bot 独立 profile。公司 OSBot 实例若浏览器登录了 GitHub/Vercel，等价于一条不经 key 的写通路；同时公司 OSBot 首版做 Web 研究，出网不可能全封，只能是 allowlist。目前文本没说公司实例浏览器身份禁止登录受管仓库/发布平台，这条不补则防线不闭合。

**3. needs_authorization 路由分类不完备。** 现分两路："来源 OStag 走组织 receipt"、"来源个人 CLI/OSBot 走已有授权交互"。公司 OSBot 实例两边都不落：它没有"个人授权交互"，而"工程委托"链 OStag case→OSBot mission→OSStack job 中发起方是 OSBot，OSStack 回传给 OSBot 后若 OSBot 自行应答即等于公司实例自授权。需一句：公司 OSBot 实例收到 needs_authorization 只能转发到所属 OStag receipt，不得自答。

**4. 幂等定义缺一句（缺口非矛盾）。** key 冻结为 scope/parent+child+occurrence，digest 只含业务字段，scheduleRevision 冻结旧 occurrence。编辑后若旧 occurrence 被重发，会出现 key 相同、digest 不同的情况，当前未定是拒绝还是复用。与"不能随编辑重算"直接相关，建议定为拒绝并记账。

其余核对结果一致：OStag 现有发布 executor 已属受控 executor 路径，与"非 coding backend 保留纯推理/只读工具"不冲突；overlap skip_busy 与"未知先查不重发"可闭合；"OSStack 不反向发起业务 mission"与 Loop 内部自生工程任务不冲突；三域状态各自 owner、单一提交者、同机 hostadmin 共有故障域均为已如实声明的边界，无需改动。
