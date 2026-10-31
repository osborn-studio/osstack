# 从空场景核对 skills-check 地图

本教程使用已有的地图维护工具。它创建隔离的本地 Git 样例，运行真实编译后 CLI，并保留五种结果及清理证据。它不运行模型，不启动服务，不修改产品源码，也不自动修地图。

## 目标、观察与假设

- **目标：** 判断手中的固定五案例地图是否可用；输入被拒绝时，解释原因，在授权范围内修正自己的地图副本，再从同一入口验证。
- **观察：** 记录命令退出码、实际错误、五行产品结果、验证结果、清理状态和仍可读取的证据。
- **假设：** 当前 checkout 已正确构建，地图描述的确是本工具的五个本地案例。构建成功不证明地图或产品结果正确。若假设不成立，报告阻塞。

本教程只能验证这条冷使用路径。它不证明任意项目覆盖、模型自主操作、正式资格或整个 W17/C0 通过。工具接口已存在；这次使用不能倒称为它首次冻结前的实验。

## 1. 准备已构建 checkout 和新 scratch 场景

从实际 OSStack checkout 根目录操作，不要从导出的 skill 目录运行。需要支持的 Node、仓库指定的 pnpm、本地 Git、已安装依赖和与当前源码相符的编译产物。本路径使用 Node 22；仓库版本约束见 `package.json`。若没有现成构建，先按仓库说明安装和构建，保存日志，再开始本教程。验证期间不要恢复旧的生成文件。

先由当前任务指定一个**绝对、归你所有的** `OSSTACK_SCRATCH_ROOT`。不要使用仓库目录、裸磁盘根目录或服务数据目录。若任务给了待核对地图，把其绝对路径设为 `SOURCE_MAP`；否则使用下方默认地图。

以下代码块需按顺序执行并保留变量；若跨多个 shell，按下文恢复同一场景变量。不要把含 `exit` 的准备块直接贴入需要继续使用的交互 shell。不要开启 `set -e`：预期错误必须先记录，再判断。

```sh
umask 077
: "${OSSTACK_SCRATCH_ROOT:?Set an absolute owned scratch root}"
case "$OSSTACK_SCRATCH_ROOT" in
  /*) ;;
  *) printf '%s\n' 'scratch root must be absolute' >&2; exit 2 ;;
esac
export OSSTACK_SCRATCH_ROOT
SOURCE_MAP="${SOURCE_MAP:-$PWD/docs/implementation/skills-check-map-maintenance/map.json}"
case "$SOURCE_MAP" in
  /*) ;;
  *) printf '%s\n' 'SOURCE_MAP must be absolute' >&2; exit 2 ;;
esac
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime" || exit 2
tutorial_root="$OSSTACK_SCRATCH_ROOT/runtime/method-control-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$tutorial_root" || exit 2
export OSSTACK_HOME="$tutorial_root/home"
mkdir "$OSSTACK_HOME" || exit 2
cp "$SOURCE_MAP" "$tutorial_root/map.json" || exit 2
cp "$tutorial_root/map.json" "$tutorial_root/map-original.json" || exit 2
git rev-parse HEAD > "$tutorial_root/checkout-revision.txt" || exit 2
git status --short > "$tutorial_root/checkout-status.txt" || exit 2
node --version > "$tutorial_root/node-version.txt" || exit 2
printf '%s\n' "$tutorial_root"
```

如果每次调用都使用新 shell，请先从首次打印的路径重新设置 `tutorial_root`，并重新导出同一 `OSSTACK_SCRATCH_ROOT` 与 `OSSTACK_HOME="$tutorial_root/home"`。不要重跑创建场景的准备块，也不要复用旧输出目录。

只编辑 `tutorial_root` 内的副本。原始 `SOURCE_MAP`、产品源码和已有证据不属于本教程的修改范围。保留对应构建日志的位置；仅记录 Git HEAD 不能证明工作区或编译产物相同。工具会另记本次来源和构建绑定。

## 2. 从同一入口运行并解释结果

输出目录必须尚不存在；只创建其父目录。维护入口经 `runJourney` 调用每个案例的 doctor，再驱动该案例，不需另加 `--doctor`、`--case` 或 `--scope`。

```sh
attempt_output="$tutorial_root/attempt-01"
node scripts/maintain-skills-check-map.mjs --map "$tutorial_root/map.json" --output "$attempt_output" > "$attempt_output.stdout" 2> "$attempt_output.stderr"
attempt_exit=$?
printf '%s\n' "$attempt_exit" > "$attempt_output.exit"
```

先读取 `.exit`、`.stderr`。若目录已创建，再读取 `maintenance.json`；不要因为文件不存在就假定工具没运行。

| 维护命令退出码 | 含义 | 下一步 |
| --- | --- | --- |
| 0 / `consistent` | 五例均经验证，且地图与实际结果一致 | 检查下面的五行结果及清理证据 |
| 1 / `mismatch` | 地图形状合法，但至少一项期望与已验证结果不同 | 对照 `rows`、源码和原始结果，区分地图漂移与产品问题 |
| 2 / `blocked` | 输入无效、前提不满足、旅程失败、证据不完整或地图运行中改变 | 按实际错误处理；不能记作产品断言失败或通过 |

