# PR305 retarget archive verification

Archive hash matches f09333bf…fc63c. All429 payloads (43,823,248 uncompressed bytes), plus the archive manifest itself, are430 unique regular members. Every recorded SHA256, size and mode matches; archive manifest hash a9b6edcf…d44bd. No extraction was needed.

Three full audit input/response/report/binding sets are preserved. Reports exactly match response result text: source/CI static PASS, docs-only REVISE for the introduced “check it does not” splice, then limited two-hunk PASS. Intermediate REVISE explicitly preserves the original source/CI PASS; it is not erased or upgraded. Each audit input/response hash matches its original binding.

The nested357-member validation manifest and summary remain exact and bind fresh88/43/94/14 checks and actual default/full paths to6f79d125. This review is archive verification by the prior validation author, not a new independent product execution. d0c77fbc and b0ea4e78 actual Git deltas touch only three/two Markdown files respectively; no package/script changes are implied or newly tested.

Both control/docs-export.log and control/docs-export-final.log contain94/94 pass,0fail/skip. Neither log is in this tar; their hashes/locations are separately recorded in report.json for the root's additional collection. This omission is explicit, not a claim that these doc follow-up logs are already archived. Their bare stdout logs do not independently encode candidate SHA.

No model/test/CI/network/repository mutation performed. No new runtime, provider, or formal-gate qualification.
