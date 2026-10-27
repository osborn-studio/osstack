# Post-284 management closeout evidence

Main at observation: `3192b424174e5eb977d640cc0418e67c6b1461d1`.

Actual Claude CLI `claude-sonnet-5-5` reviewed `d76fc900` and returned REVISE: historical composition provenance needed a computed archive comparison, and current status needed explicit unqualified broker deployment. Both were corrected in `e2cb35c8`. The second actual audit returned PASS with no blocking P0/P1/P2. Its wording “not confirmed” applies to the revised artifacts; it does not erase the valid original findings. Both raw inputs and complete responses remain compressed with byte hashes in manifest.json.

The first checkpoint directory is superseded by the second, retained intact for history. The second actually hashes the pinned composition archive, verifies all 51 manifest payloads, reads its published tree and compares it with the observed main tree. This is tree equivalence, not a fresh test execution on the merge SHA.

241 Python design/checkpoint tests, build, type checking and one document hygiene test passed on the initial management candidate as recorded in preflight-verification.json.gz. These do not qualify the product or any formal joint gate. Subsequent delivery verification is recorded separately.

Initial JP01c integrated candidate `9e292676336ca2e56422e467baef3bc5bc38e8d3` passed the full repository suite: 22 packages, 6884 passed, 5 skipped, zero failures. That result is historical for initial protocol candidate e5e5b298; later test/oracle revisions have separate focused validation.

Revised protocol candidate `74ec436d28f3f134451d45e35536c5747a7f1cba` was integrated at `518ea059193b1b3ae8dbabc1586f67e7771c3e9b`: all 1012 protocol tests passed, protocol typecheck and lint passed (21 existing warnings). Product and test sources were frozen during the earlier full run; generated build files and untracked preparation docs are explicitly described in full-run-worktree-scope.json.gz. Final publication documentation is checked separately. Both author/independent archives were hash-verified, and all four test assets match the actually audited code.
