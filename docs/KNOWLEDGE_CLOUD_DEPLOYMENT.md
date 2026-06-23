# Knowledge Cloud Deployment

Status: deployable MVP for official Osstack knowledge packs.

## Runtime Contract

- Executable: `osstack-knowledge-cloud`
- Dockerfile: `Dockerfile.knowledge-cloud`
- Default port: `8787`
- Health endpoint: `/healthz`
- Official pack source: `knowledge-packs/official/index.json`
- Published pack storage: `OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR`
- Required runtime env:
  - `OSSTACK_KNOWLEDGE_CLOUD_HOST=0.0.0.0`
  - `OSSTACK_KNOWLEDGE_CLOUD_PORT=8787`

## Local Smoke

```bash
pnpm smoke:knowledge-cloud
pnpm smoke:knowledge-cloud:deploy
```

The first command starts the built service, checks `/healthz`, lists official packs, searches the official proof pack, publishes an approved pack through `/v1/publish`, and verifies the manifest is persisted. The second command verifies Docker/EdgeOne/Render deployment assets agree on the executable, port, healthcheck, feedback log, and published pack storage paths.

## Docker

```bash
docker build -f Dockerfile.knowledge-cloud -t osstack-knowledge-cloud .
docker run --rm -p 8787:8787 osstack-knowledge-cloud
curl http://127.0.0.1:8787/healthz
```

## EdgeOne

EdgeOne is the preferred production deployment target for Osstack Knowledge Cloud.
Fly.io is not required for the current production path; keep it only as an optional
reference if a second deployment target is needed later.

### EdgeOne production checklist

Generate the operator handoff first:

```bash
osstack release edgeone --cloud-url <EdgeOne URL> --output edgeone-setup.md --json
```

The command reads `deploy/knowledge-cloud/edgeone.json` and emits the EdgeOne
console checklist, required runtime environment, GitHub secret command,
workflow trigger command, and deployed URL validation commands.

1. Create an EdgeOne Pages project connected to `gilosbornhello/osstack`.
2. Configure the project to build from `main`.
3. Use `deploy/knowledge-cloud/edgeone.json` as the source of truth for runtime
   env, healthcheck, storage paths, and official pack include paths.
4. Add at least these runtime env vars in EdgeOne:
   - `OSSTACK_KNOWLEDGE_CLOUD_HOST=0.0.0.0`
   - `OSSTACK_KNOWLEDGE_CLOUD_PORT=8787`
   - `OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR=/data/published-packs`
   - `OSSTACK_KNOWLEDGE_AUDIT_LOG=/data/audit/knowledge-cloud-audit.jsonl`
   - `OSSTACK_KNOWLEDGE_FEEDBACK_LOG=/data/feedback/feedback.jsonl`
5. Create an EdgeOne API Token for Makers deployment.
6. Save the token as the GitHub repository secret:

   ```bash
   gh secret set EDGEONE_API_TOKEN --repo gilosbornhello/osstack --body "$EDGEONE_API_TOKEN"
   ```

   `EDGEONE_DEPLOY_HOOK_URL` is still supported as a fallback if the project is
   already configured around EdgeOne WebHook deployment.

7. Validate release/deploy readiness before publishing:

   ```bash
   osstack release doctor --target knowledge-cloud --json
   ```

8. Run `.github/workflows/knowledge-cloud-deploy.yml` with `deploy=true`.
9. If the production URL is already known, pass it as the workflow `cloud_url`
   input so the deploy workflow runs the health/search/audit handoff checks
   immediately after triggering EdgeOne.
10. Record the production URL and run cloud acceptance checks:

   ```bash
   osstack release doctor --target knowledge-cloud --cloud-url <EdgeOne URL> --json
   osstack knowledge sync --cloud-url <EdgeOne URL> --json
   osstack knowledge search "proof pack checksum" --cloud-url <EdgeOne URL> --json
   ```

11. Keep the EdgeOne production URL in the release evidence and use it as the
    default Knowledge Cloud endpoint once the acceptance checks pass.

The EdgeOne deployment manifest is `deploy/knowledge-cloud/edgeone.json`. It records the health endpoint, Node runtime expectation, official pack include paths, and persisted audit/feedback/published-pack paths.

### EdgeOne console walkthrough

Use this flow when an operator is logged in to Tencent Cloud / EdgeOne and wants
to finish the production setup without exposing hook URLs in chat or issue text.

1. Open the EdgeOne Pages console and create a new project by importing a Git
   repository.
2. Authorize GitHub access if EdgeOne asks for it, then select
   `gilosbornhello/osstack`.
3. Select `main` as the production branch.
4. In build settings, use the repository root as the project root. Keep the
   runtime aligned with Node `22`.
