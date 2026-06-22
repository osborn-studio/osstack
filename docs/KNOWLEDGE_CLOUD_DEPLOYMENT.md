# Knowledge Cloud Deployment

Status: deployable MVP for official Osstack knowledge packs.

## Runtime Contract

- Executable: `osstack-knowledge-cloud`
- Dockerfile: `Dockerfile.knowledge-cloud`
- Default port: `8787`
- Health endpoint: `/healthz`
- Official pack source: `knowledge-packs/official/index.json`
- Required runtime env:
  - `OSSTACK_KNOWLEDGE_CLOUD_HOST=0.0.0.0`
  - `OSSTACK_KNOWLEDGE_CLOUD_PORT=8787`

## Local Smoke

```bash
pnpm smoke:knowledge-cloud
pnpm smoke:knowledge-cloud:deploy
```

The first command starts the built service, checks `/healthz`, lists official packs, and searches the official proof pack. The second command verifies Docker/Fly/Render deployment assets agree on the executable, port, and healthcheck.

## Docker

```bash
docker build -f Dockerfile.knowledge-cloud -t osstack-knowledge-cloud .
docker run --rm -p 8787:8787 osstack-knowledge-cloud
curl http://127.0.0.1:8787/healthz
```

## Fly.io

```bash
fly launch --copy-config --config deploy/knowledge-cloud/fly.toml
fly deploy --config deploy/knowledge-cloud/fly.toml
fly status --config deploy/knowledge-cloud/fly.toml
```

Set the final app name and region in `deploy/knowledge-cloud/fly.toml` before production deploy.

## Render

Create a Blueprint from `deploy/knowledge-cloud/render.yaml`. The service uses `Dockerfile.knowledge-cloud`, binds to `0.0.0.0:8787`, and reports health through `/healthz`.

## Client Setup

```bash
osstack knowledge login --cloud-url https://knowledge.osstack.ai
osstack knowledge sync
osstack knowledge search "proof pack checksum"
```

If the cloud endpoint is unavailable, osstack knowledge search fails open to cached packs or local/off mode.

## Production Notes

- Keep official packs Osstack-native and versioned.
- Do not publish raw upstream knowledge mirrors.
- Add private packs through the `/v1/private-packs` path or tenant-specific deployment config.
- Persist feedback before using it for quality scoring.
- Add object storage/Postgres/vector search when the in-memory MVP no longer fits the pack volume.
