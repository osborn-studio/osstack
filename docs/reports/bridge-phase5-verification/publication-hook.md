# Sandbox publication-hook fixture

This module closes the placement gap in the sandbox fixture, not the real 5-G acceptance gate. It has no production package export, performs no I/O, and never invokes or replaces a fence. No real Codex process or remote request was used for these tests.

## Stable interface

```js
import { installRevisionPublicationHook } from './lib/bridge-sandbox-publication-hook.mjs';

// Install before createProductionLiveBridge captures the publication adapters.
const restore = installRevisionPublicationHook(ports, {
  async onBeforePush({ missionId, intentId }) {
    if (missionId !== revokedChild) return;
    // Driver verifies the real child is delivering and this intent is pending.
    await removeFixtureAuthorityWriteScopes();
  },
});
// Driver cleanup disables its bridge before invoking the idempotent restore().
```

Only the frozen white-listed object `{missionId,intentId}` reaches the callback. The callback's return value grants no authority. It runs for a genuine `git push` invocation with a valid `git_push` gate, mission id and intent id; normal `-c` hardening prefixes are recognized. Other commands pass through without a callback.

The wrapper awaits revocation before calling the original adapter runner. Command, argument-array, options and gate identities are preserved, and the original runner receives its original `this` (including frozen class instances with private fields). `preflight` and `localGit` keep their original function references. The original runner remains responsible for transport configuration, token acquisition, spawn and the real W13 release fence.

The helper refuses ungated runners and invalid factory/options/command frames, including missing or mismatched intent ids, missing fence/mission, invalid timeout/signal and sparse argument arrays. It rechecks the original gated marker after the asynchronous callback. It never upgrades an ungated runner. Restore reinstates the exact original factory, removes an inherited-property shadow, and disables callbacks on already captured wrappers; an in-flight factory completed after restore returns its original adapters.

## Evidence

- Initial TDD red: helper module absent (`$OSSTACK_SCRATCH_ROOT/runtime/bridge-publication-hook-red.log`).
- A new sparse-argument negative case failed before argument validation was repaired (`bridge-publication-hook-args-red.log`).
- `node --test scripts/bridge-sandbox-publication-hook.test.mjs`: **40 passed, 0 failed**, about 53ms. Fakes assert one original invocation, unchanged gate/fence, no callback on reads/other commands, asynchronous ordering, strict invalid-input refusal and restoration.
- The fake original launcher, not the hook, calls the unchanged fence after revocation; the fence rejects and the fake release count remains zero. This is a sequencing unit test, not a real W13 receipt.
- Source-bound final log: `$OSSTACK_SCRATCH_ROOT/runtime/bridge-publication-hook-source-bound.log`, exit 0, stable before/after source hashes on Node v26.5.0. Its SHA256 is `652dfe2e46238aef1190bf4f70f19449abab1fa075108f48aabb0fed5c1d1947`.
- Helper SHA256: `80cb2ee71e0a589003e65a818d9e3a2028cf66677419f1ef5354d0209202676a`.
- Test SHA256: `3f9d19c8179a796e5a37eb3ca3dc96dce619bab0efaea0b10920eb28e0f5b2f9`.

## Driver-owned remaining assertion

The driver must target its specific revoked child, observe a real `delivering` child and `pending` intent in the callback, then remove the fixture authority's write scopes. After the real runner/W13 fence refuses, it must check the actual intent-bound journal row has `released_at === null`, the intent failed, and the remote head did not change. Only that integration evidence can remove the late-revocation `required_gap`; this helper's fake tests alone cannot. Production, the sandbox driver, both property suites and the running TLA model were left unchanged by this module.
