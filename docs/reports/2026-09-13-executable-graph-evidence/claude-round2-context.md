你是 Claude Fable 5.1。现在是第二轮对抗性设计评审。禁止工具、文件修改、nested skills；只基于下文材料。这次请攻击我的具体方案，并修正你首轮中过强的结论。输出中文约1800字，必须逐项回应6项挑战，区分阻塞项与后续优化，最后给可实施修订。

用户目标：Google式真实可执行图，复用osstack agents/Loop/权限。不是知识图谱、graph explain、训练数据。不在本轮实现生产代码。

我的方案：产品先作为osstack graph + 新packages/graph独立模块；首选LangGraph.js作为嵌入式执行内核，GoogleADK2JS作为语义对照和替代候选，不一开始自建恢复调度器。没有LangSmith/云平台强制依赖。一次只实现一个backend，不建立通用多引擎抽象。独立osgraph仅在第二个独立宿主真实需要且协议稳定后做薄CLI。

挑战1：你说“两个checkpoint/session模型必然冲突，所以包装不成立”推理不足。OSStack daemon持有policy/grants/action ledger/租约/真实副作用唯一权威；LangGraph只持graph checkpoints，graph-run status是可重建投影，不让两边成为运行真相。engine checkpoint滞后重放时，broker用effect_key查已确认结果或unknown并阻断重发。checkpoint与action ledger无需假装跨库原子提交。单活worker租约+fencing_generation约束broker，陈旧worker无法发新动作或写当前代checkpoint。你是否认同可行？你自写调度器仍需同样副作用账本，不应把共同成本当作外部引擎独有缺点。

挑战2：JOIN COMPLETE不等业务成功并非ADK独有，LangGraph同样不解释{ok:false}；须显式schema+business predicate。ADK缺输出+outputSchema未报错实测，封装可补并非一定淘汰，但Workflow发experimental warning。本机cold-process warm-cache导入ADK中位308ms/LG135ms，超过20ms lazy门槛，两者只在graphworker懒加载；不能因此说只能自研。运行Node26.5尚未验证osstack最低Node20。

挑战3：首个垂直切片采用单writer implement→freeze immutable candidateRevision→并行review+tests(各自sandbox只允许输出证据；tests可以写隔离临时结果，不能把read-only标签当隔离)→ANDjoin同run/epoch/revision且两个schema有效→route ready|repair|escalate。最多repair2轮，图把回边在编译时展开为固定3epochs，不初版动态cycles。graph决定epoch，Loop只在单个写节点内做bounded local refine，不重复全图质量重试；两层预算共享daemon ledger。最终ready artifact，不自动merge/push/deploy，后续显式已有权限受控publish节点。比你首轮双writer再merge更窄且不撞repo串行锁。

挑战4：源码新增核实：Loop.runTask 920行成功时commitWorktreeChanges并立即mergeWorktree（ff-only），finallycleanup，不存在export-only模式。新节点不能直接复用这个runTask；需先提炼runOneTask({workspaceLease, signal, publication:"artifact_only",retainOnFailure:true})，改变graph路径行为，保留legacy默认。图运行不使用LOOP-STATE.json作为graph checkpoint。runCycle 490循环+544最后write确证cycle没有逐节点完成落盘；不夸大整个系统无任何审计。executor.ts147默认completed且流无done返回成功，确证需修。

挑战5：你“随机kill100次按run_id无重复代理运行”过强。外部provider不支持幂等或取消时，不能保证不重复计费/物理执行；要求同effect_key最多一份confirmed结果，下游只消费一次；unknown不得自动重发非幂等动作。timeout后可能仍在跑，不能直接标safe retry。cancelled状态只能确认adapter/子进程退出后；超时未确认标cancel_pending/reconciliation_required，保留worktree证据，不强制清掉用户未保存修改。

挑战6：graph是有界执行规格，绝不是权限grant本身；复用签名和schema思想不将ContinuationGrant当任意task/riskapproval。resume必须当前身份/tenant/workspace与graphspec/revision绑定并重新验policy/grant/expiry，bool resume不是授权。

接受门槛：离线semantics已10/10通过；持久恢复kill窗口、fencing、权限撤销、effect unknown、write锁、取消穿透、Node20+CI性能仍必须作为P0硬门槛。先用LangGraph单一实现跑完这些contract测试；若无法在不侵入引擎内部条件下完成，再有记录地评估ADK或有限自研，不因spike时间到就默认自研。不要附和我；指出真正不可行点和一个最强反例。

更正：MS agent-framework目前主README还提供Go版入口，不能写仅Python/.NET。

