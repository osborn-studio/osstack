# New-main CI repair

PR299 merged as main7d3fc2bf, tree equal its published candidate. PR300 was retargeted to main at f2df8504 with no file changes. Fresh CI40802170819 failed `attention-observer.test.ts` final retention assertion, not a timeout. Original logs remain in the archive.

The test used only the first page of100 historical items after their total became101. Because item IDs include scope hashes, the released session can lie on the next page. A real built-artifact isolated fixture made this deterministic by selecting only a fixture decision ID: first-page membership was false, second-page contained s0000, exact getItem equalled the original record, total101, old/new admitted0/1 and degraded coverage all held. This demonstrates the faulty assertion mechanism, not reconstruction of the exact CI random database.

Repair9432d319 captures the original item before release and verifies it by exact identity afterwards, while preserving capacity/coverage assertions and additionally checking101 retained items. Production code, pagination limits, timeouts, and test selection are unchanged. Root ran26 attention observer/store tests successfully in the integrated checkout (same repaired test bytes). Actual Claude CLI claude-sonnet-5-5 static review returned PASS. Its probability estimate is an unmeasured heuristic, not accepted as incident frequency; optional observations are retained without claiming a runtime defect.

The earlier retarget tests91export/241documents and limited Sonnet retarget review retain f2df8504 bindings. Full regression and new published-head CI are recorded separately once executed. Raw opinions, source bindings, commands and failures are preserved byte-for-byte in the archive with per-file hashes. No old host score or formal gate was upgraded.
