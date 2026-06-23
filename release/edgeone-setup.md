# EdgeOne Knowledge Cloud Setup

Provider: `tencent-edgeone`
Service: `osstack-knowledge-cloud`
Project: `osstack-knowledge-cloud`
Default domain: `knowledge.osstack.ai`
Healthcheck: `/healthz`
Deploy secret: `EDGEONE_API_TOKEN`
Fallback deploy secret: `EDGEONE_DEPLOY_HOOK_URL`

## Runtime

- Node: `22`
- Port: `8787`
- Entry: `packages/knowledge-cloud/dist/bin.js`

## Environment

- `OSSTACK_KNOWLEDGE_CLOUD_HOST=0.0.0.0`
- `OSSTACK_KNOWLEDGE_CLOUD_PORT=8787`
- `OSSTACK_KNOWLEDGE_AUDIT_LOG=/data/audit/knowledge-cloud-audit.jsonl`
- `OSSTACK_KNOWLEDGE_FEEDBACK_LOG=/data/feedback/feedback.jsonl`
- `OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR=/data/published-packs`

## Include Files

- `knowledge-packs/official/**`
- `packages/knowledge-cloud/dist/**`
- `packages/knowledge/dist/**`

## Console Checklist

- Create an EdgeOne Pages project connected to gilosbornhello/osstack.
- Configure the EdgeOne project to build from main.
- Use deploy/knowledge-cloud/edgeone.json as the source of truth for runtime, healthcheck, storage paths, and official pack include paths.
- Set EdgeOne runtime env OSSTACK_KNOWLEDGE_CLOUD_HOST=0.0.0.0.
- Set EdgeOne runtime env OSSTACK_KNOWLEDGE_CLOUD_PORT=8787.
- Set EdgeOne runtime env OSSTACK_KNOWLEDGE_AUDIT_LOG=/data/audit/knowledge-cloud-audit.jsonl.
- Set EdgeOne runtime env OSSTACK_KNOWLEDGE_FEEDBACK_LOG=/data/feedback/feedback.jsonl.
- Set EdgeOne runtime env OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR=/data/published-packs.
- Create an EdgeOne API token for Makers project osstack-knowledge-cloud and keep it private.
- Optionally create an EdgeOne deploy hook as a fallback and keep the hook URL private.
- Record the production URL, expected default domain knowledge.osstack.ai, and health path /healthz.

## GitHub Commands

- `gh secret set EDGEONE_API_TOKEN --repo gilosbornhello/osstack --body "$EDGEONE_API_TOKEN"`
- `# Optional fallback: gh secret set EDGEONE_DEPLOY_HOOK_URL --repo gilosbornhello/osstack --body "$EDGEONE_DEPLOY_HOOK_URL"`

## Workflow Commands

- `gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=false`
- `gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true -f cloud_url=https://knowledge.osstack.ai`

## Validation Commands

- `osstack release doctor --target knowledge-cloud --cloud-url https://knowledge.osstack.ai --json`
- `osstack knowledge sync --cloud-url https://knowledge.osstack.ai --json`
- `osstack knowledge search "proof pack checksum" --cloud-url https://knowledge.osstack.ai --json`
