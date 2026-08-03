# NPM Publish Setup

Scope: `@osstack`
Package: `@osstack/cli`
Repository: `gilosbornhello/osstack`
Authentication: `trusted-publishing-oidc`
Required long-lived publish secret: `none`
Publish access: `public`

## Official References

- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- npm trust command: https://docs.npmjs.com/cli/v11/commands/npm-trust/
- npm scoped public package docs: https://docs.npmjs.com/creating-and-publishing-scoped-public-packages
- npm organization package access docs: https://docs.npmjs.com/managing-team-access-to-organization-packages

## Console Checklist

- Sign in to npmjs.com with an account that can administer every public @osstack package.
- Create or claim the @osstack organization/scope on npmjs.com.
- Manually publish the first version of any new public package because a Trusted Publisher can be configured only after the package exists.
- For every public package, configure GitHub Actions Trusted Publisher gilosbornhello/osstack / release.yml with publish permission.
- Confirm @osstack/cli uses public access before publishing.
- After one successful OIDC release, set publishing access to require 2FA and disallow tokens where operationally appropriate.
- Use local npm login/token access only for first-package bootstrap or manual recovery; never expose it to the Release publish step.
- Run pnpm preflight:npm-trust in an interactive terminal and complete npm's fresh 2FA/web authentication to verify every package mapping.
- Rerun the Release workflow only after the package bootstrap and install gates pass.

## GitHub Commands

No repository secret command is required for npm publishing.

## Workflow Commands

- `gh run list --workflow Release --branch main --limit 5`
- `gh run rerun <failed-release-run-id> --repo gilosbornhello/osstack`

## Validation Commands

- `pnpm smoke:npm-preflight`
- `pnpm smoke:npm-bootstrap`
- `pnpm preflight:npm-bootstrap`
- `pnpm smoke:npm-trust`
- `pnpm preflight:npm-trust`
- `osstack release doctor --target npm --json`

## Post-Release Validation Commands

- `npm view @osstack/cli version --json`
- `npm install -g @osstack/cli`
- `osstack --version`
- `osstack loop doctor --workspace . --json`
