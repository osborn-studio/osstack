**总判断**：六项修正基本成立。首轮三处应撤回：fork先行、"OStag/osbot不得自带执行"、"凭据只存电脑checkpoint"。逐项给最强反例后定边界。

**挑战1 同意，但边界要按能力而非目录定义。** 反例一：osbot在scratch目录跑Python，却用缓存的git凭据clone私有仓并push，或脚本直连生产API，"临时目录"什么都没拦住。反例二：OStag用kimi_cli做summarize，CLI默认带文件和shell工具，本质仍是代码执行。修订：工程动作专属OSStack的判据是三项能力——受管仓库写凭据、受管仓库挂载、绕过broker的发布通路；osbot实例三者皆无，只读研究靠"无写凭据"保证，不靠prompt；OStag保留的非coding backend必须是无工具的纯推理调用，带工具的CLI backend只能走delegate。

**挑战2 同意降级，撤回fork先行。** 我没有源码证据。"固定upstream SHA/镜像+窄connector"应为默认路线。唯一可能推翻它的事实是：把OSStack作为bot可调用的执行provider，取决于Rakazo能否不改代码注册自定义工具或MCP server。这是下阶段第一个要核实的点，方式是读源码，不是部署。不写"冒烟已做"。

**挑战3 同意，我错了。** 补一个反例：浏览器state是不可分级的bearer凭据，cookie做不了scoped grant，登录即等于该账号全部权限。规则：公司bot浏览器只用专用受限服务账号登录，永不用人的账号；个人实例不得持有任何带公司scope的凭据，包括个人GitHub账号里的公司仓权限；模型key按实例分开，避免账单和日志混流。同机共享hostadmin故障域照实写进说明。

**挑战4 同意，加两条。** 反例一：inputDigest若含时间戳或trace id，重试时digest变化，dedup失效，重复执行。要求digest只覆盖规范化后的意图字段。反例二：osbot重试mission时换新mission id，child key跟着变。要求owner重试必须复用id，且OSStack提供按effectKey查job的接口。禁环：OSStack只回结果，永不反向向OStag或osbot发起任务；树深度上限写死。

**挑战5 同意，加并发策略。** 反例：schedule被编辑或时区变化导致occurrence id重算，在途child成孤儿；或上一occurrence的child没跑完，下一个又起。要求occurrence id含routine版本，编辑视为新routine；每个routine声明skip/queue/cancel之一；routine触发的授权是预授的带expiry grant，不能每次现批。

**挑战6 同意，明确一个例外。** "不再问一遍"只对in-scope成立。反例：审批说修repo X，执行中发现要碰repo Y或跑deploy。OSStack不能本地弹窗问人，也不能默默扩权，只能失败并回OStag开新receipt。公司bot的写能力用凭据缺席加出网allowlist来禁，不靠prompt。

**修订最终边界**

- **OSStack**：受管仓库内的候选版本、验证、交付执行、资源租约、代码动作账本，持执行时准入与本地grant；是唯一持仓库写凭据的系统。
- **OStag**：组织内人与agent的协作与工作流治理入口，持receipt状态机、actor/channel policy、连接器、followup；是公司SoR写入与组织审批的唯一authority。
- **osbot**：自有服务器上的持续身份数字同事，复用固定版本Rakazo，持记忆、routine、工作电脑与浏览器身份；公司实例首版仅只读研究、报表草稿、编码委托。
- **铁律**：一个domain一个owner，不共享库；跨系统只传scope ref和签名事件；所有delegation带expiry与scope check；scope不足回发起方开新单，不现场问人；托管本地不等于推理本地，也不等于零外发。

**下阶段验收，仅文档**：一，Rakazo自定义工具/MCP注册点核实结论，据此决定fork与否；二，所有权矩阵零重复owner；三，effectKey规范化spec，和一条飞书到OStag到OSStack再回执的场景，标出全部交接点；四，三类凭据各自的最小范围清单。