首轮你的答复：
这一轮只做设计评审，不动代码。以下先列已核实的代码事实，再给判断。

**一、已核实的代码事实（来自本次给出的源码）**

- 适配器契约只有 `invoke(task, signal)`，靠 AbortSignal 取消。文件头注释里写的 D5 "显式 cancel(runId) 方法" 在接口上并不存在，注释与接口已经脱节。
- 执行器不接受外部 signal，只用内部超时 AbortController。图级取消目前无法穿透到正在运行的适配器。
- 执行器的默认结果是 completed。若适配器流提前结束且没有 `done` 事件，run 会被记为成功。注释宣称"daemon 会拒绝不合规流"，但执行器本身不校验。这对 AND-join 是致命隐患。
- Loop 逐个顺序执行任务，重试、反馈、停滞指纹、升级都在 runTask 的迭代循环内。每任务可开独立 worktree。
- 摘录显示 LOOP-STATE.json 在整个 cycle 结束后才写回，且 in_progress 被清空。若中途崩溃，本 cycle 已完成任务大概率丢失。此点是摘录推断，需核实是否另有增量写入。
- daemon 写锁按 repo_id 串行，外加全局写信号量和文件锁，并受 autonomy 健康检查门控。
- 协议层已有 Ed25519 签名的有界委托（步数、重试上限≤3、超时、过期），但输出检查只有 text_equals 和 json_value_equals，达不到"类型化节点 I/O"。
- graph explain 只读，与执行无关。

**二、核心判断**

1. **不做新产品 osgraph。** 图执行的难点不在调度算法，而在权威归属：租约、写锁、健康门控、策略、证据链都在 daemon 里。独立产品要么重复这些，要么通过 RPC 回来借权限，两者都比在 monorepo 内新增 `@osstack/graph` 包更差。最强反方：Loop 的状态模型是"每工作区一个 JSON、顺序单任务"，图状态硬塞进去会越搞越乱。这个反方是对的，所以结论是图状态另存控制面 SQLite，图调度器位于 runTask 之上、cycle 之下，Loop 仍是"单节点执行器"。

2. **自己写小调度器，不包 ADK JS 或 LangGraph.js。** 理由：两者各自带会话和检查点模型，与"单一写者 daemon"冲突；ADK 的 Join 只等前驱 COMPLETE，不看成功，与我们需要的默认语义相反；LangGraph 的检查点不能让 worktree、子进程、git 分支这些外部副作用变成恰好一次，我们仍要自建幂等。另外依赖加载成本受 CLI 启动预算约束，Mastra 还要求 Node 22。反方：自写会重踩中断、恢复的老坑。应对：静态 DAG、节点数少，把 ADK 和 LangGraph 的语义改写成一致性测试用例，而不是引入运行时。给一天时间盒用 LangGraph.js 做对照 spike，只为校验语义和测量，不作为落地路径。

**三、关键机制**

- **权威归属**：图运行是一份有界委托，格式沿用 ContinuationGrant 思路。只有 daemon 写图状态；节点通过返回值交付，永远不直接改状态表。
- **持久化与副作用**：节点状态迁移（pending、running、succeeded、failed、cancelled、interrupted）在执行前先落库，附 run_id。恢复时 running 一律改 interrupted，只有声明 idempotent 的节点才自动重跑，其余交策略或人工决定。输出连同 sha256 落库，join 只读库，不读内存。
- **重试分层**：评审不过的重试留在 Loop 迭代内，图层只重试基础设施失败（适配器不可用、超时、interrupted），且两层预算相乘后的上限必须在图规格里显式声明，禁止双重重试同一评审失败。
- **取消**：执行器新增外部 signal 参数，形成图→节点→适配器的信号链。取消后待运行节点标 cancelled，join 按声明走 fail-fast 或等待，worktree 必须清理。
- **AND-join 作用域**：每次扇出生成 barrier_id，输出以（run_id, barrier_id, branch_id）为键。若图含回边，每一轮换新 barrier_id，不同轮的输出永不混入同一 join。默认谓词是"全部 succeeded"，"全部完成"作为显式选项。前提是先修执行器"缺 done 即成功"的缺陷。
- **worktree 并发**：并行分支各自 worktree。写锁按 repo_id 串行，同仓库多个 worktree 是否共用一个 repo_id 未核实，是并行度的第一个未知数。扇出分支只产出补丁或分支，合并到主线由 join 之后的串行节点在写锁下完成。
- **模式校验**：节点输入输出用 Zod（延续 E1 决策）。适配器输出是自由文本，需要约定结构化证据文件，校验失败即节点失败，交给 Loop 迭代带反馈重试。

