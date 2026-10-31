# Find a local verification journey

From the actual checkout root, select instructions for one of three existing CLI tasks. Use supported Node (these recipes use Node 22), installed dependencies and current `@osstack/knowledge` build output. The reader ranks **index metadata only** with the existing BM25 search, then reads selected leaves and required dependencies. It does not execute their commands.

```sh
node scripts/method-feature-map.mjs --index docs/verification/features/index.json --query "maintain expectation map" --limit 1
node scripts/method-feature-map.mjs --index docs/verification/features/index.json --query "full journey drive" --limit 1
node scripts/method-feature-map.mjs --index docs/verification/features/index.json --query "project retained packet" --limit 1
```

| Task | Material | Required leaf |
| --- | --- | --- |
| Compare and maintain five-case expectations | [maintenance.json](maintenance.json) | None |
| Drive the full five-case skills check | [journey.json](journey.json) | None |
| Project and inspect retained evidence | [packet.json](packet.json) | journey |

If the intended task changes from maintenance to retained-evidence inspection, run the third query. It selects packet plus journey instructions, without executing another journey. Maintenance internally drives the full journey when explicitly run, but its leaf already explains that contract; its selection need not load the whole library.

These are three CLI tasks, not CLI/UI or CLI/RPC coverage. All `covered_entry_ids` and `last_live_evidence` are empty. Owner references are `null`/unassigned until project configuration names a responsible owner. Upstream authors, workers and fixture ownership are not maintenance assignments.

## Interpret reader results

Inspect `selected[].reasons`, `omitted`, hashes, freshness, preconditions and `unverified_entry_ids`. Ranking is lexical; no match is explicit. `--limit` bounds initial ranking, not required dependencies. Required material is never silently omitted.

| Reader exit | Meaning |
| --- | --- |
| 0 | Complete material selection/read, even when availability is unknown, blocked or drift; never product success |
| 1 | Valid query, no match |
| 2 | Invalid input/schema/dependency graph, unsafe/unavailable file or identity mismatch |
| 3 | Required material missing, content drift, selection budget exceeded or knowledge search unavailable |

Errors are JSON stderr with stable `error` codes. Availability, evidence and execution are separate: execution stays `not_run` and all entries remain unverified. Optional `--observations PATH` supplies caller-declared observations, for example:

```json
{"schema_version":1,"features":[{"feature_id":"maintenance","source_revision":null,"driver_version":null,"preconditions":[{"id":"checkout","status":"unknown"}],"observed_entry_ids":[]}]}
```

Prerequisite input statuses are `met`, `missing` or `unknown`; output labels them `reported_met`, `blocked` or `unknown`. Missing observations remain unknown. Source/driver comparison returns `matches_reported`, `drift` or `unknown`, not authenticated freshness. Use independently recorded bindings or null; copying expected values proves nothing. Caller-observed entry IDs never become verified coverage. Empty last-live references remain draft; nonempty ones would still be unverified because this reader has no evidence-authority resolver.

[Index](index.json) and leaves are closed local authoring/retrieval formats, not the strict `material:feature_map` protocol body. Source/driver pins use `path@sha256:<actual file digest>`: maintenance/journey bind `skills-command.ts` and their own wrapper; packet binds its journey-format producer and projector. Unrelated Git commits do not invalidate these file pins. They do not attest transitive helpers, dependencies or compiled outputs; actual runs retain separate bindings.

Bounds: index 64 KiB/32 IDs, query 4 KiB, initial limit 1–5, closure eight leaves, each leaf 32 KiB, total leaf bytes 128 KiB. Cycles, unknown dependencies and changed bytes fail. Terminal index/observations symlinks and all symlink components below the canonical index parent for leaves are rejected; leaf references cannot escape that parent. The index parent's path may itself resolve through a symlink. These checks are not an OS sandbox or concurrent-writer fence.

## Prepare a separately authorized drive

Selection is not execution permission. Maintenance/journey need local Git, installed dependencies and current compiled artifacts; retain install/build logs and do not restore old generated files before validation ends. Projection/check needs retained files, not a rebuild or new product run.

Choose an absolute task-owned `OSSTACK_SCRATCH_ROOT` outside repositories, bare volumes and serving homes. Run this as a shell script from the checkout root, not an exported skill folder. Its exit guards are unsuitable for an interactive shell that must remain open. Do not use `set -e` around expected negatives.

```sh
umask 077
: "${OSSTACK_SCRATCH_ROOT:?Set an absolute owned scratch root}"
case "$OSSTACK_SCRATCH_ROOT" in
  /*) ;;
  *) printf '%s\n' 'scratch root must be absolute' >&2; exit 2 ;;
esac
export OSSTACK_SCRATCH_ROOT
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime" || exit 2
feature_root="$OSSTACK_SCRATCH_ROOT/runtime/feature-journey-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$feature_root" || exit 2
export OSSTACK_HOME="$feature_root/home"
mkdir "$OSSTACK_HOME" || exit 2
printf '%s\n' "$feature_root"
```

Save the printed path. Across shells restore `feature_root`, `OSSTACK_SCRATCH_ROOT` and `OSSTACK_HOME`; do not repeat creation. The wrappers create their own new output directories and isolate product homes. Never invoke a development CLI against the default or reserved control-plane home.

