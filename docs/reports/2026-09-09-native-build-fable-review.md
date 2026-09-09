# Native dependency build policy — Fable challenge

Actual two-round invocation: `claude-fable-5-1`, CLI JSON output; both responses `is_error=false`, `modelUsage` contains `claude-fable-5-1`. Claude CLI also reports Haiku auxiliary usage; it was not substituted for the requested reviewer. Tool-less, safe mode, empty MCP, no session persistence, neutral temporary working directory. Only newly written generic design text was sent; no repository source, configuration or audit exports.

## Decisions after challenge

- Adopt: force built-in dispatch with `pm` as argv[0]; reject empty/ranged/missing/duplicate selectors; bind package/version, tarball integrity and all dependency input hashes. Test same-name second versions and root command shadows.
- Adopt: separate build command completion from functional proof. Cold smoke executes a SQLite query and esbuild transform in candidate and replay. Each gets a separate new store and copied package files.
- Correct with pnpm 11.4 evidence: `rebuild --ignore-pnpmfile` is rejected; `--config.ignore-pnpmfile=true` is required. pnpm 10 package-manager flags suggested in round one are obsolete; existing 11.4 `pm-on-fail=error`, runtime checks and disabled Corepack network remain.
- Decline unnecessary restriction: exact selectors correctly exclude another version of the same package, so multiple locked versions are allowed. All installed peer variants of a selected name/version are in scope; the selected tarball is bound through the v9 packages entry.
- Existing controls: fresh HOME/XDG environment and child-env allowlist, no repository npmrc, bounded workspace settings, no pnpmfile, no implicit pre-gate install, Git snapshot plumbing with hooks/fsmonitor/filters disabled. Version/catalog overrides are already hashed and validated; blanket rejection is unnecessary.
- Boundary: a trusted dependency build is arbitrary OS-user code. Local JSON receipts are orchestrator-written diagnostics, not independent attestation against a hostile process with that same user identity. Hash sentinels or moving writable files do not create an OS boundary. Worker isolation and authenticated external evidence remain separate milestones.
- Timeout remains fail-closed: no automatic reuse/retry of the occupied stage or its store, no Builder/push after failure. Descendant termination and rollback are not claimed. Read-only status remains available.

## Primary source context

