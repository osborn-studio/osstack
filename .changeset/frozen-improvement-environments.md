---
"@osstack/cli": minor
---

Add opt-in `improve deliver --prepare-deps pnpm` for a bounded pnpm 11.4+ (11.x) public-registry environment. Bind committed dependency inputs and observed tool versions to the existing request confirmation, prepare fresh dependencies before the builder and clean PR verification, and expose stage receipts in `improve status`. Install with a frozen lockfile, scripts/hooks disabled and separate stores; failures retain occupancy without automatic retry. Existing commands remain unchanged without this option.
