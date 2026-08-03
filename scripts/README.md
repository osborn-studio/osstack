# osstack/scripts

Operational helpers that live outside the daemon hot loop.

| Script | What it does |
|---|---|
| `demo-loop.mjs` | Creates an inspectable temporary Node.js workspace, starts with a failing test, runs the built CLI through one Loop task, and leaves `STATE.md` / `LOOP-STATE.json` for manual review. |
| `demo-loop-daemon.mjs` | Starts an isolated real daemon, queues the same failing-test repair through `loop start --once`, waits for completion, and leaves the workspace plus daemon home for inspection. |
| `smoke-loop.mjs` | Builds confidence in the Loop Engineering MVP by running the built CLI against temporary local, `loop doctor`, git-worktree, `ds-review` adapter, daemon-managed once/goal/schedule/recovery/stats, and legacy `osb-loop` shim workspaces. |
| `smoke-knowledge-cloud.mjs` | Starts the built Knowledge Cloud service on a dynamic port, verifies official/private packs, sync/search/feedback/publish/audit, and runs the built CLI `release doctor --target knowledge-cloud --cloud-url <local-url>` health/search/sync/audit handoff gates. |
| `smoke-knowledge-cloud-deploy-assets.mjs` | Verifies Docker/EdgeOne/Render/GitHub Actions deployment assets agree on the Knowledge Cloud executable, port, `/healthz`, persisted published packs, feedback JSONL, audit JSONL, EdgeOne Makers CLI deploy, and the optional deploy hook fallback. |
| `prepare-npm-package.mjs` | Writes a package-local `dist/.npmignore` before packing so compiled test/spec artifacts stay available locally but cannot leak into a published tarball. |
| `smoke-npm-install.mjs` | Packs workspace packages, rejects any tarball containing compiled test/spec artifacts, installs them through npm into a temporary global prefix, then verifies CLI/daemon version parity, installed CLI doctor/release doctor, launchd dry-run, cockpit TUI, deliver/proof validation, knowledge eval, Knowledge Cloud package loading, sync, and local fallback. |
| `smoke-npm-package-artifacts.mjs` | Uses an isolated fixture to prove runtime/type entries remain publishable, compiled test/spec entries are excluded, and symlinked output directories are rejected. |
| `smoke-npm-registry-skew.mjs` | Compares every public workspace version with npm, blocks local version regressions, packs only unpublished candidates, and installs those candidates together with the real registry CLI dependency graph. |
| `smoke-npm-preflight-access.mjs` | Simulates npm `E403 Forbidden` local scope access and verifies the recovery preflight distinguishes local bootstrap permissions from normal OIDC publishing. |
| `smoke-npm-package-bootstrap.mjs` | Verifies the Trusted Publishing bootstrap gate detects unpublished public packages while ignoring private workspace packages. |
| `smoke-npm-trusted-publishers.mjs` | Verifies the read-only npm trust preflight detects configured, missing, and mismatched GitHub Trusted Publisher mappings without live npm access. |
| `publish-packages-safely.mjs` | Publishes public workspace packages through npm Trusted Publishing in deterministic dependency-first order, stops on the first failure, and emits Changesets v1 tag announcements/events only for successful publishes. |
| `smoke-npm-publish-order.mjs` | Proves dependency ordering, cycle rejection, fail-stop behavior, published-version recovery, and delegated-auth log redaction without contacting npm. |
| `smoke-release-plan.mjs` | Runs the built CLI `release plan --target all`, verifies JSON and Markdown runbooks, and asserts validation, publish/deploy, and post-release validation command coverage. |
| `smoke-single-binary-release-pack.mjs` | Builds a local single-binary release archive, verifies checksum/SBOM/extracted binary behavior, and runs the built CLI `release doctor --target single-binary` release asset gate. |
| `symphony-watch.sh` | One-shot: check openai/symphony drift against blessed_sha. Read-only by default; `--pull` fetches, `--bless` re-pins. |
| `symphony-cron-runner.sh` | Designed for Hermes/system cron. Wraps `symphony-watch.sh --pull` and fires `notify-osborn.py` if drift detected. Always appends to `~/.osstack/logs/symphony-watch.log` so cron runs are auditable. |
| `notify-osborn.py` | Multi-channel notifier. Tries email → hermes → local in order. Reads creds from macOS Keychain; gracefully degrades if creds missing. |

## Cron registration (Hermes)

Already installed once. Re-install:

```bash
# Wrapper required because Hermes refuses absolute paths and symlinks
cat > ~/.hermes/scripts/osstack-symphony-watch.sh <<'WRAPPER'
#!/usr/bin/env bash
exec bash /Users/osborn/Developer/osbstack/scripts/symphony-cron-runner.sh "$@"
WRAPPER
chmod +x ~/.hermes/scripts/osstack-symphony-watch.sh

hermes cron create \
  --name osstack-symphony-watch \
  --no-agent \
  --script osstack-symphony-watch.sh \
  '0 9 * * 1'
```

Currently registered: job `20c51757f03f`, schedule `0 9 * * 1` (Mon 09:00 local).

Manage:

```bash
hermes cron list                            # see all jobs
hermes cron run 20c51757f03f                # trigger once on next tick
hermes cron tick                            # force scheduler tick immediately
hermes cron pause 20c51757f03f              # disable
hermes cron resume 20c51757f03f             # re-enable
hermes cron remove 20c51757f03f             # delete
```

## Email setup (one-time, optional)

The notifier defaults to **stderr + ~/.osstack/logs/notifications.log only** if no email credentials are configured. To enable Gmail SMTP delivery to `gilberthello@gmail.com`:

```bash
# 1. Create a Gmail App Password (requires 2FA enabled on the sender account)
#    https://myaccount.google.com/apppasswords

# 2. Store the 16-char app password in macOS Keychain
security add-generic-password \
  -a gilberthello@gmail.com \
  -s osstack-notifier-smtp \
  -w 'xxxx xxxx xxxx xxxx'

# 3. Export env vars (add to ~/.zshrc or wherever your shell starts from)
export OSSTACK_NOTIFY_FROM="gilberthello@gmail.com"
export OSSTACK_NOTIFY_TO="gilberthello@gmail.com"

# 4. Re-test
python3 ~/Developer/osbstack/scripts/notify-osborn.py \
  --subject "osstack email test" --body "if you see this, smtp is wired" --only email
```

If the sender and recipient are different Gmail accounts, store the **sender's** app password under the **sender's** address in step 2.

## Log files

- `~/.osstack/logs/symphony-watch.log` — every cron tick (no-drift entries + drift entries)
- `~/.osstack/logs/notifications.log` — every notification fired, all channels
