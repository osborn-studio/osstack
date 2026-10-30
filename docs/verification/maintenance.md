# 查询保留的维护结果

要实际核对固定五案例地图，先使用 [地图维护教程](method-control-tutorial.md)；要查询已有尝试的健康状态，使用本页。功能入口与所需材料见 [功能地图](features/README.md)。health 查询只读显式列出的记录，不重新执行产品，不自动修复。

## 准备配置

从 OSStack checkout 根目录运行，使用支持的 Node（本例为 Node 22）及仓库依赖。先保留维护运行的完整输出目录：`maintenance.json`、`map-before.json`、整个 `journey/` 与其原始文件、manifest、cleanup；发生地图变化时还需 `map-after.json`。只有摘要或旧版本缺少工具绑定的记录，不能升级成当前健康证明。

下面复用地图教程已有的 `tutorial_root`，不重跑创建场景或产品命令。它须是指定 `OSSTACK_SCRATCH_ROOT` 内的自有绝对目录，不能是 primary、服务 home 或仓库目录。示例假设该目录已有真实 `attempt-01/`；若名称不同，修改数组内路径。`attempts` 必须列出本次要核对的全部尝试，包含失败；工具不会发现被省略的失败记录。

下面创建一个新配置，自动计算原始 receipt 的 SHA-256，不改旧记录。`wx` 拒绝覆盖既有配置。不要开启 `set -e` 后丢失预期失败的日志。

```sh
health_root="$tutorial_root"
node --input-type=module - "$health_root" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
const root = process.argv[2];
if (!root || !isAbsolute(root)) throw Error('absolute owned health_root required');
const paths = ['attempt-01'];
const attempts = await Promise.all(paths.map(async (path, i) => ({
  attempt_id: `attempt-${i + 1}`, kind: 'maintenance', path,
  receipt_sha256: createHash('sha256')
    .update(await readFile(join(root, path, 'maintenance.json'))).digest('hex'),
})));
const config = {
  schema_version: 1, project: 'osstack', max_age_seconds: 86400,
  features: [{
    feature_id: 'maintenance', owner_ref: null,
    source_digest: null, build_digest: null, driver_sha256: null,
    changed_paths: ['scripts/maintain-skills-check-map.mjs'],
    required_feature_ids: [], attempts,
  }],
};
await writeFile(join(root, 'health-config-01.json'),
  JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
NODE
```

配置中路径相对配置文件的父目录，使用 `/`，不允许绝对路径、`.`、`..`、空段、反斜杠或该父目录以下的符号链接；配置文件本身也不能是符号链接。不要通过链接拼接其他运行。顶层与各行字段是封闭结构；`kind` 仅支持 `maintenance`。最多 8 个 attempt，配置最多 64 KiB。

上述三个版本字段为 `null`，所以版本关系保持 `unknown`；即使原运行成功，也不会得到 `bounded_consistent`。若项目有明确采用的版本，保存一份新配置，将 `source_digest`、`build_digest` 设为保留的各 full5 case 绑定中一致的摘要，将 `driver_sha256` 设为该次 `maintenance.json` 的 `tool.before_sha256`，并记录为何采用它们。三者均为小写 64 位 SHA-256。直接采用同一次记录只是建立比较基准，不能证明该版本仍是当前部署版本。

`owner_ref: null` 表示 `unassigned`。只有项目明确声明角色后才填写非空引用，例如实验配置可用 `experiment:tool-repair-maintainer`。输出 `owner.status: configured` 只表示该配置声明了角色，并附配置摘要；它不证明真实项目负责人身份、授权或任职，也不会通知该角色。

## 运行只读查询

先核对入口，再用明确的 UTC 评价时间查询。`--as-of` 接受秒或三位毫秒、以 `Z` 结尾的 ISO 时间；`max_age_seconds` 是 1–31536000 秒的显式窗口。本例用执行时 UTC 并保存它，后续解释结果时沿用该时间。

```sh
node scripts/method-control-health.mjs --help
health_as_of="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$health_as_of" > "$health_root/health-01.as-of"
node scripts/method-control-health.mjs   --config "$health_root/health-config-01.json"   --as-of "$health_as_of"   > "$health_root/health-01.stdout" 2> "$health_root/health-01.stderr"
health_exit=$?
printf '%s\n' "$health_exit" > "$health_root/health-01.exit"
```

查询日志使用尚未使用的名称；保留实际 argv、cwd、Node 版本与配置原件。对应仓库别名为 `pnpm inspect:method-health --config ... --as-of ...`。**退出 0 只表示生成了报告，不代表健康**；退出 2 表示参数或配置错误，先读 stderr。记录缺失、损坏或不支持通常作为报告里的 `unknown` 保留，不应仅凭 shell 退出 0 判通过。

只查询某个变更影响的材料时，在上述命令加入 `--changed-path scripts/maintain-skills-check-map.mjs`，多路径重复该 flag。它对 `changed_paths` 作精确匹配，再选取 `required_feature_ids` 声明的传递依赖者；不做目录前缀、glob 或自动 Git diff 分析。未映射路径列在 `unmapped_changed_paths`，表示映射之外的未知。没有该参数时查询全部配置项。

