#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scope = process.env.OSSTACK_NPM_SCOPE ?? "@osstack";

try {
  const whoami = await execFileAsync("npm", ["whoami"], { timeout: 10_000 });
  const user = whoami.stdout.trim();
  const access = await execFileAsync("npm", ["access", "list", "packages", scope, "--json"], { timeout: 10_000 });
  let packageCount = 0;
  try {
    const parsed = JSON.parse(access.stdout);
    packageCount = parsed !== null && typeof parsed === "object" ? Object.keys(parsed).length : 0;
  } catch {
    packageCount = 0;
  }
  console.log(JSON.stringify({
    ok: true,
    scope,
    npm_user: user,
    visible_packages: packageCount,
  }, null, 2));
} catch (error) {
  const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
  const scopeMissing = /Scope not found|not found|E404/i.test(output);
  const scopeForbidden = /code E403|E403|Forbidden|not authorized|not authorised|permission|access denied/i.test(output);
  const authMissing = /ENEEDAUTH|need auth|not logged in|code E401/i.test(output);
  const reason = scopeMissing
    ? `${scope} does not exist on npm, or this local account cannot see/administer it.`
    : scopeForbidden
    ? `Local npm account cannot administer ${scope}.`
    : authMissing
    ? "Local npm authentication cannot prove bootstrap or recovery rights for the osstack scope."
    : "Local npm bootstrap/recovery access preflight failed.";
  console.error(reason);
  console.error("");
  console.error("Fix only if first-package bootstrap or manual recovery is required:");
  console.error(`1. Create or claim the npm organization/scope ${scope} on npmjs.com.`);
  console.error(`2. Add the local npm account as an owner or publisher for ${scope}.`);
  console.error("3. Log in locally with that account and rerun this diagnostic.");
  console.error("4. Keep long-lived npm tokens out of the GitHub Release publish step; normal publishing uses OIDC.");
  console.error("");
  console.error(output);
  process.exit(1);
}
