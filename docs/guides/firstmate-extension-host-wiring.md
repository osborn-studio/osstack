# Firstmate extension host wiring

These commands add bounded local capabilities. They do not imply a configured remote machine, production message provider, or qualified shared-installation updater.

## Worker viewer

Use `osstack worker list --repo /absolute/repo --default-tenant --json` to obtain a view ID, then `osstack worker watch VIEW_ID --repo /absolute/repo --default-tenant`. The terminal displays structured snapshots for 60 seconds by default. The original token expires normally; the viewer does not renew it. Ctrl-C closes only the viewer and its socket read. This is not log tailing or a tmux/cmux backend.

## Local sources

The daemon reads only its fixed private `$OSSTACK_HOME/source-registry.json`. The registry registers typed local JSON snapshot sources with manifest and content pins, canonical repository scope, default tenant and bounded freshness, bytes, items and read time. It cannot register arbitrary executable readers or network credentials. `osstack sources inspect SOURCE_ID --repo /absolute/repo --default-tenant --json` cannot choose a path. Missing configuration is disabled; bad configuration is unknown. Neither means a healthy empty source. Sources are not automatically inserted into an agent prompt.

## Public follow-up protocol

`osstack follow-up-delivery --help` exposes prepare/list/inspect/authorize/revoke/dispatch/reconcile. The daemon's production defaults have no targets, trusted signing keys or transports. Trusted embeddings may supply those ports; RPC data cannot register them. No private signer is bundled. A reviewed Ed25519 grant binds one attempt, body, destination and short validity interval; a consumed grant is never rearmed. An uncertain send is not retried. A real provider adapter must have independently qualified single-call behavior and exact attempt-correlated lookup; it is not supplied by this slice. A locally fulfilled obligation is separate from provider delivery.

Shutdown rejects new delivery calls, waits for every admitted logical dispatch/reconcile result and its final transaction, then closes SQLite. A late underlying transport result cannot access that closed database.

## Multi-home planning

Create an explicit private journal directory. Use `osstack homes plan-upgrade --request REQUEST.json --registry HOMES.json --journal /absolute/private/journal`; use `osstack homes upgrade-status --digest PLAN_SHA256 --group GROUP_ID --journal /absolute/private/journal` to inspect it. The request pins an exact target version/build/protocol/schema, explicit groups and homes, expiry and per-group budgets. Inventory alone cannot attest all consumers of a shared installation.

The plan has `authority:none` and `qualification_pending`. The CLI does not expose apply, install, drain, restart, lock stealing, automatic replay, or database rollback. The injected coordinator and its crash tests define the next native integration contract; they do not certify a production updater. An interrupted journal remains recovery-required until authorized reconciliation can prove what happened.
