# Skills-check verification journey

Use this example to check real CLI outcomes with a reusable driver. The default journey covers `healthy` and `missing-ref`. Add `--scope full` to cover all five mapped cases: `healthy`, `missing-ref`, `drift`, `mixed` and `empty`. It creates local Git fixtures, runs the compiled `skills check` command, checks retained evidence, and writes a feature map for the selected scope. An expected negative remains a product failure or drift result; verification does not recover the source.

## Target and prerequisites

Work from the root of the actual OSStack target checkout. Read `scripts/method-verification-journey.mjs` there and record its revision. Exported `.agents/skills/` or `.claude/skills/` directories contain method text, not this script or the compiled product. Do not run repository-relative commands from an exported skill directory.

Use the target's supported Node and pnpm versions, local Git, installed dependencies and current compiled artifacts. In a fresh checkout, run the repository's `pnpm install --frozen-lockfile` and `pnpm build` before the journey. Retain their logs separately. A successful build is a prerequisite, not proof of either CLI outcome. If tracked generated files were restored after a build, rebuild them explicitly; incremental cache state alone does not establish current output bytes.

Choose an absolute, owned scratch path with no leading or trailing whitespace. Assign it to the shell variable `OSSTACK_SCRATCH_ROOT` in the script before the block below, or export it from the calling shell. Do not use a project directory, a volume root or a serving home. The preamble below rejects an unset, empty or relative value, exports the selected path for Node, and creates the scratch root and its `runtime` parent directory. The journey output itself must be new. Existing output, including a symlink, is refused. This recipe requires an explicit root; it does not use the wrapper's default temporary path.

## Drive and doctor

Run the following block as a shell script from the target checkout root, with the prerequisites above satisfied. Do not paste its `exit` guards into an interactive shell that you want to keep open:

```sh
umask 077
export OSSTACK_SCRATCH_ROOT="${OSSTACK_SCRATCH_ROOT:?Set an absolute owned scratch path first}"
case "$OSSTACK_SCRATCH_ROOT" in
  /*) ;;
  *) printf '%s\n' 'OSSTACK_SCRATCH_ROOT must be absolute' >&2; exit 2 ;;
esac
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime" || exit 1
journey_output="${OSSTACK_SCRATCH_ROOT:?}/runtime/skills-check-journey-$(date -u +%Y%m%dT%H%M%SZ)-$$"
node scripts/method-verification-journey.mjs --output "$journey_output" > "$journey_output.stdout" 2> "$journey_output.stderr"
```

The script sets `umask 077` before creating directories and logs. The shell retains invocation stdout/stderr as sibling files ending in `.stdout` and `.stderr`; it does not precreate the journey output directory. Read those logs and the command exit status before interpreting the report. Keep the build log separately.

The wrapper accepts `--output ABSOLUTE_NEW_ROOT` and optional `--scope full`. Omitting `--scope` preserves the two-case journey. Unknown or repeated scope options are invalid usage. Do not add `--doctor`, `--dry-run`, `--case` or `--evidence-dir` to it. It calls the existing skills-check driver's read-only doctor before each case, then drives that case. A failed doctor stops the journey. Doctor does not create a passing behavior observation.

Choose the scope before running the block. For the five-case journey, replace its driver line with `node scripts/method-verification-journey.mjs --output "$journey_output" --scope full > "$journey_output.stdout" 2> "$journey_output.stderr"`. Keep the same scratch preamble and new-output requirement. Do not run both forms against the same output directory.

The wrapper creates only its new output tree. Its children use fixture-only HOME, OSSTACK_HOME and scratch paths. It does not open the default control-plane database. Each case uses its own local Git source and fresh fixture. No daemon, live provider or remote source is required.

## The selected feature map

| Case / scope | Required product observation | Product exit |
| --- | --- | --- |
| `healthy` / default and full | One source tracks the owned repository's main ref; its blessed SHA equals the current SHA; output reports up-to-date, no failure or drift | 0 |
| `missing-ref` / default and full | One source tracks an absent ref; output reports `no_matching_ref`; the source remains failed | 1 |
| `drift` / full | One reachable main-ref source has an older blessed SHA than the current SHA; output reports drift, with no unreachable source | 2 |
| `mixed` / full | Three sources retain their distinct healthy, absent-ref and drift observations; failure count 1 and drift count 1 both appear. The failure takes exit precedence; it does not erase the drift | 1 |
| `empty` / full | Zero configured sources and zero failed or drifted sources. This is an empty check, not proof that a source is healthy | 0 |

Each case's driver exits 0 only if its expected behavior, unchanged inputs and cleanup checks pass. A driver exit 0 for `missing-ref`, `drift` or `mixed` means the expected negative was verified, not that the source became healthy. Product exits alone are insufficient: check source counts, refs, blessed/current SHAs and raw per-source output against the fixed case definition.

The wrapper exits 0 only when every selected row and its evidence checks pass. Exit 1 means failure or refusal; exit 2 means invalid usage. Read the exit status and `journey.json` together. A failure stops later work; later rows remain `not_run`, not passed. A row can retain an earlier verified observation while the overall journey fails; check each row's `journey_status` and preserve unknown cleanup as unknown.

## Observe and retain

