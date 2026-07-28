# Kimi Profile Routing Runbook

Use this runbook to configure and verify the Phase B local delivery path:
Claude Code builds, Kimi Code independently evaluates, and osstack remains
local-only until a later phase explicitly authorizes remote Git operations.

## Safety boundary

- Never put API keys, OAuth tokens, cookies, session data, or executable paths
  in this file or in `config.yaml`.
- `guarded-local` requires a Git worktree, a verification command, strict
  governance, distinct Builder and Evaluator adapters, and proof artifacts.
- It does not push, create a pull request, merge, deploy, or modify a remote.
- If routing, identity, verification, governance, or proof is unavailable, the
  run must stop closed before promotion.

## Mac Mini configuration

Initialize the user configuration if it does not exist:

```bash
osstack config init
```

Set `~/.osstack/config.yaml` (or the path in `OSSTACK_CONFIG`) to the following
non-secret configuration:

```yaml
version: 1
active_profile: mac-mini
agent_runtime:
  claude-code:
    provider_id: anthropic
    model_id: claude-current
    agent_profile: claude-code-native
  kimi-code:
    provider_id: kimi
    model_id: kimi-code/k3
    agent_profile: osstack-kimi-review
profiles:
  mac-mini:
    match:
      hostnames: []
      model_hints: [Macmini]
    roles:
      coding:
        primary: claude-code
        fallback: [codex-cli]
      test-verify:
        primary: kimi-code
        fallback: [codex-cli, claude-cli]
      design:
        primary: claude-design
        fallback: [google-stitch]
defaults:
  roles:
    coding:
      primary: claude-code
      fallback: [codex-cli]
    test-verify:
      primary: kimi-code
      fallback: [codex-cli, claude-cli]
    design:
      primary: claude-design
      fallback: [google-stitch]
```

Runtime identity must describe what actually executes. If Claude Code or Codex
is configured to use K3, update its `provider_id` and `model_id` honestly. That
declaration does not make it independent and does not replace the dedicated
`kimi-code` adapter. A guarded delivery must still prove that Builder and
Evaluator use distinct adapters; stricter gates may also require reported
provider/model independence.

## Build before smoke

From the repository root:

```bash
corepack enable pnpm
pnpm install
pnpm --filter @osstack/agents build
pnpm --filter @osstack/config build
pnpm --filter @osstack/cli build
```

Always rebuild current `dist` before invoking the packaged `osstack` binary.

## Isolated configuration smoke

Use a disposable development home so the check cannot mutate the installed
operator configuration:

```bash
export OSSTACK_SMOKE_HOME="$PWD/.tmp/osstack-profile-smoke"
test ! -e "$OSSTACK_SMOKE_HOME"
mkdir -p "$OSSTACK_SMOKE_HOME"
cp "${OSSTACK_CONFIG:-$HOME/.osstack/config.yaml}" \
  "$OSSTACK_SMOKE_HOME/config.yaml"
OSSTACK_HOME="$OSSTACK_SMOKE_HOME" \
  node packages/cli/dist/bin.js config show --profile mac-mini
OSSTACK_HOME="$OSSTACK_SMOKE_HOME" \
  node packages/cli/dist/bin.js config doctor --profile mac-mini
```

Use the explicit `dist/bin.js` path for development smokes.
`pnpm --filter @osstack/cli exec osstack` may fall through to an older
machine-installed `osstack` when the package does not expose its own bin to
that execution context.

Pass only when all of the following are true:

- `coding` resolves to `claude-code` or an explicitly configured fallback.
- `test-verify` resolves to `kimi-code`.
- Builder and Evaluator adapter ids differ.
- Each selected role reports adapter, provider, model, profile, and evidence
  source.
- No credential or arbitrary environment value appears in output.

An unavailable Kimi adapter is not an approval failure: contract approval only
authorizes immutable argv. It becomes a fail-closed execution result when no
independent Evaluator can be resolved.

## Contract-gated delivery

Register and onboard the target repository first, then create a contract:

```bash
osstack start "Describe the bounded change" \
  --repo-id <registered-repo-id> \
  --profile mac-mini \
  --risk medium \
  --json
```

Review and commit the generated `.osstack/contracts/<contract-id>.md`, fill in
all TBD sections, and approve it through the authenticated human control
surface. The approved raw argv must contain exactly one occurrence of:

```text
--autonomy guarded-local --worktree --profile mac-mini
```

Do not edit the emitted argv. A contract created before profile binding has no
valid route and must be stopped and re-created for re-signing.

## Guarded-local fixture smoke

Run only in a disposable copy:

```bash
export OSSTACK_FIXTURE="$PWD/.tmp/greeting-fixture"
test ! -e "$OSSTACK_FIXTURE"
mkdir -p "$OSSTACK_FIXTURE"
cp -R "$PWD/fixtures/guarded-local/." "$OSSTACK_FIXTURE/"
git -C "$OSSTACK_FIXTURE" init -b main
git -C "$OSSTACK_FIXTURE" add .
git -C "$OSSTACK_FIXTURE" \
  -c user.name="osstack smoke" \
  -c user.email="osstack-smoke@example.invalid" \
  commit -m "test: seed guarded-local fixture"
OSSTACK_HOME="$OSSTACK_SMOKE_HOME" \
OSSTACK_AUTOAPPROVE=1 \
  node packages/cli/dist/bin.js deliver \
  "Add a tested greeting helper" \
  --workspace "$OSSTACK_FIXTURE" \
  --profile mac-mini \
  --autonomy guarded-local \
  --verify "node --test" \
  --worktree \
  --json
```

`OSSTACK_AUTOAPPROVE=1` grants the headless Claude Builder permission to edit
and run the verification command. Set it only on the single guarded-local
invocation after human approval, never as a persistent shell or daemon
environment variable. Without it, Claude's SDK runs with tools disabled and
cannot implement the contract.

Pass only when:

- Builder and Kimi Evaluator ids and runtime identities are both present and
  independent.
- The deterministic verification and structured Kimi review pass.
- Governance is strict and has no blocking finding.
- Report, scorecard, proof directory, proof archive, and proof manifest exist.
- No remote push, pull request, merge, or deployment occurred.

Preserve the JSON result and proof manifest as promotion evidence. Remove the
two disposable `.tmp` directories after evidence has been copied to the
authorized evidence location.

## Fail-closed triage

| result code | operator action |
|---|---|
| `verify_profile_missing` | Supply the repository's CI-equivalent `--verify` command or add a supported test script. |
| `git_worktree_required` | Re-run only in a real disposable Git worktree. |
| `profile_routing_failed` | Restore the selected Builder and an independent Evaluator; do not substitute the same adapter. |
| governance blocked | Fix the reported finding and start a new bounded run. |
| proof/artifact failure | Treat the run as unpromotable; retain logs and regenerate the complete proof set. |

Do not bypass these outcomes with `--autonomy legacy`. Legacy remains a
compatibility path and is not authorized by a Phase B execution contract.
