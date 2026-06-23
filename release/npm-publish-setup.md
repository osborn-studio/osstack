# NPM Publish Setup

Scope: `@osstack`
Package: `@osstack/cli`
Repository: `gilosbornhello/osstack`
Required secret: `NPM_TOKEN`
Publish access: `public`

## Console Checklist

- Sign in to npmjs.com with the account that will own the osstack release token.
- Create or claim the @osstack organization/scope on npmjs.com.
- Invite the npm account used for NPM_TOKEN as an owner or publisher for @osstack.
- Confirm @osstack/cli uses public access before publishing.
- Generate an npm automation or publish token from the authorized account.
- Do not paste NPM_TOKEN into chat, logs, issues, or pull requests.
- Update the GitHub repository secret after copying the token once.
- Rerun the Release workflow only after the local and CI npm preflight commands pass.

## GitHub Commands

- `gh secret set NPM_TOKEN --repo gilosbornhello/osstack --body "$NPM_TOKEN"`

## Workflow Commands

- `gh run list --workflow Release --branch main --limit 5`
- `gh run rerun <failed-release-run-id> --repo gilosbornhello/osstack`

## Validation Commands

- `pnpm smoke:npm-preflight`
- `pnpm preflight:npm-publish`
- `osstack release doctor --target npm --json`

## Post-Release Validation Commands

- `npm view @osstack/cli version --json`
- `npm install -g @osstack/cli`
- `osstack --version`
- `osstack loop doctor --workspace . --json`
