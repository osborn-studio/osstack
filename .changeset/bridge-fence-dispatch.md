---
"@osstack/cli": patch
---

Dispatch revision publication by the Mission target and check the live chain, reservation, workspace claim, and signed grant at the W13 release fence. Request host cancellation when PR or remote head facts invalidate the child.

Route revision checks through the child's confirmed push. Skip checks after chain closure and record check failures on the Mission. Record failed host cancellation requests on the chain.

Deferred to 5-E: deliverRevision step-0 receipt routing (D10 §6.2) must land before the revision port is wired in production. Until then, a crashed push halts the child and approve_publication re-throws.

Also deferred to 5-E (latent until the port is wired): the manual check retry (`retryVerifyCheck`) must go through the revision port's `publishCheck`, and an `uncertain` check intent on a chain that closes must be settled.