非法地图会在驱动前被拒绝，不创建本次输出目录。此时 `.stdout/.stderr/.exit` 是 shell 保留的记录；没有 `maintenance.json` 属于该拒绝路径的预期。若输出已创建，失败记录可能在目录内，必须保留。

## 3. 核对地图契约，必要时恢复

现有合法示例是 [map.json](../implementation/skills-check-map-maintenance/map.json)。这是固定工具契约示例，不是已通过的运行证明。

输入须是非符号链接的普通 UTF-8 JSON 文件，最多 64 KiB。顶层只含 `schema_version: 1`、`target: "skills-check-full"`、`features`。每行只含 `case_id`、`expected_product_exit` 和 `expected_product_status`。必须恰好覆盖下表五个不同 ID，不能遗漏、重复或增加 ID；行顺序不限。退出码须为 0–255 整数，状态须为 `healthy`、`failed`、`drift` 或 `empty`。

| case_id | 预期产品退出码 | 预期产品状态 | 可观察行为 |
| --- | --- | --- | --- |
| healthy | 0 | healthy | 固定来源可检查 |
| missing-ref | 1 | failed | 固定引用不存在，来源检查失败 |
| drift | 2 | drift | 当前来源与已认可版本不同 |
| mixed | 1 | failed | 失败与漂移并存，失败优先 |
| empty | 0 | empty | 没有来源被检查，不是健康来源证明 |

如输入被拒绝，先把错误与上述契约对上。只有确认属于授权地图范围时，修正 `map.json` 副本；保留 `map-original.json`、原始错误与修正理由。不要改工具、跳过案例、改产品负例或放宽预期来获得通过。若问题来自构建、工具、产品或仍未知，保留记录并报告阻塞，不把它猜成地图错误。

修正后仍用同一维护入口，换一个不存在的输出目录。不要覆盖第一次尝试：

```sh
attempt_output="$tutorial_root/attempt-02"
node scripts/maintain-skills-check-map.mjs --map "$tutorial_root/map.json" --output "$attempt_output" > "$attempt_output.stdout" 2> "$attempt_output.stderr"
attempt_exit=$?
printf '%s\n' "$attempt_exit" > "$attempt_output.exit"
```

若第一次已一致，无需为教程重复驱动。若恢复后仍阻塞，停止扩大操作，报告实际错误与未完成范围。

## 4. 验证用户终点和证据保留

在成功尝试的 `maintenance.json` 中核对：`status=consistent`、`exit_code=0`、`execution_path=runJourney`、`map.unchanged=true`、五行 `matches=true`。每个 `rows[].actual` 应与上表对应。

再核对 `journey/journey.json`：总体 `status=passed`；五项 `verification=passed`、`driver_exit=0`；各自的 `product_exit/product_status` 仍保留上表差异。**产品退出1或2可以是预期负例；driver退出0表示该负例被正确验证，不表示来源已修好。** 失败、`not_run` 或 unknown 不能借预期表冒充实际观察。

清理后仍应能打开这些文件：

- `map-before.json`、`maintenance.json`；前后快照发现地图改变时才另有 `map-after.json`，正常缺少它不是证据丢失。
- `journey/feature-map.md`、`journey/journey.json`、`journey/journey-manifest.json`。
- 每个 `journey/cases/<case_id>/manifest.json` 及其列出的原始命令/输出、绑定和 `cleanup.json`。

读取每项 cleanup 的 `status`、`fixture_removed` 和记录的 `fixture_path`。成功应为 `passed`、`true`；检查该具体路径已不存在，同时上述证据仍可读。只检查本次记录的路径，不扫描或清理别人的进程/目录。记录的 fixture 不存在不证明所有后代进程都已终止。

保留整个 `tutorial_root` 供复核；不要把它与已清理的运行 fixture 混淆。汇报：本次目标、源码/构建记录位置、尝试退出码与原因、修改了哪份地图、五行实际结果、清理与证据位置、剩余未知。日志包含本地路径，分享前按任务授权核对范围。

## 可选：给消费者一个有限证据包

这不是本教程冷使用验收的必需步骤，本次未执行此可选分支。需要分享五行摘要时，可将**成功尝试内的** `journey/` 作为 projector 输入：

```sh
packet_output="$tutorial_root/packet-01"
node scripts/project-method-journey-evidence.mjs --input "$attempt_output/journey" --output "$packet_output" --scope full
node scripts/project-method-journey-evidence.mjs --check "$packet_output"
```

第一条失败时不要继续第二条；分别保留原始退出码与输出。`--check` 不加 `--scope`，由 packet 版本识别。它检查封闭结构与字节一致性，不重新执行产品，不认证原运行/模型身份，也不证明消费者理解材料。原始旅程始终保留。

本教程独立表述并适配 Lauren Tan 的 MIT 许可 [pstack maintain-verification-skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md)：实际驱动、故障归属、恢复后复验、清理后证据仍在。原来源和许可见 来源说明 (removed)。它只覆盖本仓库固定案例，不实现上游全部维护流程或默认周期任务。
