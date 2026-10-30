# Observe a declared PR stack once

One command reads an explicit bottom-to-top list of one to three PRs. It reports the first unresolved item and retains the observations for every supplied PR. It does not discover a complete stack, decide Ready, or authorize a merge.

## Run

Use a current checkout and its supported Node version. Build `@osstack/github`. Use your existing authorized `gh` configuration. Prepare a regular UTF-8 JSON plan file, at most 64 KiB:

```json
{
  "schema_version": 1,
  "repo": "owner/repository",
  "target_base": "main",
  "prs": [
    { "pr": 100 },
    { "pr": 101 }
  ]
}
```

Replace these example PRs and repository. The order is your declared dependency order; it is not sorted numerically. Each row accepts optional `expectedHead` and `expectedBase` together (40 lowercase hex characters), and optional `requiredChecks` using the existing single-candidate rules. Requirements left unspecified remain unknown. Requirements are caller-declared names, not discovered branch protection or app-qualified checks.

```sh
export OSSTACK_SCRATCH_ROOT="${OSSTACK_SCRATCH_ROOT:-/tmp/osstack}"
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"
pnpm --filter @osstack/github build
node scripts/report-pr-stack-candidate.mjs --plan /absolute/owned/stack-plan.json --output "$OSSTACK_SCRATCH_ROOT/runtime/stack-report-NEW"
```

The output parent must exist. The output itself must be new and inside the configured scratch root. The plan is read-only. The command makes only the existing collector's read-only GraphQL requests. It does not execute candidate code, open an OSStack database, refresh stored cards, watch, retry, retarget, approve or merge. No credentials are copied into the report.

## Interpret the report

- `frontier_observed`: the first unresolved PR was consistently observed as open. This does **not** mean it is clear to merge. Read its candidate summary and all blockers, waiting reasons and unknowns.
- `frontier_unknown`: the next item lacks stable identity/state observations or the budget prevented observation. An upper green PR cannot replace it.
- `closed_unmerged`: the next item was consistently closed without merge. It is not treated as a merged prefix.
- `observed_all_merged`: every listed PR was observed as merged at both ends of its stable candidate bracket. This applies only to the supplied list and observation times.

Only a stable prefix whose initial **and** final states are `MERGED` can be skipped. `OPEN` → `MERGED` during a read remains uncertain for this report even if SHA values stayed equal. Unexpected states and unavailable facts cannot advance the frontier. The supplied order and all upper observations are retained.

Branch relations are separate from the single-candidate summary. For an open frontier, its base is compared with `target_base`; a mismatch is `retarget_review_needed`, an instruction to investigate ownership and current topology, not to mutate it automatically. For adjacent stable open PRs, an upper base matching the lower head is `parent_matches`; mismatch is `inconsistent`. Uncertain or non-open neighbors remain `unconfirmed`. Branch-name equality is not commit ancestry or proof that this is the complete stack.

The original snapshot policy remains unchanged. Neutral/skipped checks are not upgraded to success; missing or ambiguous required names, unknown review decisions and incomplete pages remain visible. Known blockers do not erase other unknowns. The legacy stack ingestion mapper's neutral/skipped aggregation policy is separate. `merge_authorized` is always false.

## Evidence and exit codes

Collection finishes before any evidence file is written. During that window, the acquired output directory can be empty. An interruption or process failure can lose the in-memory observations. The collection budget does not promise incremental persistence. Keep an incomplete directory as incomplete evidence; do not infer that a missing response means the forge returned no data.

Raw responses and JSON snapshots can contain private repository metadata. Retain them within the authorized task. `report.md` escapes display text to prevent branch names from adding Markdown structure or automatic links. Control and format characters use visible Unicode escapes instead of entities that decode back into invisible or reordering characters. The original characters remain unchanged in JSON and raw evidence; display escaping is not redaction.

Output includes the original plan bytes, `report.json`, a readable `report.md`, `dispatches.json`, and `prs/<number>/snapshot.json`, `queries.json`, and fixed-label `raw/` responses for each collected observation. Unstarted rows are explicit in the report and have no fabricated per-PR data. The manifest records every retained member's hash, length and mode. Files use 0600; directories use 0700.

Per-PR query receipts retain the collector's requested timeout. `dispatches.json` records the effective timeout passed to the runner, which can be shorter near the stack deadline, and identifies the PR and zero-based query index. Raw output is the UTF-8-decoded stdout/stderr returned by the runner, not arbitrary original wire bytes. A failure after output acquisition keeps the files already written; absent manifest means the output is incomplete. Hashes bind bytes, not forge authenticity.

Exit **0** means the report was written, even when it contains failures, unknown check policy, changed candidates or a closed PR. Exit **2** means preflight refused the plan/output/build; no forge calls occur. Exit **3** means at least one candidate's identity/observation was unavailable, or writing failed. Retain a partial output and inspect it. Do not use the process exit as a Ready verdict.

Rendered Markdown encodes punctuation and non-ASCII text; the raw `.md` is less readable in a terminal. A literal escape-looking branch name can display like a visible control escape, so use the retained JSON for exact identity. This is limited display hardening, not a general confusable-character defense. The independent renderer observation applies to the tested Pandoc GFM version, not all host renderers.

## Bounds and reuse

The closed plan requires `schema_version: 1`, one repository, a nonempty target base of at most 256 characters without ASCII controls/DEL, and one to three unique PR rows. Unknown keys are rejected. The plan reader rejects a terminal symlink, directory, invalid UTF-8 and oversized file. It preserves the bytes read, not a concurrent-writer lock. Parent-directory symlinks in output paths are resolved for containment; this is not an OS sandbox or a defense against concurrent parent replacement.

`inspectPrStackCandidate(input, runner?, clock?)` reuses `inspectPrCandidate` unchanged. It permits at most 24 actual requests and a 270-second wall-clock collection budget. Each collector keeps its own page, response-size and 90-second limits. The wrapper checks remaining time before each actual request and shortens the runner timeout. An unstarted PR stays `not_observed`. A result arriving beyond the stack deadline is retained with a budget issue and cannot support frontier advancement. The runner must honor `timeoutMs`; an arbitrary injected runner is not forcibly cancelled, and wall-clock adjustments can affect elapsed-time limits. File writing is outside the collection budget.

No observations form an atomic transaction across PRs. A lower PR can merge immediately after it is read. Read the recorded times and per-PR head/base brackets, and obtain new evidence when your task needs current state. There is no automatic rearm, workflow retry, merge-queue assessment, historical comparison, card refresh or source-code safety verdict here.

`validatePrStackCandidateInput` allows preflight without forge access. The CLI's optional runner/clock are offline test seams and are marked in the manifest. They do not establish an authenticated producer. Tests exercise the real collector with fixture GraphQL responses, not live GitHub.

```sh
pnpm --filter @osstack/github exec vitest run src/pr-stack-candidate.test.ts
pnpm --filter @osstack/github build
node --test scripts/report-pr-stack-candidate.test.mjs
```

## Source adaptation

This independently written slice adapts the explicit check pass and lowest-unmerged frontier from Lauren Tan's MIT-licensed pstack at `99b609a72323b70204eab407c622f436e858e112`: [babysit playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/babysit.md), [watch-pr policy](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/scripts/watch-pr/policy.ts), and [LICENSE](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/LICENSE). No upstream source body is copied. Its persistent watcher, automatic advance and mutation workflows are not ported. This supports PS17/PS18/PS13 as a bounded tool; it is not a new method or completion of formal identity, recovery or supervision gates.
