---
name: neat-skill
description: "Close out repository knowledge by running osstack neat, interpreting evidence, making only authorized editorial corrections, and rechecking. Use for /neat, /sync, tidy up docs, clean up docs, update memory, sync up, close out, clean handoff, stale or conflicting docs, rule audits, 整理一下, 整理文档, 同步一下, 更新记忆, 梳理一下, 收尾, 阶段做完, 检查规范, 规范体检, or any development milestone that needs knowledge reconciliation."
---

# Neat knowledge hygiene

Act as a knowledge editor. Reconcile current repository evidence with its
instruction files and public documentation. Do not behave as an append-only
session recorder.

## Boundary

- Work only inside the repository the user placed in scope.
- Treat `osstack neat` JSON as the source of mechanical findings, inventory,
  Git classification, limits, and fingerprints.
- Do not recreate those checks with `find`, `grep`, `wc`, custom link scans, or
  hand-written Git classification.
- Do not inspect or edit external agent memory unless a later explicit neat
  surface supplies bounded evidence and the user placed it in scope.
- Do not delete files, rename paths, replace an existing instruction source,
  create symlinks, or perform other destructive actions.
- Read [references/editorial-playbook.md](references/editorial-playbook.md)
  before making editorial changes.

## Workflow

1. Resolve the target repository from the user's request; default to the
   current repository.
2. Run the built or installed CLI:

   ```bash
   osstack neat check --repo <repo> --format json --fail-on none
   ```

   If `osstack` is unavailable inside its source repository, build the CLI and
   run `node packages/cli/dist/bin.js` with the same arguments.
3. Parse the output as one strict `AgentCommandResult` envelope. Continue only
   when `status` is `ok`, `result.command` is `knowledge_hygiene.check`, and a
   v1 report is present. Treat exit 2/3, error envelopes, or malformed output as
   a blocked check—not as a clean repository.
4. Stop any clean-success claim when `completeness.complete` is false. Report
   every reason and skipped-file count.
5. Group findings by remediation:
   - `agent_edit`: inspect cited evidence and edit only when the correction is
     supported by current repository facts and within user scope.
   - `human_decision`: present observed, expected, evidence, and the smallest
     concrete choice; do not decide on the user's behalf. After the user chooses
     a resolution, use `neat review` and rerun with `--review-file`; never add a
     meaningless documentation edit to silence a review contract.
   - `safe_patch`: run `neat fix --from <report>` and show the preview. Apply
     only when the user explicitly authorizes it and repository policy permits
     `neat fix --from <report> --apply --yes`; never reproduce the write by hand.
6. Keep each edit focused. Preserve established tone and audience. Update the
   maintained source instead of creating a parallel explanation.
7. Rerun the exact same check command after edits. Never substitute a partial
   check for the final rerun.

## Completion

Report:

- edited files and the evidence that justified each edit;
- current error/warning/info/suppressed/resolved counts;
- inventory completeness;
- unresolved `human_decision`, `safe_patch`, or skipped findings;
- the rerun command and exit result.

Claim a clean close-out only when the rerun succeeded, inventory is complete,
and no active finding remains. Otherwise call the result partial or blocked.

This workflow adapts editorial concepts from the MIT-licensed `neat-freak`
skill. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
