# Agent access to OsbornSkillHub

OSStack already publishes Hub-managed catalog assets to `https://api.osbornhub.com` through `osstack hub publish`. The route is local Hub promotion → catalog Git commit/push → GitHub Actions deployment → API version polling. The inspected Hub API source exposes read routes, not a persistent HTTP upload handler. API read authorization and catalog publishing authorization are separate.

## Diagnose before changing permissions

Run the installed CLI on the **actual publisher host**:

```sh
osstack --version
osstack hub doctor --json
```

Development checkouts must use a fresh explicit `OSSTACK_HOME`; never open the production control-plane database. Doctor runs no Git commands, does not execute the discovered companion scripts, and does not modify configuration or publish data. It checks only local prerequisites and a fixed HTTPS GET health endpoint with a five-second request timeout and redirects disabled. It does not establish the scripts' trustworthiness or verify their contract/version. A configured report is not authorization.

| Result | Meaning / action |
| --- | --- |
| `no_hub_root` | Set `OSSTACK_HUB_ROOT` to the owner's trusted Hub checkout; `HUB_ROOT` is a fallback. |
| `publisher_missing` / `candidate_tool_missing` | Install/update the reviewed Hub companion tooling. |
| `catalog_missing` | Configure `CATALOG_DIR`; default is the Hub checkout's sibling `osborn-skill-catalog`. |
| `api_missing_key` | Configure the read credential in the publisher runtime using `SKILL_HUB_KEY` or its existing owner secret file. Do not paste it into an agent prompt. |
| `api_unauthorized` | The health endpoint rejected the supplied read credential (401/403). This says nothing about Git write access. |
| `api_http_error` / `api_unreachable` / `api_unexpected_response` | Diagnose service, network, redirects or unexpected health content. |
| `publish_permission: unverified` | Expected: no write attempted, no principal provisioned. |

For older installed versions without doctor, inspect `osstack --help` and the environment above. Do not interpret `unknown_subcommand` as "there is no upload route."

## Onboard maomaobdm

The requested name has not yet been bound to a machine or authenticated principal. Required owner input is the runtime host/framework or configuration entry point. On that host, bind the actual identity—not merely a `maomaobdm` string—to the intended catalog repository and publishing scope.

Recommended boundary: keep Git and Hub read credentials in a trusted publisher worker. Let the external agent submit a reviewable catalog change using a dedicated GitHub App or machine principal scoped to the selected repository, and let existing repository policy/CI determine publication. Namespace restrictions require enforcement in the worker/CI; a repository-scoped token by itself does **not** restrict directory or namespace writes. Do not claim such a worker or per-agent ACL exists until it has been implemented and verified on the actual host.

For direct CLI use on a trusted host, the prerequisites are the reviewed OSStack/Hub installations, the correct catalog checkout, its authenticated Git identity and allowed branch policy, the Hub store, and the API read credential. Adding an OSStack agent display name does not grant GitHub permissions. Do not hand out a shared owner credential as an agent-specific grant.

Record the actual provider/issuer (for example GitHub), principal/App installation, target repository, allowed operations/namespace, credential owner, expiry/revocation mechanism and audit destination at onboarding. Never store secret values in this record.

## Publish and recover

For an existing catalog-managed asset and authorized publication:

```sh
osstack hub publish <asset-id> --gate team --surfaces api --json
```

For a new external source, `osstack hub candidate <asset-path> --namespace organization/<id> --json` registers an exact Git source reference only. It does not copy files into the catalog or create a deployable release; finish the Hub's intake/review workflow before publishing.

Only `--surfaces api` is supported by the current companion. Other surfaces fail before any process is started. Success requires child exit 0, the requested asset ID, and explicit `pushed: true` plus `apiVerified: true`. These booleans are **companion-reported**, and verification scope is its API **version** check, not independent content digest verification.

- `pushed_unverified`: a push was reported but online version verification was not confirmed. Inspect existing CI and API state before retrying; do not announce completion.
- `local_only`: the companion reports no push. Inspect the catalog's local changes and remote before deciding whether to retry.
- `unknown`: incomplete legacy evidence, mismatched ID, or failed child exit. Do not treat as an upload receipt.
- Booleans may be `null` when the companion supplied no valid evidence. Error responses preserve these fields for recovery; the wrapper never automatically retries.

The Hub companion's `--dry-run` / `--no-push` still performs promotion and may commit locally. They are **not** read-only diagnostics. Likewise, `git push --dry-run` may run hooks and cannot prove all server branch rules will accept a real push; doctor intentionally does not use it.

## Acceptance on the real agent

Before claiming access enabled: identify and bind the real principal; run doctor from its runtime; submit an owner-selected test asset through the approved route; observe the catalog change/CI and authenticated API result; confirm the exact asset/version and the agent's audit attribution. Check that unauthorized repositories/namespaces are denied by the actual enforcing component, and verify revocation. No real asset has been published and no maomaobdm grant has been installed by this diagnostic change alone.