5. Add the runtime env vars listed in the checklist above. Do not add npm,
   GitHub, EdgeOne hook, or private tenant tokens to public build logs.
6. In the EdgeOne Makers API Token tab, create a production deployment token.
   Copy it once into a local shell variable:

   ```bash
   export EDGEONE_API_TOKEN='<paste EdgeOne API token locally>'
   ```

7. Store it in GitHub Secrets from the local terminal:

   ```bash
   gh secret set EDGEONE_API_TOKEN --repo gilosbornhello/osstack --body "$EDGEONE_API_TOKEN"
   ```

   Optional fallback for existing hook-based projects:

   ```bash
   gh secret set EDGEONE_DEPLOY_HOOK_URL --repo gilosbornhello/osstack --body "$EDGEONE_DEPLOY_HOOK_URL"
   ```

8. Run local checks before spending GitHub Actions minutes:

   ```bash
   pnpm smoke:knowledge-cloud:deploy
   osstack release doctor --target knowledge-cloud --json
   ```

9. Only after the project and one deploy credential are ready
   (`EDGEONE_API_TOKEN`, or fallback `EDGEONE_DEPLOY_HOOK_URL`), decide whether
   to spend Actions minutes on the remote deploy workflow:

   ```bash
   gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true -f cloud_url=<EdgeOne URL>
   ```

Official references:

- EdgeOne Pages quick deploy from GitHub: <https://edgeone.ai/document/162227908259442688>
- EdgeOne Pages build guide and environment variables: <https://edgeone.ai/document/162227908250005504>
- EdgeOne CLI and API Token deployment: <https://edgeone.ai/document/162227908259442688>
- EdgeOne Pages WebHook release note: <https://edgeone.ai/document/177158578324279296>

## Fly.io Optional Reference

`deploy/knowledge-cloud/fly.toml` remains as an optional reference for teams that prefer Fly.io, but it is no longer the primary osstack production path.

## GitHub Actions Deploy

The manual workflow `.github/workflows/knowledge-cloud-deploy.yml` runs build, tests, service smoke, deploy-asset smoke, and a Docker image build on `ubuntu-latest`.

- Run with `deploy=false` to validate the deploy bundle without publishing.
- Set repository secret `EDGEONE_API_TOKEN` to deploy through `edgeone makers deploy`.
- `EDGEONE_DEPLOY_HOOK_URL` remains supported as a fallback when no API token is configured.
- Run with `deploy=true` only after one of those deploy credentials is configured.
- Pass `cloud_url=<EdgeOne URL>` with `deploy=true` to run deployed
  Knowledge Cloud health/search/audit acceptance checks inside the workflow.
- Do not set `FLY_API_TOKEN` for the primary path; it is unrelated to the EdgeOne deployment.

Preflight release and deploy credentials before a production run:

```bash
osstack release doctor --target knowledge-cloud --json
```

If both `EDGEONE_API_TOKEN` and `EDGEONE_DEPLOY_HOOK_URL` are missing and `deploy=true`, the workflow fails before deployment so a validation-only run cannot be mistaken for a published cloud service.

## Render

Create a Blueprint from `deploy/knowledge-cloud/render.yaml`. The service uses `Dockerfile.knowledge-cloud`, binds to `0.0.0.0:8787`, and reports health through `/healthz`.

## Client Setup

```bash
osstack knowledge login --cloud-url https://knowledge.osstack.ai
osstack knowledge sync
osstack knowledge search "proof pack checksum"
```

If the cloud endpoint is unavailable, osstack knowledge search fails open to cached packs or local/off mode.
Use `--stale-after-days N` to include cache freshness evidence in local or fallback
search results. The default `--stale-policy warn` keeps this path fail-open; use
`--stale-policy strict` in release checks when stale cached knowledge should fail
the command until `osstack knowledge sync` refreshes the cache.

## Production Notes

- Keep official packs Osstack-native and versioned.
- Run `osstack knowledge validate --official` before publishing official cloud packs.
- Do not publish raw upstream knowledge mirrors.
- Add private packs through the `/v1/private-packs` path or tenant-specific deployment config.
- Set `OSSTACK_KNOWLEDGE_PRIVATE_TOKEN` for deployments that expose team/private packs; private sync/search requests must send `Authorization: Bearer <token>` and the matching `tenant_id`.
- Persist feedback before using it for quality scoring.
- Set `OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR` to persist `/v1/publish` official packs under `official/` and tenant/private packs under `private/<tenant_id>/`.
- Add object storage/Postgres/vector search when file-backed published packs and BM25-style search no longer fit the pack volume.
