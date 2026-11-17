---
'@osstack/cli': patch
---

Pin the portable init/doctor Actions job in the production CI repair policy. Accept only its verification step as a repairable failure, with the workflow bound at both PR head and base.
