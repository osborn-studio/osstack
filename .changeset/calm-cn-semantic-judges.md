---
"@osstack/agents": minor
"@osstack/cli": minor
"@osstack/governance": patch
---

Add fixed, bounded `deepseek-no-tools` and `qwen-no-tools` semantic judge
profiles, route neat semantic and dependency judgments through a shared
provider registry, and make semantic parity readiness provider-neutral.
Provider responses now fail closed when the reported model identity differs
from the requested model. The built-in Qwen profile is explicitly scoped to
Alibaba Cloud China (Beijing) credentials.
Propagate sanitized, closed-registry provider failure codes through semantic
coverage reports and live diagnostics without exposing provider response bodies
or exception text.
Refresh MCP HTTP transitive dependencies to patched, upstream-supported
versions.
