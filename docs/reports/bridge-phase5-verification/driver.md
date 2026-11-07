
## Offline integration follow-up

The driver now attributes every confirmed baseline/push to the numeric App A Bot actor using repository activity, exact before/after SHAs and a separately verified repository id. Fresh PR/ref heads are read around final attribution. Cancellation runs first, before its first host tick: old services/host/DB close, a separate process claims a new owner and recovers the same persisted DB, and the parent then opens a new DB connection and reconstructs owner/stores/ports/host/bridge, including on worker failure. The report calls this window before-first-tick; it does not claim cancellation during a released write.

Write-scope removal now runs through the publication hook immediately before the original gated push runner. Qualification requires the exact failed intent and a real intent-bound W13 row with stopped proof and `released_at === null`, plus the unchanged observed remote head. A missing row, uncertain intent, released row or callback-only failure cannot qualify. These scenarios have only offline helper/contract validation so far; a real sandbox execution remains necessary to produce acceptance evidence.