**四、可度量的发布门槛**

- 三分支扇出中随机 kill 进程 100 次，恢复后终态一致，按 run_id 计数无重复代理运行。
- 取消后 5 秒内所有子进程退出，无孤儿 worktree。
- 属性测试：join 在任一分支非 succeeded 时绝不触发；跨轮输出绝不混入。
- 模式不合法的输出绝不进入下游节点。
- 同仓库两分支并发写，锁串行可观测，无丢失更新。
- CLI 启动预算和 Loop tick 开销预算不变，新包全部惰性导入。

**五、推荐的垂直切片**

图形为：plan → 并行（实现 A、实现 B，各自 worktree）→ AND-join（全部成功）→ verify → 条件路由（通过则串行合并，否则升级）。交付物：`@osstack/graph` 包含 Zod 图规格、调度器和三张 SQLite 表（graph_run、graph_node_run、graph_barrier）；执行器增加 signal 并修复缺 done 默认成功；从 Loop 暴露单任务执行入口供节点调用；daemon 增加 run、cancel、status 三个 RPC；CLI 命令避开已存在的只读 `graph explain`，建议用 `osstack graph run` 并在文档里明确两者边界。切片先做单进程、单仓库，不做跨机器，不做动态生成节点。

**六、结论**

新产品不成立，包装外部引擎也不成立。真正的前置工作是修执行器的两个缺陷、核实 repo_id 与 worktree 的关系、核实 cycle 中途崩溃的状态丢失，然后再动调度器。这三项未核实前，任何"图执行已具备基础"的说法都是推测。

实际离线测试输出：
{
  "node": "v26.5.0",
  "offline": true,
  "integrationTested": false,
  "results": [
    {
      "name": "adk: typed parallel branches + AND barrier",
      "pass": true,
      "evidence": {
        "maxActive": 2,
        "joins": 1,
        "received": {
          "a": {
            "ok": true,
            "revision": "rev1"
          },
          "b": {
            "ok": true,
            "revision": "rev1"
          }
        }
      },
      "durationMs": 53
    },
    {
      "name": "adk: conditional route is exclusive",
      "pass": true,
      "evidence": {
        "seen": [
          "repair"
        ]
      },
      "durationMs": 2
    },
    {
      "name": "adk: empty branch output still releases JoinNode",
      "pass": true,
      "evidence": {
        "joins": 1,
        "receivedKeys": [
          "a",
          "b"
        ],
        "missingOutputIsUndefined": true,
        "outputSchemaDidNotRejectAbsence": true
      },
      "durationMs": 1
    },
    {
      "name": "adk: invalid nonempty Zod output blocks downstream",
      "pass": true,
      "evidence": {
        "downstream": 0,
        "error": "NodeSchemaValidationError: Node 'bad' output does not match its outputSchema: [\n  {\n    \"expected\": \"boolean\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"ok\"\n    ],\n    \"message\": \"Invalid input: expected boolean, received string\"\n  }\n]"
      },
      "durationMs": 3
    },
    {
      "name": "adk: retry attempts bounded at three",
      "pass": true,
      "evidence": {
        "attempts": 3
      },
      "durationMs": 6
    },
    {
      "name": "langgraph: typed parallel branches + AND barrier",
      "pass": true,
      "evidence": {
        "maxActive": 2,
        "joins": 1,
        "output": {
          "a": {
            "ok": true,
            "revision": "rev1"
          },
          "b": {
            "ok": true,
            "revision": "rev1"
          },
          "joined": true
        }
      },
      "durationMs": 57
    },
    {
      "name": "langgraph: business false requires explicit route/check",
      "pass": true,
      "evidence": {
        "joins": 1,
        "seen": [
          "repair"
        ],
        "engineDoesNotInterpretBusinessOk": true
      },
      "durationMs": 9
    },
    {
      "name": "langgraph: retry attempts bounded at three",
      "pass": true,
      "evidence": {
        "attempts": 3
      },
      "durationMs": 14
    },
    {
      "name": "langgraph: interrupt resumes by restarting interrupted node",
      "pass": true,
      "evidence": {
        "priorRuns": 1,
        "beforeInterruptRuns": 2,
        "afterInterruptRuns": 1,
        "persistence": "same-process MemorySaver only",
        "resumeValueIsNotAuthorization": true
      },
      "durationMs": 16
    },
    {
      "name": "langgraph: recursion limit stops unbounded cycle",
      "pass": true,
      "evidence": {
        "runs": 4,
        "error": "GraphRecursionError"
      },
      "durationMs": 2
    }
  ]
}
