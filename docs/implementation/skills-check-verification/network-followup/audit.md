# Actual Sonnet 5.5 network repair audit

Actual Claude CLI `claude-sonnet-5-5` reviewed candidate `f7236a159d266dd43c79729e14f19c1ac273d623` and returned **PASS, no concrete blockers**. Full input, original response and model/SHA binding are retained in `root-audit-evidence.tar.gz`; the manifest lists every member. This was a supplied-source audit, not a test execution.

Independent probes separately observed complete-body time limits, body-abort recovery and zero tar calls on checksum mismatch. Their downloader SHA matches the committed source; root independently reran all 14 tests successfully. Historical observations on the replaced fetch implementation remain explicitly separate. The exact source archive is the trust boundary: official HTTPS checksums do not provide independent signature verification or cover a compromised origin.

Non-blocking audit suggestions remain recorded: tar link hardening, clearer unverified-file naming, stronger scratch helper parity, extra test timeout settings, proxy support and synchronous request-error cleanup. The fixed official origin/version and verified checksum bound current scope; failed directories are never passed to rebuild. The 8-minute preparation step exceeds the maximum configured 424-second acquisition/extraction budget; it fails rather than bypasses validation. No test timeout or gate was increased to force success.

The root scratch helper is required by repository script discipline, and this branch lacked it. It implements the existing root/layout/label rules without loading built workspace packages. Runner scratch lives under its explicit runner temporary root; local scratch remains on the configured external volume.

The original product regression on `ff6bfeb6` remains 7144 passed / 5 skipped / 0 failed; it is not relabeled as a full run on this later infrastructure candidate. New published-head CI is required, including both exact runtime versions, verified header download, native SQLite compilation and original runtime tests. PR stays Draft until those results pass. No runtime qualification or merge authorization is granted by this audit.