- [pnpm 11 release](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md): allowBuilds and configuration changes.
- [pnpm rebuild](https://pnpm.io/11.x/cli/rebuild): explicit package selection.
- Installed pnpm 11.4.0 implementation was inspected for `parseCliArgs2`, `buildSelectedPkgs`, `recursiveRebuild`, and `_rebuild`; local behavior tests take precedence over speculative model claims.

## Round 1 prompt

Challenge this generic software design (no repository/code is supplied). A CLI prepares candidate and clean replay checkouts for a once-authorized draft PR. Existing default pnpm 11.4 frozen install disables all lifecycle scripts/hooks, uses private HOME/store and cached package manager; no OS sandbox. New opt-in --build-deps takes comma-separated exact registry name@version selectors. Preview binds selectors and lockfile tarball integrity plus all committed dependency inputs, tool versions and an explicit unrestricted-build-network acknowledgement into the request digest. Reject missing versions, wildcards, absent lock entries, workspace package selectors, and selectors not explicitly allowed by committed allowBuilds (only simple package-name true entries supported for opt-in). After ignore-scripts cold install and full source check, run pnpm pm --recursive rebuild with NONEMPTY exact selectors, disabled pnpm hooks, same private store, no side effects cache. pm forces built-in command instead of a same-name project script; explicit selectors avoid workspace lifecycle hooks; inspect installed pnpm 11.4 implementation and black-box test these assertions. Root/workspace install scripts must stay suppressed. Dependency scripts are arbitrary code running with the OS user identity; approval does not imply sandbox, network restriction or bit reproducibility. Fail/timeout remains occupied, no retries. Native build stage receipt followed by source recheck and actual registered verification gates in both checkouts. Need actual full monorepo cold-install SQLite positive probe plus regression fixtures with allowed/unselected scripts and root rebuild shadow. Find concrete implementation traps and propose minimal testable changes. Keep response under 900 words; separate reasoning from verified facts.

## Round 1 raw response

# Review of the `--build-deps` design

## A. Observed / verifiable facts (general knowledge; not verified against pnpm 11.4 — I have no binary or repo)

1. pnpm links store files into `node_modules/.pnpm/**` by hardlink (or reflink/clone where supported; `package-import-method` controls this). Writes by a lifecycle script into its own package directory can therefore mutate the store copy.
2. Project-level `.npmrc` (and, since pnpm 10, `pnpm-workspace.yaml` config keys) override user-level settings, including `store-dir`, `ignore-scripts`, `ignore-pnpmfile`, `node-linker`, `manage-package-manager-versions`.
3. `pnpm rebuild` with selectors that match nothing exits 0 with no work done.
4. Lockfile package keys carry peer suffixes (`name@version(peer@x)`), and the same name may appear at multiple versions.
5. `node-gyp` children are spawned as separate processes; killing only the pnpm PID leaves them running.

Everything below is reasoning, not observation.

## B. Concrete implementation traps (reasoning)

**T1 — `pnpm pm rebuild` may not exist as assumed.** If `pm` is not a recognized subcommand in 11.4, pnpm may fall through to `pnpm run pm`, error, or treat `rebuild` as a script name — exactly the shadowing you are trying to avoid. The design already says "inspect and black-box test"; make the probe a hard gate: a fixture with a root script named `rebuild` *and* one named `pm`, each writing a canary file. Build must succeed with no canary present.

**T2 — Root/workspace lifecycle during rebuild.** Historically `pnpm rebuild` (especially without targets, and in some versions with `-r`) runs the importer's own `install`/`postinstall`/`prepare`. Explicit selectors are believed to skip this, but "believed" is the trap. Fixture: root and a workspace package define `postinstall`/`prepare` canaries; assert absent after rebuild.

**T3 — Committed config silently neutralizes or redirects the build.** A repo `.npmrc` with `ignore-scripts=true` makes the rebuild a no-op (exit 0, digest "verified", no `.node` file). `store-dir=` in `.npmrc` escapes the private store. `manage-package-manager-versions` + `packageManager` field can fetch a different pnpm. Pass explicit CLI overrides (`--config.ignore-scripts=false`, `--store-dir`, `--ignore-pnpmfile`, `--config.manage-package-manager-versions=false`) and assert `pnpm store path` and `pnpm --version` match expectations *inside the checkout* before building.

**T4 — allowBuilds semantics vs. rebuild.** Two opposite failure modes: (a) rebuild honors the allow-list and skips non-allowed packages silently; (b) rebuild ignores the allow-list entirely, so your own selector check is the only gate. Either way, restricting your parser to `name: true` is fine, but a repo using `false` entries, globs, or `onlyBuiltDependencies`/`ignoredBuiltDependencies` legacy keys must be rejected explicitly, not misparsed as "not allowed".

**T5 — Selector granularity mismatch.** If `rebuild better-sqlite3@11.0.0` is matched by name only, the digest binds one version while pnpm builds all instances (including a second version pulled by a transitive dep with peer suffix). Reject selectors whose name resolves to more than one lock package entry, and match lock keys after stripping peer suffixes.

**T6 — Store contamination across checkouts.** "Same private store" for both candidate and clean replay means a hostile postinstall in the candidate can rewrite hardlinked store files consumed by the replay. Disabling the side-effects cache does not address hardlinks. Use `package-import-method=copy` for build-deps runs, or a store per checkout, and run `pnpm store status` (or your own content hash of the store) as a gate.

**T7 — Toolchain self-replacement.** Scripts run as the OS user; the cached pnpm, private HOME config, and any tool on `PATH` (including `node_modules/.bin`, which pnpm prepends) are writable. Post-build gates then execute attacker-chosen binaries. Hash pnpm/node/git binaries and the private HOME config before and after; place the cached package manager on a read-only path.

**T8 — `.git` reachability.** Source recheck covers the tree, but a script can edit `.git/config` (`core.hooksPath`, `core.fsmonitor`) so that the *recheck itself* runs code. Use a detached `GIT_DIR` outside the script's cwd, or hash `.git/config` and hooks before/after.

**T9 — Timeout leaves orphans.** Kill the process group / job, then verify no descendants survive before declaring "occupied"; otherwise a late write races your receipt.

**T10 — Positive proof is weak.** Exit 0 proves nothing (T1, T3, T4). The receipt should record: pnpm stdout/stderr, the set of `.pnpm/<pkg>` directories whose content hash changed, and existence + loadability of the expected artifact (`build/Release/*.node` for SQLite).

## C. Minimal testable changes

1. **Config pinning:** pass all five overrides from T3 on the command line; gate on `pnpm store path` / `pnpm --version` output.
2. **Change-set gate:** snapshot hashes of `node_modules/.pnpm/*/node_modules/<name>` before rebuild; after, assert changes ⊆ selected packages (plus their subtree). Any other change → fail. This single gate catches T2, T4(b) side effects, and most of T7.
3. **Copy import method** for build-deps runs; `pnpm store status` gate (T6).
4. **Selector resolution:** reject multi-version names; strip peer suffixes; reject unsupported allowBuilds forms explicitly (T4, T5).
5. **Toolchain hash receipt:** pnpm, node, git, private HOME config, `.git/config` — before and after (T7, T8).
6. **Process-group kill + descendant check** on timeout (T9).

**Fixtures to add:** (a) full monorepo cold install + SQLite build, assert `.node` loads via `require`; (b) allowed-but-unselected package with a canary script — assert canary absent; (c) root `rebuild`/`pm` script shadow canaries; (d) root/workspace `postinstall`/`prepare` canaries; (e) `.npmrc` with `ignore-scripts=true` and `store-dir=` — assert the CLI overrides win or fails loudly; (f) postinstall that overwrites the cached pnpm and its own package file — assert store-status and toolchain-hash gates fail.

The design's threat statement (no sandbox, no network restriction, no reproducibility) is honest; the gaps are that several "assumed" pnpm behaviours are load-bearing and currently unproven, and that post-build gates trust a toolchain the build was allowed to modify.

## Round 2 prompt

Second adversarial round on the generic design. Actual local pnpm 11.4 source and black-box evidence: argv[0] pm explicitly forces built-in; a synthetic registry layout after real script-free installation successfully builds selected@1.0.0 and does not run same-name selected@2.0.0, allowed unselected package, root rebuild/pm/prepare/postinstall or workspace postinstall. No empty selectors permitted. Rebuild rejects --ignore-pnpmfile as unknown; use --config.ignore-pnpmfile=true plus inherited PNPM_CONFIG_IGNORE_PNPMFILE=true instead. Exact version selection works, so we will NOT reject all multi-version package names. v9 packages keys name@version bind tarball integrity while snapshots may carry peer variants. All variants of selected exact package/version are permitted. Each checkout has its own new store; install uses package-import-method copy and disabled side effects cache. npmrc and manifest pnpm/devEngines and unknown workspace settings rejected. Cached package manager network disabled; explicit version and runtime checks; no automatic verifyDepsBeforeRun reinstall. The once-authorized contract now names build scripts as OS-user execution with unrestricted network, scripts disabled during installation, dependency build stage separately authorized. No claims to constrain hostile selected scripts' arbitrary subprocess or filesystem effects; that requires an OS worker isolation phase, not ineffective writable hash sentinels. Git snapshot commands explicitly disable hooks and fsmonitor. Timeout leaves execution occupied; cannot claim descendants terminated. Receipt named build-command-completed explicitly says functional verification required by registered gates, and may be absent on timeout/failure. Actual cold public-registry install + SQLite query and esbuild transform in two checkouts in progress, no result yet. Distinguish remaining must-fix correctness defects from deferred OS isolation. Is this a coherent opt-in trusted-dependency build milestone? Suggest targeted additional regression cases. Keep response under 650 words. No tools or repository data available.

## Round 2 raw response

**Verdict (reasoning, not evidence):** Yes — this is a coherent opt‑in trusted‑dependency build milestone, *provided* the contract is read as "authorized exact package/version runs as the OS user with network," and nothing stronger. The scope narrowing is honest. What remains are correctness defects in the orchestrator's own attack surface (config resolution, receipt provenance, git snapshot, timeout state), distinct from the deferred OS‑isolation phase.

**Your reported evidence (I accept but cannot verify):** argv[0] `pm` forces built‑in; synthetic registry builds `selected@1.0.0` only; root/workspace scripts and allowed‑unselected packages not run; `--ignore-pnpmfile` rejected on rebuild, `--config.ignore-pnpmfile=true` + env works; cold public‑registry run still pending. Note the synthetic test doesn't yet exercise real tarball integrity mismatch, git deps, or peer‑variant snapshots against the public registry — the pending run is the first real check of the v9 key binding.

**Must‑fix correctness defects (my reasoning):**

1. **Config resolution isn't fully pinned.** Rejecting repo `.npmrc` and manifest `pnpm`/`devEngines` doesn't stop user/global config: `~/.npmrc`, `$XDG_CONFIG_HOME/pnpm/rc`, `npm_config_*` env. Run with explicit `--config.userconfig`/`globalconfig` pointed at an empty file (or scrubbed HOME + env allowlist). Also explicitly reject *known* workspace keys, not just unknown ones: `onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies`, `dangerouslyAllowAllBuilds`, `hoist`, `publicHoistPattern`, `shamefullyHoist`, `overrides`, `packageExtensions`, `catalog(s)`.

2. **Receipt provenance.** `build-command-completed` must be written by the orchestrator from its own observed exit status, to a location outside the checkout/store the script user can write. If the script runs as the same OS user, it can forge any in‑tree file; so the receipt must be in orchestrator‑owned state (DB row, keyed by lockfile hash + `name@version` + integrity), never a path. Otherwise the "gates required" caveat is undermined.

3. **Authorization binding.** Authorization must bind `name@version` **and** the v9 `packages` integrity **and** the lockfile hash at authorization time. Rebuild re‑reads the lockfile; if it changed (hostile commit or prior build wrote it), refuse rather than resolve a new tarball under the same selector.

4. **Timeout must be sticky.** "Execution occupied, descendants not guaranteed terminated" is acceptable only if the checkout *and its store* are marked tainted and refused for all subsequent operations (including reads/snapshot) until the isolation phase exists. Don't let a later run inherit a live process's writes.

5. **Git snapshot hardening beyond hooks/fsmonitor.** Repo‑local `.git/config` (writable by any script) can set `diff.external`, `filter.*.clean/smudge`, `core.editor`, `core.sshCommand`, `credential.helper`, `alias.*`. Use `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, and only plumbing commands with `--no-ext-diff`/no textconv/no filters (e.g., `git diff-index`, `git ls-files`, `hash-object --no-filters`).

6. **Missing‑selector semantics.** "No empty selectors" ≠ "selector matches nothing." `selected@9.9.9` absent from the lockfile must hard‑fail, not no‑op with a success receipt.

**Deferred, correctly:** subprocess/filesystem containment, descendant termination, network egress control, store poisoning by a hostile build within its own checkout.

**Targeted regression cases:**

- `~/.npmrc` and `npm_config_registry`/`npm_config_pnpmfile` env pointing at a malicious mirror/pnpmfile → ignored.
- `pnpm-workspace.yaml` with `neverBuiltDependencies: [selected]` → either rejected up front or rebuild still runs (assert which).
- Lockfile mutated after authorization (same version, new integrity) → refused.
- Selected `name@version` with two peer‑variant snapshot keys → both build, same tarball, one receipt.
- Sibling `selected@2.0.0` with `postinstall` writing a sentinel → sentinel absent (already done; keep).
- Git‑hosted dependency with `prepare` → not run during install, not run by rebuild unless selected.
- Selected package's `preinstall`/`install`/`postinstall` all present → all three run, in order, once.
- Script writes a fake receipt file at the expected path → orchestrator ignores it.
- Script spawns a detached sleeper then exits 0 → receipt issued (contract permits), checkout not tainted; script times out with sleeper → no receipt, checkout tainted, next command refuses.
- `.git/config` with `filter.x.smudge=touch /tmp/pwn` and a `.gitattributes` mapping → snapshot completes without running it.
- Selector `selected@nonexistent` → non‑zero, no receipt.
- Second checkout of same repo → separate store; first checkout's build artifacts don't appear (copy method, no side‑effects cache).

