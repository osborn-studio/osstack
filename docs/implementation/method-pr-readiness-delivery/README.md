# PR readiness method: delivery evidence

This delivery adds the thirteenth shared method and records its actual author, independent and Sonnet checks. The raw evidence archive preserves the original opinions, failures, source bindings and host experiments; static method checks and actual host outcomes have separate scopes.

The method adds one-shot PR state reporting and authorized blocker correction guidance. It distinguishes current candidate, CI, review, integration and human approval; it neither installs a watcher nor automates merging. Existing local fix authority is preserved and review text supplies no permission. In this project the user retains approval/merge through gilberthello.

## Candidate chain and actual validation

| Evidence | Exact candidate | Result and scope |
| --- | --- | --- |
| Initial author | `04840eda89650f3c41c9605c9b9648bfc482182f`, based on provisional `38f13cff5c4e161835eaa5c75c3976b5a8e95046` | Initial focused RED 9 pass/6 fail; later 91 exporter tests pass, five skill-format checks, two actual 80-file exports. Missing-reference RED initially failed in fixture setup; GREEN established exporter rejection. |
| Revised author | `95a33e371464fe48bf063afe17ed650852e925d5` | R1–R3 and selected clarifications fixed; 91 exporter tests rerun, two fresh 80-file exports, member hashes/sizes and unchanged source inventory checked. |
| Independent candidate/revision | `04840eda` then `95a33e37` | Both actual host layouts: 80 files and 289 local-link edges, all four entries reach thirteen methods, corresponding bytes agree. Initial candidate also used an owned missing-reference copy and observed rejection before output creation; revision did not rerun that negative. Static hypothetical walkthroughs are not model or forge behavior. |
| Actual Sonnet initial/closure | `04840eda` then delta `04840eda..95a33e37` | REVISE, then limited PASS for R1–R3 text and accepted clarifications. The reviewer explicitly did not verify test/export counts or runtime qualification. Full raw opinions are preserved in audit.md. |
| Earlier root package suite | `7495b723a8cbe820201f62b3b1d70014edec62ab` | `pnpm test`: 7144 passed, 5 skipped, 0 failed, exit 0. This preceded integration of PR-readiness. It had recorded ledger/docs and four knowledge/dist modifications, with the same full diff digest before/after. It is not a full-suite result on c95. |
| Final root exporter suite | `c95dccd01a884e84e413817c338f2303ed02a9a7` | 91 passed, 0 failed/skipped, exit 0; clean before/after. Ten author paths equal 95a33e37 byte for byte. No package source changed from the earlier full-suite head to c95, but that does not relabel its historical result as a c95 full run. |

The word “7495” identifies a commit prefix, not the test count. Raw full-suite and final-export logs were checked against their recorded SHA-256 bindings. The package suite's dirty checkout is described by its recorded status and equal before/after patch digests; this draft does not claim to have reconstructed or rerun that checkout. Source equality is independently recomputed from fixed Git objects in candidate-bindings.json.

## Preserved evidence

- Original author archive: `pr-readiness-author-evidence.tar.gz`, 37,547 bytes, 22 members, SHA-256 `f5d9f1e2860626e53ff21eb0e7d47c91e6118d255bc9dc3ece58480afea639b3`.
- Revision archive: `pr-readiness-revision-evidence.tar.gz`, 24,008 bytes, 16 members, SHA-256 `778689529ff00909d47759ff290ca889508b13ed6aaf1f9673510966a1ae8c50`.
- Both archives were rechecked against their manifests and every extracted member's size/hash without overwriting original files. They include source/license, original failures, precise commands, export manifests and candidate snapshots. Duplicate exported trees remain local, as declared by their manifests.
- Raw initial/closure inputs, responses, reports and bindings remain in `method-audit/` and `method-closure/`. Source/input/response hashes match; modelUsage records the actual Sonnet identifier. Reviewer self-reported tool/test limitations remain part of the published record.
- Independent prefreeze and candidate records remain in `independent/`; original conclusions stay unchanged. The author worktree cleanup receipt records branch/scratch retention and unchanged archive digests.
- `evidence-index.json` lists exact existing paths, sizes and hashes for root to incorporate into its final archive. It is a pointer index, not a claim that every report assertion was independently executed again.

## Actual host probe

See [host-report.md](host-report.md) for the final95a33e synthetic four-PR classification probe. Codex used explicit file reads and has no resolved execution-model attestation. Claude invoked native osstack-mode, but its complete578-word output failed the frozen500-word format criterion. Neither is an all-criteria host qualification PASS. No actual forge correction, approval, merge or watcher was executed.

The dependency is PR299. This candidate incorporates its repaired published head7deee3af868c50958dcc651f2a5a7599e4750c60, not merely its original failing head. Its preparation repair's full7144/5/0 result is separately bound; no runtime or formal J01/J11 qualification is asserted. Publication remains root-owned; gilberthello approves and merges.

The host-report wording audit returned REVISE, then limited closure PASS after corrections to attribution, source-pin amendment, parsed inventories and cleanup/authentication scope. It did not upgrade the experiments. All original reports remain in audit.md and the raw archive.

The raw archive has1383 members and14146812 payload bytes, SHA25630582ba5e0c7314a4af335d95564a30684e4dd2dcdc4101485fb30c6da528d52. Later [host-workspace-cleanup.json](host-workspace-cleanup.json) records archive-verified removal of four owned26-file workspaces, including the unexecuted initial preparation. The reviewed host report retains its earlier snapshot rather than retroactively claiming cleanup.

PR299 repaired published head7deee3af is Ready after five applicable CI checks succeeded. Independent final run40786370675 Test-step accounting finds22 unique packages:7142 passed,7 skipped,0 failed. The two formerly timing-out cleanup cases pass at18718/19048ms as Vitest reports them(including preparation, not isolated cleanup-body timings). The original timeout cause remains unproven. The separate [ci299-final](ci299-final) records post-archive observations, not retroactive changes to original evidence.
