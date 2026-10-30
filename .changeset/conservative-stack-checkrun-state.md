---
"@osstack/github": patch
---

Prevent PR stack ingestion from treating anomalous CheckRun outcomes as successful. Classify ACTION_REQUIRED, STALE and STARTUP_FAILURE as failures, and require explicit COMPLETED status with SUCCESS, NEUTRAL or SKIPPED to report success. Missing, unknown and waiting states remain pending; preserve existing StatusContext handling and failure precedence.
