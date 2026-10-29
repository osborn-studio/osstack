# PR300 after PR299 merge

Actual main `7d3fc2bfc39cbb8afc382973cc17be4c60a29f70` has the same tree as PR299 published `7deee3af`. PR300 now targets main at `f2df8504b76e5f238a0571fe12d29347ec82bfdf`; this ancestry merge has exactly the previous candidate tree `c673965b87aee1a239012f0d7090f4554243f89e`. Object proof and independent pre-mutation inspection are retained. Their timestamps are historical observations, not current forge state.

On f2df8504: actual Node22 exporter 91 passed / 0 failed / 0 skipped; document tests 241 passed. The sequential shell exited 0; the two logs are inspected independently. Actual Claude CLI claude-sonnet-5-5 returned limited retarget PASS, restricted to the supplied proof and three supplied files. It did not independently execute Git, verify CI, or re-audit the whole package. Original input, response and binding are retained.

Fresh run40802170819 is still in progress at this checkpoint; PR300 remains Draft. Old feature-base CI retains its original binding. No new host-model experiment ran; old Codex LIMITED / Claude FAILED remain unchanged. No formal J01/J11 qualification or runtime enabled.

Subsequent observation: fresh CI40802170819 failed its final retention assertion because a first page of 100 was treated as the complete historical set of 101 items. A real built-artifact fixture reproduced this with s0000 on page two and exact getItem unchanged. Test-only repair9432d319 uses the captured item identity and also asserts101 count. The original admission/coverage checks and runtime remain unchanged. Root26 focused tests and actual Sonnet5.5 static PASS; CI repair publication pending. No blind CI rerun.
