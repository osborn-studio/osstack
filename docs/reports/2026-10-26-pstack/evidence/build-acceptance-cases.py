from pathlib import Path
import json
r=Path(__file__).resolve().parent.parent
rows=[
('A01','W01','旧 manifest 兼容','manifest 没有 subdir，来源为合法 Git URL。','读取，再按默认规范表示。','subdir 为 .；其他旧字段语义不变。','unit'),
('A02','W01,W02','来源路径与身份拒绝','subdir/path 含 ../、绝对路径、反斜杠、控制字符，或 commit 为 not-a-commit。','解析与构建快照。','拒绝；不读取快照根外文件，不把任意字符串当 Git 身份。','negative'),
('A03','W02','确定性且无执行的快照','同一固定 Git tree 两次构建，checkout 含额外未跟踪文件和上游 install script。','离线读取 blobs。','摘要一致；未跟踪文件不进入快照，脚本不执行。','unit'),
('A04','W02','来源更新不自动激活','active 固定旧 commit；远端 ref 变化，包括仅其他插件变化。','运行显式来源检查。','相关子树变更产生 candidate；无自动安装/active 更新；无关变化可标无方法内容变化。','integration'),
('A05','W03,W09','纯编译与 recipe 区分','已审查 candidate recipe、固定输入和 check catalog；分别选择四类 intent。','多次离线编译。','同输入同 digest；不同 recipe 的材料要求不同；candidate 输出不能直接运行。','unit'),
('A06','W03','拒绝未知检查与命令注入','recipe 指定不存在的 check；引用文字含 shell 命令。','解析编译输入与 registry 映射。','未知 check 拒绝；引用文字不被当命令执行；未知字段失败。','negative'),
('A07','W03','宿主兼容性','required feature 不可用；另一个样例仅 optional feature 不可用。','编译/兼容性检查。','前者 unsupported；后者显式记录降级；required 不能改 optional。','unit'),
('A08','W04,W09','禁止权限扩张','已有合同只允许范围内 build/verify，proposal 请求额外路径或 merge。','admission。','拒绝，不写新授权，不调用外部服务。','negative'),
('A09','W04','冻结之前完成检查绑定','合法 proposal 与主机 check registry；另设冻结后更改 checks 的样例。','构造合同并 freeze，再尝试改写。','合法身份一致；冻结后变更必须新 proposal/contract，旧记录不覆盖。','integration'),
('A10','W04','Graph 既有边界','17 个 required checks、超主机命令字节预算，或 requested_completion=merged。','现有 Graph contract host admission。','按现有边界失败，不拼接多个 shell 绕过限制，不修改 frozen v4。','negative'),
('A11','W05','必需上下文不能被静默裁剪','小上下文预算使必需方法 artifact 未被 assembly 选中。','通过真实 wrapper 走 invoke 前 fence。','METHOD_CONTEXT_OMITTED；adapter invoke 计数为零；保留失败原因。','integration'),
('A12','W05','真实 adapter 输入与来源信任','包含诱导越权文字的 upstream reference；测试 adapter 捕获真实 task。','组装、调用、收集 prepared/adapter_observed。','原文为 untrusted data；摘要对应实际 task；不声称 provider wire/model compliance。','integration'),
('A13','W06','空环境真实表面验证','空 fixture、独立 OSSTACK_HOME、scratch API 分配的工作区。','运行注册 CLI/RPC 场景并检查实际最终状态。','通过指定行为谓词，而非只检查退出零/--help；不碰默认控制面 DB。','live-local'),
('A14','W06','失败与资源清理','场景启动后失败、产生证据，并有无关进程/目录。','执行 cleanup。','只清理自己拥有资源；无关资源不变；失败证据存留且不会标通过。','integration'),
('A15','W07','旧候选证据失效','head/base/env/check/contract 任一身份变化，patch-id 可以保持相同。','验证 receipt。','旧证据不能用于新候选；重新验证或报 stale。','negative'),
('A16','W07','worker 不能伪造 verifier','先有可信 failed，再提交 worker 自报 pass、伪造 verifier 字符串或缺失 artifact。','主机消费证据并 join。','不覆盖可信裁决；拒绝不可信证据；仅写出字符串不产生批准。','negative'),
('A17','W07','逐条 review disposition','blocking finding 未处理或 dismissed 没有证据。','评审结案检查。','不产生 approved；记录未解决发现；多数赞成不能消除阻塞事实。','unit'),
('A18','W08','端到端能力接入','单仓库 fixture，active bug-fix recipe，已授权 local_verified。','proposal→admission→真实执行→freeze→review/tests→join。','结果绑定当前候选与方法版本；独立验证通过；无 push/PR/merge。','live-local'),
('A19','W08','默认关闭与性能兼容','配置缺失或 enabled=false；对照已有 CLI 启动基线。','运行既有任务与启动基准。','旧路径保持；--version/--help 不突破仓库预算；无新常驻服务。','integration'),
('A20','W09','调查不假装交付','investigation recipe 生成报告后，尝试绑定当前 Graph implement host。','离线编译后尝试执行 admission。','调查材料可用；不支持的 scout 路径明确拒绝；不返回代码已交付。','negative'),
('A21','W10','决策记录追加纠错','存在一条事实错误的旧 decision；新增 supersedes。','导出并读取记录。','旧记录保留、更正可追踪；导出文件编辑不改变权威状态。','unit'),
('A22','W10','恢复与停止未知状态','进程重启，原 recipe 不再 active，外部效果/取消状态尚未知。','按原 run identity 对账。','保留旧 pin；未知不作完成或盲目重试；缺停止证明不称 cancelled。','integration'),
('A23','W11','验证漂移分类','同一 feature 分别出现文档过时、harness 不支持、产品真实回归。','资格维护流程。','正确区分原因；不得删除 feature 或降低 predicate 自动晋升。','integration'),
('A24','W11','升级隔离与回退','新 candidate 测试失败；旧 active 有运行中任务。','资格检查/回退。','新版本不 active；旧 run 继续绑定原记录；隔离停止新任务而非伪称旧任务已停。','integration'),
('A25','W12','覆盖缺口与竞赛规则','coverage 中一个必需 lane 缺失；race 的规则事先冻结。','聚合结果，尝试事后切换选胜规则。','缺口明确且阻止覆盖完成；竞赛不事后改变规则来接受结果。','unit'),
('A26','W12','候选合成重新验证','两个隔离候选各有通过证据，合成一个新 artifact。','选择并合成。','新 artifact 有新身份；不能沿用任一旧通过结果；必需重新验证。','unit'),
('A27','W13','watcher 阻塞与未知语义','checks passed + BLOCKED/REVIEW_REQUIRED；或 UNKNOWN mergeability。','纯 observation classifier。','只输出阻塞/不确定观察，绝不产出 merge permit。','negative'),
('A28','W13','forge 不完整读回','API 超时、分页缺失、部分检查不可见或 readback 失败。','读取并分类。','unknown 原因和 freshness 可见；没有 merge/push 调用。','negative'),
('A29','W14','历史教训晋升','重复失败有历史坏例与正常对照；模型建议修改全局 rule。','生成 improvement draft 与回放检查。','检查抓坏例且不过度误伤；draft 不自动成为策略；保留评价版本。','integration'),
('A30','W15','评测公平性与预算','固定任务/模型/预算、盲化标签；混入失败样本和不等价基线；预算耗尽。','执行有限试点与结果汇总。','失败不从分母删除；拒绝不等价比例；预算耗尽停止；gate 改变用新 epoch。','experiment'),
('A31','W16','形式化敏感性与边界','单个不变量、代码映射、完整 checker 环境、故意破坏的不变量变体。','运行模型与坏变体，再尝试代码反例重放。','正常模型结果带边界；坏变体被发现；超时为 unknown；图不冒充证明。','formal-pilot'),
('A32','W16','事件幂等与部分成功补偿','fake connector 中同事件重复，外部对象已创建但回信失败。','重放 intake 并查询外部事实。','不重复创建副作用；按事实补偿或记录 unresolved；不接真实发信权限。','integration')]
# Revision 2: author-guided product behavior; all cases remain future requirements.
rows += [
('A33','W06','可组合的验证控制接口','冷启动调用方只知道一个命名场景；工具提供结构化输出、基础 help 与子命令帮助。','执行 doctor/setup/drive/observe；故意制造一个可恢复错误。','真实用户终点可观察；JSON 与诊断分开；错误指出可用的登记恢复动作；不要求临时写任意脚本。','live-local'),
('A34','W06','dry-run 与 doctor 的实际副作用','记录隔离目标文件、git refs、子进程与外部业务请求计数。','运行 setup/cleanup 的 dry-run 及 doctor。','目标资源无写入、服务未被隐式启动、无外部业务调用；必要只读访问范围明确。','negative'),
('A35','W18,W05','功能地图按用户路径检索','一个任务涉及两条入口和一段跨表面旅程；地图另有多个无关功能叶子。','检索并驱动相关路径。','只加载相关叶子与必要旅程；实际入口/动作/终点有记录；单入口成功不冒充双入口覆盖。','integration'),
('A36','W18','地图过期与前提不足','地图版本落后、控制动作已改名，或缺数据/auth/entitlement。','检查并尝试所需场景。','标记漂移或 blocked；required 场景不静默跳过；不删除功能或降低谓词恢复绿色。','negative'),
('A37','W17,W03','意图与根因假设分离','用户给出一个真实症状，同时提出可能错误的根因猜测。','独立重述并构造问题模型，之后用户纠正目标。','观察、目标、假设、非目标分别表示；纠正改变材料但不扩权；已充分说明的可逆工作无需反复确认。','unit'),
('A38','W17,W03','有限历史与当前证据','历史聊天包含曾成立但已过期的假设，当前源码与其冲突。','执行任务范围内的 recall/how/why/teach 数据流程。','当前事实优先；历史动机保留来源和不确定性；不扫描无关会话；解释不把 inference 改写为 fact。','integration'),
('A39','W17','调用体验先于接口冻结','给冷读者一份最小教程和候选接口，包含正常与错误路径。','从空场景照教程调用并观察用户终点。','教程能产生目标结果和可理解恢复；签名与模块由调用需要推导，不能只验证类型编译。','experiment'),
('A40','W17','技术未知的有限原型','一个会改变实现的未知、一组结构不同的选择、固定实验预算。','用最小可丢弃程序观察比较，并生成决定。','结论带方法/环境/观察/边界；未解决保持 unknown；预算耗尽停止；没有生产交付票据。','experiment'),
('A41','W17','实现偏差触发设计重审','多个无关调用点需要同形态 workaround、额外状态或类型逃生口。','对照使用草图归因并审查设计。','显式记录偏差和原因；必要时重新设计，不静默追加补丁；有根据的复杂性不被机械否定。','unit'),
('A42','W07,W17','评审依据与未知分流','评审同时包含具体源码缺陷、明确安全不变量和无依据的抽象猜测。','分流与裁决。','真实缺陷/不变量仍可阻塞；猜测形成待检验问题而非自动扩张实现；不靠多数票关闭问题。','unit'),
('A43','W06,W07,W08','开发自验证与正式验收分离','开发者多轮 drive/observe 后自报 pass；正式独立 review 尚缺失。','聚合方法产物与交付状态。','允许预算内持续试改；self-check 保留上下文但不能产生 local_verified、覆盖失败或弱化 gate。','integration'),
('A44','W06,W12','文件隔离不等于运行隔离','两个 worktree 共享端口/DB/账号或资源额度；另有本地 stand-in 成功。','做环境就绪与容量检查再尝试并行。','冲突时隔离或限并发；记录 environment identity；不把本地成功标成云/远端已验证。','integration'),
('A45','W19,W11','基础设施维护与未启用周期','验证工具故障、地图漂移、产品回归分别出现，未配置任何 schedule。','读取健康、owner、版本和维护状态，并修复一个工具问题。','三类原因分开，修复后真实重驱；工具坏不能产成功；未创建定时任务/通知；证据留存。','integration'),
('A46','W10,W17','文档用途与结束计划','教程、接口参考、解释和战术计划分别存在；计划已经 completed 或 superseded。','构建新任务默认上下文，再显式查历史。','当前检索不注入旧计划为指令，历史/决定/回执可查；不会删除原始报告或冻结合同。','integration'),
('A47','W17,W15','以可复现价值衡量结果','试点包含新使用者、人工介入记录、工具故障与活动量指标。','汇总成功率、首次环境就绪、恢复时间与成本。','工具失败与产品失败分开；不将 PR 数或作者个人倍数当 ROI；教程成功有真实终点。','experiment'),
('A48','W05,W09,W18','一个入口与透明渐进路由','相同目标入口可触发不同 recipe；存在 58 个技能，用户只给具体任务。','路由并选择上下文，随后纠正任务类型。','仅相关方法/地图被加载；理由与缺口可见；纠正形成新材料，不依赖用户记全部命令，不静默省略必需验证。','integration')
]
cs=[]
for id,work,title,given,when,then,level in rows:cs.append({'id':id,'work_packages':work.split(','),'title':title,'given':given,'when':when,'then':then,'test_level':level,'status':'specified_not_implemented'})
deltas=json.loads((r/'evidence/article-design-deltas.json').read_text())['deltas']
for c in cs:
 c['design_delta_ids']=[d['id'] for d in deltas if c['id'] in d['acceptance_ids']]
(r/'acceptance-cases.json').write_text(json.dumps({'schema_version':1,'report_revision':2,'document_kind':'future_integration_acceptance_spec','executed':False,'cases':cs},ensure_ascii=False,indent=2)+'\n')
print(len(cs))
