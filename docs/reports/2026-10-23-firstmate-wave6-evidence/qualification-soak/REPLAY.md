# Replaying this historical measurement

The archived harness/config intentionally retain the exact absolute paths and hashes used for the original run. They are evidence, not a portable package test. The temporary checkout was removed after its work completed.

For a new measurement, check out commit `14574347f6c52047550d46a0629bd87735c598a8` in a permitted worktree, install/build with Node 22, and copy the harness/config into a fresh directory under OSSTACK_SCRATCH_ROOT. In that copy, replace the original worktree prefix and scratch evidence prefix with your actual paths. Keep the original archive unchanged. Set a new SOAK_TAG and SOAK_DURATION_MS=600000; use the Vitest invocation recorded in manifest.json. Record your new source/harness/config hashes, machine, raw output and results separately. Never point OSSTACK_HOME at a production/default home.

The database/home directories were deliberately excluded from this archive. The full JSON files are synthetic measurement receipts; their absolute file references describe the historical run, not files guaranteed to remain on disk.
