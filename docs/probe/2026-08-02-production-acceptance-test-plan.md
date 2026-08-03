# Probe Production-Acceptance Test Plan

Status: report-only evidence collection

Probe session: `probe_9bce3f19-3a7b-4a46-b745-0b6a1e9d2a62`

## Owner-approved evidence contract

The owner accepted this mapping on 2026-08-03:

> 全新安装以安装记录和 CLI/daemon 版本一致性为证；doctor 以无阻塞项的 JSON 结果为证；Neat 以修复前后快照、ReportV2、事务回执和复扫结果为证；Probe 以 ledger、render manifest 及 live/fresh-home gate 一致性为证；安全边界以文件哈希、写入白名单、凭证哨兵和日志扫描结果为证。

The acceptance runner must preserve the command, exit code, source revision,
package versions, start/end timestamps, environment-variable names (never
values), and SHA-256 for every retained artifact. A rerun on the same source
revision must evaluate the same machine-readable pass criteria.

## Obligation-to-evidence matrix

| Obligation | Repeatable execution | Required evidence | Machine-readable pass criteria |
|---|---|---|---|
| Fresh installation and CLI/daemon version parity | `pnpm smoke:npm-install` in the release candidate revision | Pack/install inventory and the smoke result JSON | `installed_version_handshake.matched` is `true`; `cli_version` exactly equals `daemon_version`; no package is loaded from the source checkout |
| Doctor has no blocking finding | The installed-package doctor and npm release doctor stages inside `pnpm smoke:npm-install` | Unmodified JSON results from both doctor stages | Product doctor is successful; npm publish readiness is `true`; publish assets are `ok`; command exit code is zero |
| Neat discovers and safely repairs knowledge-hygiene findings | `pnpm smoke:neat` plus a disposable dirty fixture scanned before and after an approved `neat fix` or recoverable transaction | Before/after file-hash manifests, full ReportV2, preview result, policy decision, apply receipt, transaction receipt when applicable, and post-fix ReportV2 | The intended finding exists before repair and is absent or resolved after repair; unrelated file hashes do not change; the receipt identifies every allowed write; the post-fix scan is complete |
| Neat semantic behavior remains repeatable | `pnpm eval:neat-goldens` and `pnpm eval:neat-parity:offline` | Golden and parity reports bound to the corpus lock and source revision | Both commands exit zero and their reports contain no unreviewed regression |
| Probe produces portable, auditable artifacts | `pnpm smoke:probe`, `pnpm smoke:probe-skill`, then CLI rendering for each real session | `ledger.json`, `ledger.md`, delta files, `render-manifest.json`, and the render result | Manifest hashes match every rendered file; exported revision equals the ledger revision; no artifact was edited outside the CLI render path |
| Probe live and fresh-home gates agree | Run the configured report-only gate against the live session, then run the same policy against the rendered `ledger.json` from an isolated home without the source SQLite state | Both complete gate JSON results and isolated-home metadata | Both results expose the same readiness vector and violation codes; report mode does not deny the workflow; neither run mutates the rendered bundle |
| No unauthorized write or credential disclosure | Wrap each acceptance run with the security controls below | Before/after hashes, declared write allowlist, synthetic credential-sentinel result, and redacted log-scan result | Every changed path is allowlisted; the sentinel is absent from stdout, stderr, reports, receipts, and rendered artifacts; no real credential value is retained |

## Security controls

1. Run destructive-path tests only in a disposable fixture or isolated
   `OSSTACK_HOME`; the stable control-plane home is read-only to the harness.
2. Create the write allowlist before execution. New or modified paths outside
   it fail the run even when the product command exits zero.
3. Use a clearly synthetic credential sentinel. Never place a real provider,
   npm, GitHub, or signing credential in test data or evidence.
4. Hash the fixture before and after the run and retain the normalized path
   diff. Hashes are evidence; copied source contents are not required.
5. Scan stdout, stderr, reports, receipts, and Probe artifacts for the sentinel
   and credential-like values. Retain only the redacted finding category and
   path if a scan fails.
6. Reject symlink escapes, absolute paths outside the fixture, and undeclared
   network or provider access.

## Evidence-bundle layout

Each qualifying run writes a new immutable directory under
`docs/probe/evidence/<UTC-date>/<run-id>/` containing:

- `run.json`: schema version, source revision, commands, exit codes,
  timestamps, package versions, machine class, and environment-variable names;
- `hashes-before.json` and `hashes-after.json`;
- `write-allowlist.json` and normalized `write-diff.json`;
- the product-specific JSON reports and transaction receipts;
- `security-scan.json` with redacted results; and
- `manifest.json` with SHA-256 and byte length for every other retained file.

The evidence directory is append-only after its manifest is written. A failed
run remains evidence and must not be replaced by a later successful run.

## Program-level acceptance gate

One successful run does not complete production acceptance. The final claim is
allowed only after all obligations above pass and the program in
`2026-08-02-production-acceptance-intent.md` also has real evidence for:

- fourteen elapsed days of report-only use without an agreed false-blocking
  incident;
- five qualifying rough-spec Probe E2Es;
- the human `probe restate` false-positive audit; and
- an owner-approved outcome baseline.

Missing paid-provider credentials, npm owner authentication, elapsed time, or
human review must be reported as an external constraint. They must never be
replaced with fabricated evidence or an agent attestation.
