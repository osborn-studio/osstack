# B9 sandbox drill profile

The drill measures one assertion in `osborn-studio/osstack-bridge-sandbox` (repository ID `1446327922`). Its CI job runs `test ! -e PROBE_FAIL`. The installed harness runs that exact line in the candidate working directory. An absent marker passes. A present marker returns exit 1 and the failure code `probe_marker_present`. The harness check ID is `probe-marker-absent`. ADR-008 still assigns merge evidence to Actions. [Sandbox workflow](https://github.com/osborn-studio/osstack-bridge-sandbox/blob/70032867fce42f59fb30f278b876854e7e06a6d7/.github/workflows/ci.yml) · [Pause note](../plans/2026-11-25-sandbox-drill-checklist.md)

## Reproducible pins

The trusted source repository is `osborn-studio/osstack`. The example uses commit `9ce2c010671dee41efd84e7301b9cd202c356958`. The generator reads Git objects at this commit. The installed skill supplies the identity. The installed profile supplies the executable check. [Intake design, rows 77–78](2026-11-16-verify-failure-intake.md)

| Field | Value for the example |
| --- | --- |
| `skill_id`, `skill_version` | `verify-osstack`, `1.0.0` (drill registration version) |
| `skill_blob` | `44e2a59cc1c55a7b5a62daacdf857a1cd9efe09f` |
| `skill_manifest_digest` | `58545ff5e34976120fccb1b25dcc923c44f8dd7fd3cac6f35ae805e5d0d62217` |
| `profile_id`, `profile_digest` | `sandbox-probe-v1`, `d38f3ea1ae27c4e99b41326abc87aa820b15ececfd7d6d3d8a4ee4cfe3f992b8` |
| `trusted_source.artifact_digest` | `b12fdca95611a30f4379053e81313c7fe5084b6590bae9c309ee5789fc8c72e8` |
| Profile argv | `["/bin/sh","/osstack-trusted/probe.sh"]` |

`skill_blob` is the 40-character lowercase Git SHA-1 of the installed entry file, `.cursor/skills/verify-osstack/SKILL.md`, at the trusted commit. For this drill the manifest covers every tracked file recursively under that skill directory, including the entry, plus the external assertion source, `deploy/github-actions/osstack-verify.yml`. Each record is `{"path":<repository-relative path>,"blob":<git blob SHA-1>}`. Sort records by the UTF-8 bytes of the full path. Hash the canonical JSON array with SHA-256, without a trailing newline. Encode the digest as 64 lowercase hex characters. The generator accepts regular Git files and rejects links and submodules. [Wire fields, verification-result.ts:43](../../packages/core/src/bridge/verification-result.ts#L43) · [Canonical hashing, verification-result-builder.ts:94](../../packages/core/src/bridge/verification-result-builder.ts#L94)

`verificationProfileDigest(profile)` hashes the canonical profile. The artifact contains `version`, `trusted_source` with `repository` and `commit`, and `profile`. Its digest covers the exact UTF-8 file bytes, including the generator's final LF. Install the same `profiles/<artifact_digest>.json` on both machines. The harness and publisher spell the commit field `commit_sha`. The host producer policy carries the profile and manifest pins. The host profile configuration carries only the installation root and allowed argv. The installed-profile loader verifies the source, both digests and argv when presented with the binding. [Profile schema and digest, verification-profile.ts:22](../../packages/agents/src/contained-profile/verification-profile.ts#L22) · [Installed checks, verification-profile.ts:119](../../packages/agents/src/contained-profile/verification-profile.ts#L119) · [Harness config.ts:11](../../packages/verify-harness/src/config.ts#L11) · [Publisher config.ts:8](../../packages/verify-publisher/src/config.ts#L8) · [Host policy:5](../../packages/core/src/bridge/verification-producer-policy.ts#L5) · [Host configuration:7](../../packages/cli/src/contained-mission-verification-profile-host-config.ts#L7)

The profile pins the official Node 22 Bookworm slim multi-platform image at `node@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb`. The example harness selects Linux/amd64 image ID `sha256:98e6ef9c5dee87d59cef96a25b0f01181723ebe990154dec2025f3ddcddb4f5f`. Docker checks both the local image ID and its repository digest. The profile uses 128 MiB, one CPU, 64 PIDs, a 30-second timeout and 64 KiB per output stream. [Docker Official Images metadata](https://github.com/docker-library/repo-info/blob/master/repos/node/remote/22-bookworm-slim.md) · [Image check, contained-image.ts:75](../../packages/agents/src/contained-image.ts#L75) · [Runtime limits, profile-execution.ts:45](../../packages/agents/src/contained-profile/profile-execution.ts#L45)

## Generate the five files

Use a built checkout containing the trusted Git commit. Copy the example JSON and set the rootless daemon ID, socket path, cloud and host profile installation roots, and host key path for the two machines. The example uses the checklist's App ID `5801554` and installation ID `182960535`. The generator copies the key path as configuration text. It needs no key material. [Example input](../../scripts/drill/sandbox-drill-input.example.json) · [Host producer file, producer-config.ts:12](../../packages/cli/src/contained-mission-verification-producer-config.ts#L12)

```sh
node scripts/drill/generate-sandbox-drill-profile.mjs --input drill-input.json --out-dir drill-output
```

Use a new or empty output directory. Omitting `--out-dir` creates a directory under the managed scratch root and prints its path. The cloud uses `harness.json`, `publisher-allowlist.json` and the artifact under `profiles/`. The host uses a copy of the same artifact and the two mode-0600 files under `bridge/` in its drill home. Generation validates the staged files before exposing the directory. [Harness runbook](../runbooks/bridge-verification-harness.md) · [Publisher runbook](../runbooks/bridge-verification-publisher.md)
