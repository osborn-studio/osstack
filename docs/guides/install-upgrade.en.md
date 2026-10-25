# Install and upgrade OSStack

[中文](install-upgrade.md) · [Documentation index](../README.md) · [README](../../README.md)

## Release status

On 2026-10-25 (Asia/Shanghai), npm `latest` is `@osstack/cli@0.22.1`. Its source is main commit `37136bd17578865cfc965cbe814629d1a77d72e7`. The Firstmate capability work is integrated. The 24 mappings use both new and existing commands; they do not imply 24 separate subcommands.

The main CI passed: 5,779 tests passed and 7 were skipped. The macOS release run passed 5,781 tests, with 5 skipped, and all pre-publication gates. Its OIDC upload failed with E404. Publication was completed from the same commit with the maintainer's authenticated npm account. The automatic OIDC failure remains a separate release-workflow issue; do not describe that workflow run as successful.

Post-publication verification passed for all 19 public package versions, dependencies and `latest` tags. All 19 tarballs downloaded successfully and matched their registry SHA-512 digests. A public-registry install into an isolated npm prefix passed 11 installation and command checks. `loop doctor` returned `ok: true`. No remote servers were upgraded.

[Main CI](https://github.com/osborn-studio/osstack/actions/runs/40169983929) · [macOS gates and OIDC failure](https://github.com/osborn-studio/osstack/actions/runs/40169983974)

## Install or update the CLI

Use Node.js 22 LTS for the installation checks described here. On each target host, run:

```sh
node --version
npm view @osstack/cli version --registry=https://registry.npmjs.org/
npm install -g @osstack/cli@0.22.1 --registry=https://registry.npmjs.org/
command -v osstack
osstack --version
osstack --help
```

Expected version: `osstack 0.22.1`. Use `@latest` instead of `@0.22.1` when you intentionally want the newest published version. An npm installation updates only that npm prefix. Codex and Claude Code must resolve the updated executable through their own shell PATH. If they report an old version, check `command -v osstack` in their execution environment. Do not assume a CLI update restarted an existing daemon.

Check the commands you need:

```sh
osstack scout --help
osstack worker --help
osstack sources --help
osstack remote-home --help
osstack follow-up-delivery --help
osstack homes --help
```

If a just-published package returns 404, wait for registry metadata and tarballs to become available, then retry installation. Do not republish the same version to fix a read delay.

## Validate your environment

From the intended project, run `osstack doctor --workspace .` and review its findings. Run `osstack loop doctor --workspace . --json` for Loop prerequisites. A passing help command proves the CLI entry point exists; it does not prove host integration is configured.

Before replacing a production service, record its executable path, version, serving home and service manager configuration. Preserve a recoverable database backup. Use the deployment procedure for that host. Package downgrade alone does not reverse database migrations. The npm release did not upgrade remote servers.

For a development checkout or isolated experiment, create a separate home. Never point a development CLI at the production database:

```sh
export OSSTACK_SCRATCH_ROOT="${OSSTACK_SCRATCH_ROOT:-${TMPDIR:-/tmp}/osstack}"
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"
export OSSTACK_HOME="$(mktemp -d "$OSSTACK_SCRATCH_ROOT/runtime/verify-home-XXXXXX")"
chmod 700 "$OSSTACK_HOME"
```

## Live qualification still required

| Integration | Check before production use |
|---|---|
| GitHub delivery | Use a sandbox repository to verify target/body normalization and delivery receipts. |
| Remote homes | Test both hosts, pinned SSH access, disconnects and unknown-result reconciliation. |
| Worker viewers | Test the configured tmux/cmux viewer and grant-bound output access. |
| Managed upgrades | Verify the launchd installation, artifact/plan digests and recovery after interruption or power loss. |
| Live models | Verify provider login, availability, holdout evaluation, billing and process termination. |
| External follow-up delivery | Verify the host transport, exact target and signed authorization. Reconcile unknown results before any resend. |

Graph delivery remains artifact-only. This release is available to install, but these unqualified integrations are not a blanket approval for production deployment. See the [Firstmate guide](firstmate-commands.en.md) for command boundaries and the [delivery ledger](../reports/2026-10-24-firstmate-capability-completion-ledger.md) for capability evidence.
