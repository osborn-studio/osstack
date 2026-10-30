The stack importer discarded legacy GitHub StatusContext.state, so SUCCESS, FAILURE and ERROR all became pending. Preserve these outcomes: SUCCESS maps to success; FAILURE/ERROR map to failure; pending, missing and unknown legacy states stay pending. Existing CheckRun policy and topology are unchanged, and existing cards are not refreshed.

Targets actual main de43f47c after the user merged #307. Retarget commit 6d978973 has the same tree and complete delta as the prior b4a candidate; final head 4a7ee75d adds documentation and retained evidence only. Final CI40979169462 is the applicable run. The superseded 6d run40977980388 was cancelled to release the final candidate's queue, not retried after a test failure.

Validation:
- Fresh Node22 frozen install/build at the actual-main candidate: GitHub172/172 and candidate CLI14/14; lint, generated inventory, typecheck, 241 document checks and hygiene passed. Injected three-PR responses exercise the public ingest/drift/topology path without live forge or DB writes.
- Same33 author tests: old12fail/21pass, repaired33pass. Independently frozen36 vectors: old9fail, repaired36pass.
- Historical full at bda3942a: 22packages7207pass/5skip/0fail, tracked bytes unchanged with four fresh generated dist files initially dirty. This is not relabeled as a final clean-tree full run.
- Actual Sonnet5.5 product review PASS; documentation review REVISE corrected CI/head attribution, then limited closure PASS. Original reviews and failed evidence remain intact. Retarget archive SHA256 83f112d625c243e28df9d3f0b02dab58138c7129b5835b7109d3aeb10294f476:135 members independently verified, later freeze receipts separately retained.

Evidence: docs/implementation/stack-status-context and docs/implementation/pr308-main-retarget. PS18 contribution, PS17/J07 support; no whole-capability or formal milestone completion. No watcher, new method, automatic approval/merge or new native-host experiment. The separate CheckRun outcome repair is #309 and is not part of this PR.

Final CI40979169462 passed all five applicable jobs; paid semantic smoke was skipped. Actual synthetic checkout25bb08b59939d7573d73cbe6594ce7e12a6af89b:22package7207pass/7skip/0fail, GitHub172 and candidate CLI14 pass; exporter94total=93pass+1skip. Full original log retained losslessly; remote artifacts were not downloaded/rehashed. Root marked Ready and read back main/isDraft=false/MERGEABLE. Human approval and merge remain required.
