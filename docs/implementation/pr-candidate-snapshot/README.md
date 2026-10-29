# One read-only PR candidate snapshot

This tool reads one GitHub PR once. It reports the observed checks, review threads and integration state against a bracketed head/base pair. It does not watch, retry, execute candidate code, change Ready status, approve or merge. A report is not a merge authorization.

Build `@osstack/github` first. Use the existing authorized `gh` configuration. No credentials are copied or printed by this tool. Create an output parent under `OSSTACK_SCRATCH_ROOT`, then choose a new output directory:

```sh
pnpm --filter @osstack/github build
node scripts/report-pr-candidate.mjs \
  --repo osborn-studio/osstack --pr 306 \
  --output "$OSSTACK_SCRATCH_ROOT/runtime/pr306-snapshot-NEW"
```

The PR number is an example, not a frozen current candidate. Pass `--expect-head SHA40 --expect-base SHA40` together to detect a mismatch with your intended candidate. Pass repeated `--required-check NAME` only for requirements you actually know. Without names, requirements stay unspecified. A skipped paid job is not silently converted to success. The tool does not discover branch protection, rulesets or merge queue policy.

## Result and limits

- Exit **0** means the report was written. Its summary can still be `blocked`, `waiting`, `unknown` or `candidate_changed`.
- Exit **2** means input or output preflight refused the request. No forge call is made. A missing package build also refuses before calls.
- Exit **3** means initial PR identity was unavailable or the report could not be written. An unavailable initial query is retained when output is writable.

A favorable summary is `no_observed_blocker`, never Ready or permission to merge. `merge_authorized` is always false. All observed failures remain visible, including failures outside the caller's required-name list; they are not represented as discovered branch-protection requirements. Missing or duplicate required names, skipped/neutral conclusions and unknown values do not count as green. Blockers, waiting reasons and unknowns are separate arrays, so a primary summary cannot erase other observations.

Initial and final facts include head/base SHA, branch names, state, draft status, review decision and mergeability. Check pages use the initial head SHA. Thread pages use the PR identity. A changed head/base or branch name, or mismatched expected pins, prevents a current consolidated favorable result. Stable pins do not create an atomic transaction: reviews and checks can change immediately after a read. Individual approvals are not bound to a commit here, and the workflow's evaluated merge commit is unknown.

Each connection is limited to three pages of 100 rows. There are at most eight requests, each with a timeout at most 10 seconds and a 90-second collection budget. The reused default delivery runner bounds each subprocess stream at 16 MiB. The collector accepts JSON responses up to 1 MiB after the subprocess returns; that smaller limit is not a subprocess memory bound. It makes no retry. Null/partial/invalid data, failed commands, pagination gaps, repeated cursors, wrong OIDs and exhausted bounds remain unknown or incomplete. Prior valid rows remain available. Review comment bodies are not requested.

The output contains `snapshot.json`, `queries.json`, fixed-label `raw/*.stdout` and `raw/*.stderr`, and a manifest with member byte lengths and SHA-256 hashes. Output must be new and under the configured scratch root; its parent must exist. Directory/file permissions are 0700/0600. Existing paths and terminal symlinks refuse. This is not an OS sandbox or a claim against concurrent parent-directory replacement. Raw responses may contain private repository metadata; retain them within the authorized task's evidence scope. Environment values are not serialized. Hashes bind the retained bytes, not forge authenticity.

## Reuse and testing

`inspectPrCandidate(input, runner?, clock?)` and its types are implemented in `packages/github/src/pr-candidate-snapshot.ts`. `validatePrCandidateInput` lets the script validate before it creates output. The script loads that package's built module directly. The optional `DeliveryCommandRunner` is an offline test seam; the manifest identifies `injected_runner` rather than presenting it as a live forge read. Production uses `defaultDeliveryCommandRunner` with its prompt-disabled, allowlisted authentication environment.

Use focused tests and the package build:

```sh
pnpm --filter @osstack/github exec vitest run src/pr-candidate-snapshot.test.ts
pnpm --filter @osstack/github build
node --test scripts/report-pr-candidate.test.mjs
```

These fixture tests cover identity drift, current-state changes, independent blockers, required-check ambiguity, incomplete pagination, unavailable data, request bounds and new-directory evidence retention. They do not prove live GitHub policy coverage or model behavior. A separately authorized live read must record its actual candidate and results. No live request is implied by the example above.

## Sources and adaptation

The flow is independently expressed from pstack at commit `99b609a72323b70204eab407c622f436e858e112`:

- [`babysit.md`](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/babysit.md): reconcile conflict, reviews and CI against current forge facts.
- [`opening-a-pr.md`](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/opening-a-pr.md): opening a PR and ongoing supervision are distinct operations.
- [`watch-pr/github.ts`](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/scripts/watch-pr/github.ts) and [`policy.ts`](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/scripts/watch-pr/policy.ts): paged observations and distinct review/CI/integration states.

Upstream pstack is by Lauren Tan, MIT licensed; see its pinned [LICENSE](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/LICENSE). No upstream source body is copied into this implementation. The upstream watcher, retry policy and mutation workflow are not ported. This slice supports PS17/PS18 and PS13 evidence attribution; it is not a new method, event supervisor, formal gate or completion of those whole capabilities.
