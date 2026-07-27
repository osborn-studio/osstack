# Kimi Code Mac Mini Baseline

Recorded on 2026-07-27 before Phase A implementation.

## Host and repository

- Host role: Mac Mini execution node
- Hardware: Apple Mac mini, Apple M4, arm64
- Operating system: macOS 26.5.2
- osstack baseline: 0.12.0
- Git baseline: `27d520a160ad345aaa79ce0c8a204b52013880ef`
- Worktree root: external volume; the machine-specific absolute path is not committed

## Kimi runtime

- Kimi Code CLI version: 0.29.1
- Executable path SHA-256: `730de0eb111577170f653a450be7375b0c486ed55427f8df93f5725e08b7d433`
- Executable content SHA-256: `cba31835395ff75fa6b5bc9b81a7907c7d933e7e6a7d8ba53afac23dd0f5ab04`
- Authentication: existing Kimi Code local login reuse; osstack did not read or store credentials
- Non-interactive mode: `kimi -p`
- Event mode: `--output-format stream-json`
- Agent policy input: `--agent-file` is available with the v2 engine
- Observed assistant event shape: `{"role":"assistant","content":"..."}`
- Observed metadata event: `{"role":"meta","type":"session.resume_hint",...}`
- Usage telemetry: `usage_unavailable`; no token-usage event was observed

## Probe evidence

- Ten consecutive exact-response prompt probes exited successfully.
- A read-only repository-status probe ran in a disposable, standalone clone.
- Tracked, staged, untracked, ignored, Git config, and Git hook evidence was
  unchanged before and after the read-only probe.
- Sanitized fixtures contain no credentials, personal identifiers, session
  values, or machine-specific absolute paths.

The successful read-only prompt is evidence of observed behavior, not by itself
an isolation guarantee. Phase A promotion remains blocked until the dedicated
agent file exposes no write or shell tools and an adversarial mutation probe
confirms that the real CLI cannot modify the builder repository or its common
Git directory.
