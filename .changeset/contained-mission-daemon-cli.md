---
"@osstack/cli": patch
---

Add `osstack mission start|status|cancel|decide` and the daemon `mission.*` RPC for contained Missions. Both are opt-in through `OSSTACK_CONTAINED_MISSIONS=1` together with the engineering host, and authenticated by the engineering authority file. The daemon recovers orphaned Missions at start and then advances them on its own tick. Nothing is merged or published.
