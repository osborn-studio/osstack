---
"@osstack/cli": patch
---

Extract contained verification into an owner-neutral module (`contained-verification.ts`, M5 of the contained Mission path): Git candidate export and image build, a neutral `ContainedVerificationBinding` with canonical digest, execution registration and journal reopening, each parameterised by the owner's identity check and fence. Graph contained tests and recovery are now thin adapters with unchanged behaviour; Graph journals keep their exact bytes, and journals written before this change still reopen. Adds `missionVerificationBinding` for contained Missions and `containedCommandFromArgv`, which POSIX-quotes an argv into the single `/bin/sh -c` string the contained runner accepts. Nothing is wired into the daemon or Mission lifecycle yet.
