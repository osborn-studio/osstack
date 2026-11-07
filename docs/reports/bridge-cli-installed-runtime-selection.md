# Bridge installed runtime selection

Date: 2026-11-07. Implementation model: `gpt-6.1-sol`.

Implemented the additive helper `loadBridgeRuntime` in `scripts/lib/bridge-installed-runtime.mjs`. The existing sandbox driver is unchanged. Its owner can use this helper to select an inactive installed candidate for both preflight imports and execution imports. No production acceptance gate is opened by entry selection.

## Interface

```js
import { loadBridgeRuntime } from './lib/bridge-installed-runtime.mjs';

const { runtime, core, appModule, provenance } = await loadBridgeRuntime({
  checkoutRoot: repository,
  runtimePrefix: selectedInstalledPrefix,
  expectedSourceCommit: fullExpectedCommit,
});
```

`runtimePrefix` is optional. When omitted, the helper selects checkout builds under `checkoutRoot`, which defaults to `process.cwd()`. When supplied, it must be an absolute path. An empty string, null or relative prefix is an error, not a request to use checkout mode. Installed mode does not read or depend on `checkoutRoot`.

| Result | Checkout selection | Installed selection |
|---|---|---|
| `runtime` | `packages/cli/dist/bridge-production.js` | `lib/node_modules/@osstack/cli/dist/bridge-production.js` |
| `core` | `packages/core/dist/index.js` | `lib/node_modules/@osstack/core/dist/index.js` |
| `appModule` | `packages/cli/dist/bridge-github-app.js` | `lib/node_modules/@osstack/cli/dist/bridge-github-app.js` |

Each result is the selected ESM namespace. The helper does not check export shapes, call exported functions, construct services, open databases, read authentication material, start processes, or change environment variables. It has no top-level runtime imports. Selected module bodies execute through normal Node imports only when the helper is called. The caller must trust the selected code and its imports.

The helper canonicalizes the selected root. Each entry must resolve to a regular file within that canonical root. The candidate manifest must satisfy the same containment rule. Prefix aliases and symlinks whose targets stay within the canonical prefix are supported. Symlinks into a sibling directory, even one with the same path prefix, are rejected. Missing files fail without checkout fallback.

Installed mode reads `candidate-manifest.json` and requires `source_commit` to be a full lowercase 40- or 64-character Git SHA. When supplied, `expectedSourceCommit` must use that format and must equal the declared commit exactly. Abbreviated SHAs are rejected. Checkout mode has no candidate source marker and rejects an expected commit rather than silently ignoring it. The helper does not invoke Git or claim a checkout commit from potentially stale build files.

The complete manifest and all three selected files are validated and hashed before any selected module import begins. If validation fails, none of those entries executes. Once imports begin, Node import failure can leave other selected modules already evaluated; import execution is not transactional.

## Provenance contract

```js
{
  mode: 'installed', // or 'checkout'
  root: '/canonical/selected/root',
  sourceCommit: '<full manifest source_commit>', // null for checkout
  sourceMarker: {
    path: '/canonical/selected/root/candidate-manifest.json',
    sha256: '<SHA256 of exact manifest bytes>',
  }, // null for checkout
  entries: {
    runtime: { path: '<canonical bridge-production.js>', sha256: '<exact file SHA256>' },
    core: { path: '<canonical core dist/index.js>', sha256: '<exact file SHA256>' },
    appModule: { path: '<canonical bridge-github-app.js>', sha256: '<exact file SHA256>' },
  },
}
```

Hashes use the original file bytes. The marker hash does not normalize or reserialize JSON. Paths are real paths, not the caller's symlink aliases.

This is entry-selection provenance, not a whole supply-chain attestation. It does not validate tarball hashes, every package member, transitive dependency paths, source maps, signatures, or native bindings. The accepted `docs/reports/bridge-cli-installed-release-audit.md` covers the retained candidate's tarball and package-content checks. The caller must retain both evidence sets for the same immutable release and source commit. The two ancillary loop/protocol limitations remain outside this change.

Keep the selected runtime immutable for the process lifetime. Node caches imports by URL; later file changes can invalidate the relation between newly read bytes and cached module namespaces. This helper does not provide a filesystem lock, protect against concurrent file replacement, sandbox imported code, or establish acceptance from hashes alone. It deliberately adds no cache-busting URLs, which would not isolate transitive imports.

## Integration handoff

The sandbox driver owner should select the helper output once and pass it through the preflight/execution flow. Replace the hardcoded production, App module and core imports with these namespaces. Save `provenance` in the run record and use its entry hashes instead of independently hashing checkout paths. Keep installed-prefix and expected-source options attached to that same selection; never fall back to checkout builds after a selection error.

A fresh process should select each immutable candidate. A preflight result does not qualify later execution against a different prefix. Preserve the existing sandbox repository guard, execute authorization, private scratch home, bounded effects and live acceptance lock. No driver option, activation command or deployment change is included here.

## Verification

Only the new narrow Node test file ran:

```sh
node --test scripts/bridge-installed-runtime.test.mjs
```

Result: **12 passed, 0 failed, 0 skipped**. Fixtures use `createScratchDir('tests', ...)` with explicit canonical root `/Volumes/AIMATE_WORK/tmp/osstack`; cleanup removes only each test's own allocated fixture tree. No release files or real runtime modules were imported during these tests. No new dependencies are needed.

Coverage includes:

- Installed module selection, exact entry/manifest hashes and three module evaluations.
- Checkout compatibility without a candidate manifest; installed selection independent of checkout paths.
- Invalid prefix and expected commit inputs; exact commit mismatch and SHA256 Git commits.
- Missing/malformed manifests and invalid declared commits, with no entry evaluation.
- Escape symlinks for each entry and the manifest; contained symlinks and canonical prefix aliases.
- Missing entries and directory-as-entry rejection before any import.

The initial test-first invocation failed with `ERR_MODULE_NOT_FOUND` because the helper did not yet exist. It is preserved at `/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-cli-installed-release-audit/loader-red.log`. The implemented run is preserved as `loader-tests.log` in that directory. No failed acceptance result was retried or hidden.

`node --check` passed for both new MJS files. Whitespace checks passed for all three new files. No full build, monorepo test, typecheck, dependency install, daemon, DB command, release mutation or remote operation ran. The governance docs audit remains for the parent's prepared validation checkout, which owns integration and commits. No Git write or escalation was attempted for this task.
