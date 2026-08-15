---
"@osstack/agents": minor
"@osstack/cli": minor
"@osstack/governance": patch
---

Add a fixed, bounded `deepseek-no-tools` semantic judge profile, route neat
semantic and dependency judgments through a shared
provider registry, and make semantic parity readiness provider-neutral.
Provider responses now fail closed when the reported model identity differs
from the requested model.
Propagate sanitized, closed-registry provider failure codes through semantic
coverage reports and live diagnostics without exposing provider response bodies
or exception text. Classify output-token exhaustion, content filtering, and
provider resource interruption separately while retaining a safe unknown
finish-reason fallback.
