# Recover a foreground command Loop

Use this path only for a foreground run that started with `--local-recovery-contained`. Use a precreated worktree as `--workspace`. Native `--worktree`, adapters, daemon runs, candidate runs and external finalizers are unsupported.

The flag asserts that each command and its descendants stay in the command's process group and start no external producers. This assertion does not prove quiescence. If a command detaches a producer or starts remote work, preserve the hold until separate reviewed evidence proves that producer stopped.

The host writes a private journal under the canonical common Git directory at `osstack/local-loop-recovery/<run-id>.json`. It records command intent before spawn, process-group IDs and sanitized terminal metadata. It stores command and receipt hashes. It does not store raw commands, stdout or stderr.

For a retained run, the sealed journal records a bounded fingerprint of the selected physical worktree. The fingerprint covers HEAD, index entries, and safe changed tracked and nonignored untracked file hashes and modes. Files remain in place. The journal stores only the digest and counts/modes. It does not read ignored files or other worktrees. Sensitive file names, symlinks, submodules, more than 10,000 files, or more than 32 MiB of selected content fail closed. Such runs need another reviewed recovery procedure.

Before recovery, stop the original foreground host. Keep the workspace quarantined. Review all external producers, including any producer that could have escaped the recorded groups. Create a private evidence file with this shape:

```json
{
  "version": 1,
  "journalSha256": "<sealed journal SHA-256>",
  "runId": "<exact local_loop run ID>",
  "repoId": "<journal repo ID>",
  "workspacePath": "<journal canonical workspace path>",
  "allExternalProducersQuiescent": true,
  "workspaceQuarantined": true,
  "reviewedEvidenceSha256": "<SHA-256 of the reviewed external evidence report>"
}
```

The evidence file is an explicit operator attestation. Do not create it from PID absence or a generic command receipt alone. Keep the reviewed report with the evidence file. If any producer is ambiguous, do not attest quiescence.

Approve the exact journal and evidence-file digests:

```sh
osstack loop recover-local --workspace /path/to/worktree \
  --run-id local_loop_<uuid> \
  --approve-journal-sha256 <journal-sha256> \
  --quiescence-evidence /private/path/quiescence.json \
  --approve-evidence-sha256 <evidence-file-sha256>
```

Use the same isolated `OSSTACK_HOME` and containment-root configuration as the original run. Recovery does not open a control-plane database. It verifies the exact owner/token/run, dead host and recorded groups, approved external evidence, unchanged worktree fingerprint and exact containment marker under the native mutation guard. It writes durable release intent before clearing the marker and releasing that owner. A retry after a lost release acknowledgement needs the same journal and release intent. A replacement owner is never removed.

The graph recovery API and its registered graph proof contract are unchanged. Legacy foreground runs without a host journal remain blocked. This command cannot reconstruct a sufficient producer inventory from a historical receipt. A tooling patch does not authorize rollout of an installed runtime or release of a live legacy lease.
