# C5 final acceptance repeat

Round 1 at 64edcea: 3009 tests passed, all verifiers passed. Resource-obligation fix then required fresh full verification.
Round 2 at 50133c0: 1 old collaborator-rpc revocation test failed waiting for resumed instruction (default vi.waitFor timeout); all29 graph chain cases and all six verifiers passed. The 11-test collaborator suite passed unchanged in isolated recheck. No unrelated source or product deadline was loosened.
Round 3 uses a new Loop task and fresh STATE, skipCompletedTasks:false, same accepted source hashes, maxWorkers=1 rather than2 to reduce test contention. Round2 original logs preserved in second-acceptance. Final gate depends on actual round3 outcome, not this retry note.
