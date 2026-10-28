# Original Sonnet5.5 audit

````text
**Verdict: PASS.** I found no blockers. This is a read-through audit of the diff and file text only. I ran nothing, so it is not test proof.

**Preserved (checked line by line against the parent)**
- **Assertions:** both test bodies are identical to the originals. That covers the `reconcileForward` result matchers, the `records` equality, `starts()===4`, and the `upgrade-operation.json` and `restart-permit.json` absence checks.
- **Real processes and fixture:** `fixture()`, the two spawned consumers and the real `coordinateUpgrade` are all unchanged, with no mocks or stubs added.
- **Abort deadline:** `AbortSignal.timeout(30000)` is still created inline at the `reconcileForward` call, so it starts when recovery starts, not at setup.
- **Body budget:** each `it` keeps `30000`. Vitest hook timeouts are separate from the test timeout, so the cleanup body does not inherit the 60s.
- **Setup order and semantics:**
  - The fence test still does not call `port.complete()`, which is the premise of an unfinished fence.
  - The orphan test keeps the order `complete` → `close` → `publishPrivate(orphan)` → `status`.
  - Both previously ran `close()` unguarded and now use `try/finally`, which is strictly safer.
- **Fixture failure handling:**
  - `fixture()` pushes roots into `roots` and spawned children into `children` before anything can fail. The file-level `afterEach` still kills the children and removes the roots for nested describes.
  - A failing `expect` inside `beforeEach` still closes the port.
  - Each describe has one `it`, so a stale `f` or `status` from a prior test cannot leak.
- **Plan-expiry bound:** the fixture plan expires 120s after creation. Worst case is 60s setup plus 30s body, which is 90s, so the larger allowance cannot trip expiry. The margin is only 30s, so don't raise the hook timeout further without revisiting this.
- **Consistency:** the pattern matches the three existing completed-history cases (60s `beforeEach`, 30s body). The 60s figure also matches the whole-test budget of the other full-upgrade cases in this file, which run fixture plus a two-home upgrade plus a `complete` call.

**Non-blocking**
1. **Residual exposure.** `clears an orphan permit from another plan…` still runs fixture, full `coordinateUpgrade` and `complete` inside one 30s test. That is the same prerequisite that tripped the two repaired cases, minus the cleanup. It is lower risk, but it is the likely next flake if the cause is generic two-home slowness. I'd leave it unless it fails, since the repair is scoped to the two observed cases. `recovers a SIGKILL stale socket…` is lighter and I wouldn't touch it.
2. **Root cause stays unproven.** If the cause is a hang rather than slowness, this only moves the failure from 30s to a 60s hook timeout. The split does give free phase attribution, because the next failure will say "Hook timed out" or "Test timed out". Keep the commit message and PR text saying "allowance extension, not a fix". The fence-test comment does not repeat the sibling's "not a performance optimization" wording, but that is cosmetic.
3. **Duplicated setup.** There are now three near-identical `beforeEach` setups. A shared `verifiedFixture()` helper would remove the duplication, but that is optional style and not worth another round.
4. **Unverified Vitest behavior.** I am relying on two Vitest behaviors, which I could not confirm here:
   - A failing `beforeEach` still runs `afterEach`.
   - Hook and test timeouts are independent.
   
   Both are documented behavior and the sibling describes already rely on them, so CI for this commit should confirm it.
````
