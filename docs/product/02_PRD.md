# PRD

## User Problem

AI coding tools can produce useful code, but teams still need routing, isolation, verification, evidence, replayable decisions, and durable memory across runs.

## Users

- Solo builder running local AI coding loops.
- Engineering lead reviewing AI-generated changes.
- Founder/operator needing proof of work and release readiness.
- Auditor/customer reviewing evidence without seeing raw model sessions.

## MVP Requirements

- `osstack loop run` executes queued work and writes durable state.
- `osstack deliver` starts from one prompt and emits report, scorecard, and proof.
- `osstack proof` creates checksumed evidence.
- `osstack govern` records deterministic findings.
- `osstack knowledge` searches local/cloud packs and records traces.
- `osstack cockpit` summarizes daemon, runs, kanban, reports, proof packs, and recent work.

## Success Metrics

- Clean install smoke passes from packed npm artifacts.
- A user can run loop -> report -> scorecard -> proof in under five minutes.
- Proof packs can be opened offline and retain integrity checksums.
- Governance and Knowledge Cloud failures fail open unless strict mode is requested.

