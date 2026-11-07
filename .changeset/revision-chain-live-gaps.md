---
"@osstack/core": patch
---

Close the live-path gaps the bridge TLA+ model found in the revision-chain store: an uncertain push receipt stops any chain that is not already stopped or closed, a failed push receipt stops an in-flight round, a stopped chain cannot resume while a push receipt is pending or uncertain, at most one push intent is pending per chain, a new head is accepted only from the confirmed intent that extends the published head, decisions are whitelisted per source state, a confirmed push settles its reservation once the child is terminal, and reserve, dispatch and push-intent writes check the live grant's expiry against an injected clock. `RevisionChainStore` gains an optional clock argument and `nextConfirmedPushHead`.
