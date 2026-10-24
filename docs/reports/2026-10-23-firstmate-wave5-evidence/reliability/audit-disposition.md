# Reliability slice audit and validation

Three raw CLI contexts/results/stderr files are retained. Requested model `claude-haiku-5-5`; stderr `unrecognized_model` means underlying model identity is not independently attested. Third scoped regression audit: no confirmed P0/P1/P2 in provided final observer/recovery/store/tests/docs. This does not erase explicitly accepted limitations or qualify pending runtime environments.

## Fixed findings

- Source missing previously overwrote released metadata. Only admitted observations are now updated on disappearance; the same release/disappearance/restore regression fails before and passes after. `release-regression-status.json`: red1/green0.
- Existing unadmitted malformed/missing metadata previously gained admission. Only capacity_exceeded/binding_unknown/source_error can retry discovery admission; release and unknown/corrupt metadata stay unadmitted. '{' and '{}' regression failures retained in release-corruption-red.log and fixed passes in release-corruption-green.log. No schema change, no claim against arbitrary authorization-database rewrites.
- Oversized recovery identities/receipts no longer poison an entire page. Source identity is SQL-bounded/null on invalid data; a bounded opaque decimal rowid cursor allows subsequent pages, and each source error becomes unknown independently. Runtime source state is validated; stale scope/generation/clock cannot expose fresh-looking evidence.
- Benchmark now binds measured compiled core/protocol artifacts, source files and lockfile, native/runtime/FS metadata. Maximum valid authority IDs have an explicit two-family boundary test; 4KiB was only the empty-envelope fixture assertion, never a global payload guarantee.

## Remaining limits

Existing 250-row discovery page can exceed the 5ms cooperative target. tick remains synchronous compatibility; parent must wire production step/yield. Legacy inventory facts contract is not replaced by the bounded recovery endpoint. Session-heavy/overflow performance, real socket RTT, mixed10minsoak, Loop overhead and platform crash matrix remain pending. Recovery is diagnostic only; no executor actions or process-stop proof. Loop/Graph need trusted host adapters. Scheduling fairness is within the existing admitted<=100 collection; overflow stays capacity_exceeded.

## Final verification

86 focused tests: observer21 + run projection38 + recovery12 + experience15. Core build and scoped Biome pass; earlier core typecheck passes. verified-commands.json records actual exit codes. Source manifest and raw logs are retained. Public import incremental cached dependency measurement0.064ms; module adds no new heavy dependency family.

Latest exact-source benchmark: /Volumes/AIMATE_WORK/tmp/osstack/smoke/attention-bench-UyixlZ/result.json. AppleM4/Darwin27/Node22.22.1;100 admitted runs/10 scopes/12000 events including10000single-sourceburst;501passes,5388slices,converged. Observer p95=5.205166ms/max18.338459ms; internal recovery p95=0.460208ms/max1.4345ms. Soft5ms target not consistently met; do not label it a passed hard bound. Real socket p95=null. Earlier measurements5cywzI andx1GMbu retained, including max46.907875ms; exact outlier cause unassigned, not dismissed as noise.
