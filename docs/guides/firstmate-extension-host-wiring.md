# Firstmate extension host wiring

These commands add bounded local capabilities. They do not imply a configured remote machine, production message provider, or qualified shared-installation updater.

## Worker viewer

Use `osstack worker list --repo /absolute/repo --default-tenant --json` to obtain a view ID, then `osstack worker watch VIEW_ID --repo /absolute/repo --default-tenant`. The terminal displays structured snapshots for 60 seconds by default. The original token expires normally; the viewer does not renew it. Ctrl-C closes only the viewer and its socket read. For a separately authorized persisted-output view use `worker logs --grant-file`; `worker open` creates a new pinned tmux/cmux observer. See [viewer and evaluation guide](paired-routing-and-worker-observers.md) for private host configuration and the distinction between launch request and qualified backend operation.

## Local sources

The daemon reads only its fixed private `$OSSTACK_HOME/source-registry.json`. The registry registers typed local JSON snapshot sources with manifest and content pins, canonical repository scope, default tenant and bounded freshness, bytes, items and read time. It cannot register arbitrary executable readers or network credentials. `osstack sources inspect SOURCE_ID --repo /absolute/repo --default-tenant --json` cannot choose a path. Missing configuration is disabled; bad configuration is unknown. Neither means a healthy empty source. Sources are not automatically inserted into an agent prompt. `sources observe/events/acknowledge` maintains generation/sequence evidence; explicit host `source-context.json` permits bounded prompt insertion. See [source context](local-source-context.md).

## Public follow-up protocol

`osstack follow-up-delivery --help` exposes prepare/list/inspect/authorize/revoke/dispatch/reconcile. The daemon defaults to disabled until the operator provisions a private fixed host registry and credentials. It now loads the production GitHub transport from that registry; RPC data cannot register targets or keys. The local interactive `issue-grant` command requires an operator-provisioned private key. A reviewed Ed25519 grant binds one attempt, body, destination and short validity interval; a consumed grant is never rearmed. An uncertain send is not retried. The GitHub adapter uses an immutable subject ID and exact actor/body/attempt receipt lookup. Its real sandbox qualification remains separate from local HTTP fault tests; see [GitHub delivery](follow-up-github-delivery.md). A locally fulfilled obligation is separate from provider delivery.

Shutdown rejects new delivery calls, waits for every admitted logical dispatch/reconcile result and its final transaction, then closes SQLite. A late underlying transport result cannot access that closed database.

## Multi-home planning

Create an explicit private journal directory. Use `osstack homes plan-upgrade --request REQUEST.json --registry HOMES.json --journal /absolute/private/journal`; use `osstack homes upgrade-status --digest PLAN_SHA256 --group GROUP_ID --journal /absolute/private/journal` to inspect it. The request pins an exact target version/build/protocol/schema, explicit groups and homes, expiry and per-group budgets. Inventory alone cannot attest all consumers of a shared installation.

The plan has `authority:none` and `qualification_pending`. Planning remains authority-free. Separate managed-installation commands now expose provision/apply/reconcile using exact pinned bundles, consumer identity and durable recovery. They never perform database rollback or automatic replay of an unknown attempt. Native local process tests do not certify production launchd or user homes; see [managed upgrade](managed-native-upgrade.md). An interrupted journal remains recovery-required until authorized reconciliation can prove what happened.