Read `feature-map.md`, `journey.json` and `journey-manifest.json` in the selected output. For each selected case, read its retained `cases/<case-id>/` evidence: receipt, raw command output, cleanup record and manifest. Full scope adds `cases/drift/`, `cases/mixed/` and `cases/empty/` to the two default directories. The wrapper checks receipt bytes, raw-file hashes, fixed case expectations, required source/build anchors, Git identities and fixture ownership. Retain the invocation stdout/stderr and separate build log. Manifest digests establish consistency; they do not authenticate an oracle or prove the build was produced from the recorded source.

These are full engineering audit records. Some command records include the non-secret fixture environment. Do not hand the full bundle to a model task that forbids reading those fields. Define that task's permitted inputs before use. This recipe can retain the full local audit records without a projection. When a task needs a bounded packet, use the explicit projection scope below. The default `scripts/project-method-journey-evidence.mjs` path still accepts only the two-case journey and produces packet `schema_version: 1`. It still refuses a full five-case input before creating output. Explicit `--scope full` accepts the five-case journey and produces packet `schema_version: 2`; this is not a silent widening of the default. Do not drop rows or rewrite the input scope to obtain acceptance. Retain the original audit bundle unchanged.

Successful cleanup removes each owned fixture and requires `scratch/` to contain only an empty `smoke/` directory. Evidence stays outside the disposable fixture and survives cleanup. Direct-child exit and fixture absence do not prove termination of every descendant: `descendant_termination` remains `not_attested`.

## Project a retained full journey and check the packet

First run the full journey using `--scope full` as described above. Keep its exact `journey_output` path, stdout, stderr and exit status. Projection can represent a closed failed journey; it does not require every case to pass. A missing or inconsistent evidence bundle is a projection refusal, not evidence that the product passed.

From a target checkout that includes the full-scope projector, run this block as a shell script after the scratch preamble. `journey_output` must identify the retained full journey. The packet directory must be new, under the owned scratch root, with an existing parent and outside the input tree. This block retains command logs as sibling files. It does not run another journey or modify the input:

```sh
umask 077
: "${journey_output:?Set the absolute retained full journey path}"
packet_output="${OSSTACK_SCRATCH_ROOT:?}/runtime/skills-check-packet-$(date -u +%Y%m%dT%H%M%SZ)-$$"
node scripts/project-method-journey-evidence.mjs --input "$journey_output" --output "$packet_output" --scope full > "$packet_output.stdout" 2> "$packet_output.stderr"
projection_exit=$?
if [ "$projection_exit" -ne 0 ]; then
  exit "$projection_exit"
fi
node scripts/project-method-journey-evidence.mjs --check "$packet_output" > "$packet_output.check.stdout" 2> "$packet_output.check.stderr"
```

Inspect both command exit statuses and logs. `--check` reads the packet's version and validates either supported version; do not add `--scope` to that command. A consumer that supports only version 1 must not silently drop version 2's extra cases. The packet directory contains `packet.json` and `manifest.json`; the packet version, not the manifest envelope version, distinguishes the two-case and five-case formats. To project a default two-case journey, omit `--scope full` from the projection command. Do not use a default journey as input to the full projection.

Projection reads retained bytes and recorded claims. It does not repeat CLI execution, reconnect to the original fixture or prove that the recorded build came from the source. `--check` verifies the packet's structure and byte consistency, not the original bundle or a current runtime. Hashes do not authenticate an oracle, author or historical account. Preserve the original source/build/time binding rather than relabel this check as a fresh product run.

Keep every row's failed, `not_run` and unknown observations, including cleanup limits. Product exits remain 0/1/2/1/0 only for the five corresponding verified case observations; a failed or unverified row must not borrow those expected exits as an observed pass. Selected output and evidence hashes are not the full raw logs. The packet omits raw environment values and raw stderr rather than offering a generic redactor. Inspect its declared scope before sharing it within the task's input authorization. Neither projection nor checking proves model-visible delivery, model execution, provider qualification or all possible skills-check behavior.

The examples are shell recipes for an authorized checkout. If a host task permits only specific literal calls, submit the approved commands separately within that task's boundary; do not treat these assignments, redirections or stop guards as permission to widen its shell access. Report a permission blocker without disguising or wrapping the denied command.

## Failure and maintenance

Keep the failed attempt. A missing build is a prerequisite blocker; an unexpected CLI result needs diagnosis. Do not rewrite the expected negative or delete a failed row to obtain success. A failed case can have a retained manifest marked unverified, an unsealed directory, or no created evidence. Refusal before the wrapper acquires its output directory creates no wrapper-owned output tree. The shell-created parent and sibling logs can still exist; inspect those logs for the refusal reason. Report that distinction.

Timeout or interruption attempts bounded termination of the wrapper's own direct child. It does not authorize killing similarly named processes or deleting unrelated homes. If cleanup is unknown, preserve the owned residue and report it. Use a new output directory for an authorized rerun after fixing the cause.

Use [maintain verification](maintain-verification.md) when the driver, CLI output, evidence layout or this recipe changes. A complete maintenance pass over this five-case map needs source review and actual drives for all five cases and their evidence paths. Run the journey with `--scope full` for that scope; the default two-case run remains valid partial coverage. A blocked or `not_run` row prevents a complete pass. Even five passing rows cover only these mapped local fixtures, not every source, remote provider, installation, race or global configuration. Reading or exporting this reference does not prove native host selection, model execution, provider qualification or a formal joint gate.

This concrete example adapts the pinned upstream [create/maintain verification practices](sources.md). Apply [the common evidence rules](evidence.md) to each actual run.