### Maintain expectations

Copy the supplied map or an authorized absolute `SOURCE_MAP`, preserving its original bytes:

```sh
SOURCE_MAP="${SOURCE_MAP:-$PWD/docs/implementation/skills-check-map-maintenance/map.json}"
case "$SOURCE_MAP" in
  /*) ;;
  *) printf '%s\n' 'SOURCE_MAP must be absolute' >&2; exit 2 ;;
esac
cp "$SOURCE_MAP" "$feature_root/map.json" || exit 2
cp "$feature_root/map.json" "$feature_root/map-original.json" || exit 2
node scripts/maintain-skills-check-map.mjs --map "$feature_root/map.json" --output "$feature_root/maintenance-01" > "$feature_root/maintenance-01.stdout" 2> "$feature_root/maintenance-01.stderr"
maintenance_exit=$?
printf '%s\n' "$maintenance_exit" > "$feature_root/maintenance-01.exit"
```

Exit 0 is consistent, 1 mismatch and 2 blocked. The input is the separate closed five-row expectation format, not this feature index. Invalid input is refused before output acquisition, so inspect sibling logs even when `maintenance.json` is absent. A mismatch needs cause analysis; correct only an evidenced, authorized map error, retain the earlier failure and use a new output such as `maintenance-02`. See the [exact map contract](../../implementation/skills-check-map-maintenance/README.md) and [recovery tutorial](../method-control-tutorial.md).

### Drive five cases

```sh
node scripts/method-verification-journey.mjs --output "$feature_root/journey-01" --scope full > "$feature_root/journey-01.stdout" 2> "$feature_root/journey-01.stderr"
journey_exit=$?
printf '%s\n' "$journey_exit" > "$feature_root/journey-01.exit"
journey_output="$feature_root/journey-01"
```

Exit 0 means all selected cases/evidence passed, 1 failure/refusal and 2 invalid usage. Omitting `--scope full` runs only two cases. Do not add driver-only options to this wrapper. A failed doctor stops later work, leaving `not_run` rows.

Verified product exits/statuses are `healthy 0/healthy`, `missing-ref 1/failed`, `drift 2/drift`, `mixed 1/failed`, `empty 0/empty`. Driver exit 0 verifies the expected negative; it does not repair a source. Empty checks no sources. Inspect counts, refs, SHAs, raw output, overall status and cleanup, not exits alone. See the journey reference (removed).

### Project and check retained evidence

Set `journey_output` to the exact absolute retained full journey: for maintenance output, `"$feature_root/maintenance-01/journey"`; for direct journey, the path above. Choose the actual input. A coherent closed failed journey may be projected; unsealed, unreadable or inconsistent evidence is refused. Reading the required journey leaf does not rerun it.

```sh
: "${journey_output:?Set the absolute retained full journey path}"
node scripts/project-method-journey-evidence.mjs --input "$journey_output" --output "$feature_root/packet-01" --scope full > "$feature_root/packet-01.stdout" 2> "$feature_root/packet-01.stderr"
projection_exit=$?
printf '%s\n' "$projection_exit" > "$feature_root/packet-01.exit"
if [ "$projection_exit" -ne 0 ]; then
  exit "$projection_exit"
fi
node scripts/project-method-journey-evidence.mjs --check "$feature_root/packet-01" > "$feature_root/packet-01.check.stdout" 2> "$feature_root/packet-01.check.stderr"
check_exit=$?
printf '%s\n' "$check_exit" > "$feature_root/packet-01.check.exit"
```

Projection returns 0/projected; check returns 0/valid. Both use 1 for rejection and 2 for invalid usage. `--check` accepts no `--scope`. Full projection produces packet version 2; default two-case projection remains version 1 and refuses full input. The new packet directory must be outside the input tree, under owned scratch, and contain only `packet.json` and `manifest.json`; keep logs beside it.

Projection/check do not rerun the product. Check validates packet structure/bytes, not original evidence, producer identity or consumer understanding. Keep failed/not-run/unknown states and the original audit bundle. The full projector can reject nonempty retained Git SHA stderr that the journey accepted; diagnose without deleting stderr or rows to force acceptance. The packet is not a generic redactor; sharing still follows the task's input authorization.

## Preserve limits and evidence

Retain failed and successful attempts separately. When cleanup reports passed, confirm the recorded fixture is absent and evidence remains readable. Unknown cleanup requires preserving residue and reporting it. Never delete unrelated homes, kill similarly named processes or lower predicates to obtain green output. Direct-child exit and fixture absence do not attest all descendants.

W19 still owns configured responsibility, health queries, change-triggered maintenance and A45 tool-fault repair/re-drive. This index creates no scheduler, watcher, notifications or automatic repair; periodic maintenance is unconfigured/off. Material selection proves no complete A35/A48, new host/model execution, Firstmate deep runtime or whole C0/C1/C2 gate.

## Sources

These independently worded instructions adapt OSStack's existing workflows and pstack create/maintain verification practices, authored by poteto. The inspected [MIT license](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/LICENSE) names Copyright (c) 2026 Lauren Tan. Sources at pin `99b609a72323b70204eab407c622f436e858e112`: [create verification](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md), [maintain verification](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md) and the repository adaptation record (removed). No upstream executable code or substantial verbatim skill text is copied.
