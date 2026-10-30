---
"@osstack/github": patch
---

Preserve legacy GitHub StatusContext success and failure outcomes during PR stack ingestion instead of reporting them as pending. Keep existing CheckRun aggregation and conservative handling of missing or unknown context states.