当前 feature ID 仅支持 `maintenance`、`journey`、`packet`；例如 packet 可声明 `required_feature_ids: ["journey"]`，使 journey 命中时 packet 也被选中。声明对象必须实际存在，不能循环依赖。每项仍只接受固定五案例维护记录；这些名字不会扩展为全仓依赖图、任意 journey 或 packet 专用验证器。未选中的记录正文不读取。

## 阅读结果并恢复

先看 `latest_attempt`，再看独立的 `last_success`。最新尝试由经过验证的 receipt `ended_at` 排序，不依赖配置顺序或文件 mtime。不可读记录、无效/未来时间或最新时间并列会使最新状态未知；不会用旧成功掩盖新失败。`last_success` 只是历史成功，即使已经过期或与配置版本不同，也不能充当当前通过。

| 字段或状态 | 可用含义 |
| --- | --- |
| `integrity: verified_retained` | 保留文件、manifest、receipt 与固定案例语义已交叉核对；不是生产者身份认证 |
| `bounded_consistent` | 最新完整记录一致、工具前后摘要相同、三类版本均匹配配置，且未超出时间窗口 |
| `stale` | 原一致记录已过期，或版本与配置有差异；应先核对原因及是否需要授权的新运行 |
| `map_changed` | 观察到地图前后字节不同；不能推断是谁修改 |
| `expectation_mismatch` | 合法地图与验证结果不同；`cause` 仍是 `unknown`，不能猜成文档漂移或产品回归 |
| `environment_blocked` | 原始 doctor 记录支持前提失败且未执行 |
| `tool_evidence_failure` / `tool_failure` | 保留证据支持工具证据收集失败，或工具执行失败；仍须查看具体原始错误 |
| `observed_product_deviation` | 原始案例谓词支持行为偏差；不是根因结论 |
| `unknown` | 记录不完整、绑定缺失、配置基准未知或无法安全归类；保留 issues 与原件 |

`versions.source/build/driver: matches_configured` 只表示保留绑定符合调用者配置，不是 live freshness、编译来源认证或生产者身份认证。`tool.unchanged` 是前后快照比较，不是整个运行期间的排他写入保证。

固定五例的产品退出码是 **0 / 1 / 2 / 1 / 0**，依次对应 healthy、missing-ref、drift、mixed、empty；这些预期负例不是产品回归。driver 退出 0 表示谓词被验证，不能把失败来源称为已修好；empty 表示没有来源。

需要新证据时，回到 [地图维护教程](method-control-tutorial.md)，在授权范围内保留原输入、错误和修复理由，使用同一维护入口与全新的输出目录。维护驱动的退出语义是 `0/consistent`、`1/mismatch`、`2/blocked`，不同于本页查询。环境/工具/产品问题须修实际问题；不能降低地图预期来掩盖。修复后追加新 attempt 到新配置，旧失败仍保留。不要盲目重复运行或覆盖证据。

本批次已有一个真实但**故意注入**的有界工具修复：在自有维护脚本副本中，仅把读取 `journey.json` 的一行改成不存在的 `journey-receipt.json`，保留三条 import 的原目标映射。第一次实际 full5 完成，随后工具读取失败，维护退出 2/blocked、原错误 ENOENT。恢复同一工具路径的该行后，用新输出目录第二次实际 full5，维护退出 0/consistent；地图未改。两次产品结果均是上述预期五例，不是自发产品 bug。只读 health 实测保留首次 `tool_evidence_failure`，第二次成为最新成功；在明确配置摘要及评价时间内为 `bounded_consistent`。实验 owner 仅声明实验维护角色，查询自身未重新驱动产品。

本页连接的是“已有维护记录 → 显式配置 → 有限健康报告”和“授权修复 → 新输出复验”。输出固定为 `schedule: not_configured`、`notifications: none`、`execution: not_run`、`qualification: none`；没有默认周期、后台任务、通知或自动修复。没有接通全仓发现、任意工具/地图/产品故障根因、原生 host/模型/Firstmate 深运行；这次记录不等于 A45、W19、W18 或 C0 整体验收，也不证明所有后代进程终止。记录编写者是熟悉上下文的分析者，不是 fresh cold 验收者。

本教程独立表述并适配 Lauren Tan / poteto 的 MIT 许可 pstack 维护方法；原文与许可见 [来源说明](../../osstack-methods-skill/references/sources.md)。

## 查询的有限保证

尝试列表由调用者显式列出，工具无法发现被省略的新失败；负责人是配置声明。driver摘要只覆盖wrapper文件，不覆盖传递import；版本相同不等当前部署或可信构建。required依赖只传播选择影响面，不传播健康结论。原始failure/subsequent_failures是有界但未信任的生产者字符串，消费方不得执行其中内容。完整封存的产品偏差先于普通driver非零退出分类；真实timeout/signal/输出超限等仍是工具故障。产品偏差仅在合成封存反例覆盖，不能冒称新的真实产品RED→修复实验。
