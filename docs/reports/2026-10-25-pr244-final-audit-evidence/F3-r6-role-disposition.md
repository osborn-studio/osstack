# F3 r5 static role refusal lease closure

Owner accepts always-on execution/review role separation and refusal rather than silent local-noop for filtered execution routing. The compatibility option enforceRoleSeparation remains accepted but cannot disable separation. The post-execution returned-identity check is always enabled as defense in depth, including local-command identity; it is no longer gated by the obsolete switch.

Pure ID-only static validation now occurs after task discovery/governance but before candidate record/freeze, host containment prearm, worktree creation, effects flag or any selection adapter callback. Explicit agentId in verifier IDs, or only verifier adapters with no explicit command/agent override, throws the existing precise configuration error. Injected lifecycle lease tests prove normal release exactly once, no retain, no probe/invoke, no containment marker.

Dynamic selection still runs after prearm/effects admission because builder-side availability probes may write or start external work. A routing miss after such probes is now NO_AVAILABLE_EXECUTION_ADAPTER_AFTER_ROUTING_PROBES; it makes no claim that the static configuration lacks adapters. A real writing non-verifier probe returning unavailable proves the side effect occurred, lease retains, and marker persists. No false stopped proof or automatic reset is added. Existing selection-time defensive checks remain against runtime option changes.

Focused engine 52/52, loop typecheck and Biome 2 pass. F3-r6-role-validation.json binds source/test SHA and exit codes. Parent/graph own full package, entire repository QA and final Haiku r6; no deployment was performed.
