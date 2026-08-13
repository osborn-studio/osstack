// Discovering which OSSTACK_HOME the *deployed* daemon actually serves.
//
// Why this exists: paths.ts defaults OSSTACK_HOME to ~/.osstack, but a
// launchd-managed daemon is usually started with a different home (this
// machine serves ~/.osstack-stable). A plain shell has neither OSSTACK_HOME
// nor OSSTACK_SOCKET exported, so every daemon-touching command resolved
// ~/.osstack/daemon.sock, found nothing, and reported "daemon: not running"
// while the daemon was healthy — `osstack doctor` then recommended queue work
// against a daemon it could not see. Same defect class as the upgrade-time
// provisioning bug fixed in #204, but on the read path.
//
// Discovery must stay CHEAP: this runs on every invocation and the startup
// budget is 150ms (see AGENTS.md → Performance Budgets). At most two small
// readFileSync calls, never a subprocess — resolving the role file via
// `npm root -g` would cost 100-500ms of spawn.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoleFile } from "./control-plane-guard.js";

const LAUNCHD_LABEL = "ai.osstack.daemon";

export function daemonPlistPath(): string {
  const directory = process.env["OSSTACK_LAUNCH_AGENTS_DIR"]
    ?? join(homedir(), "Library", "LaunchAgents");
  return join(directory, `${LAUNCHD_LABEL}.plist`);
}

export interface DeployedEnv {
  home: string;
  socket?: string;
  source: "launchd plist" | "role file";
}

/** Expand a leading ~ and normalize; env paths must be absolute for paths.ts. */
export function expandHome(value: string): string {
  return resolve(value.replace(/^~(?=$|\/)/, homedir()));
}

function plistEnvValue(plistText: string, key: string): string | undefined {
  const match = plistText.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`),
  );
  const value = match?.[1];
  return value !== undefined && value !== "" ? value : undefined;
}

/**
 * Where the deployed daemon lives, or null when nothing is deployed.
 *
 * Priority mirrors `osstack upgrade` (#204): the launchd plist is
 * authoritative because it is how the daemon is actually started, and
 * `serve --install` re-renders it whenever the served home changes. The role
 * file next to the running binary is the fallback for non-launchd installs.
 */
export function discoverDeployedEnv(
  plistPath: string = daemonPlistPath(),
  moduleUrl: string = import.meta.url,
): DeployedEnv | null {
  try {
    if (existsSync(plistPath)) {
      const plistText = readFileSync(plistPath, "utf8");
      const home = plistEnvValue(plistText, "OSSTACK_HOME");
      if (home !== undefined) {
        const socket = plistEnvValue(plistText, "OSSTACK_SOCKET");
        return {
          home,
          ...(socket === undefined ? {} : { socket }),
          source: "launchd plist",
        };
      }
    }
  } catch { /* unreadable/binary plist — fall through to the role file */ }

  try {
    // The role file sits beside the running dist bundle — the same directory
    // the serve guard reads, so no package-manager lookup is needed.
    const here = dirname(realpathSync(fileURLToPath(moduleUrl)));
    const home = loadRoleFile(here)?.allowed_osstack_homes[0];
    if (home !== undefined) return { home, source: "role file" };
  } catch { /* absent or invalid role file — nothing deployed */ }

  return null;
}

/**
 * Point this process at the deployed daemon when the caller did not say
 * otherwise. An explicitly exported OSSTACK_HOME/OSSTACK_SOCKET always wins,
 * so dev and test homes keep working; we only fill what is missing.
 *
 * Returns the discovery used, or null when nothing was applied.
 */
export function applyDeployedEnvDefaults(
  env: NodeJS.ProcessEnv = process.env,
  discovered?: DeployedEnv | null,
): DeployedEnv | null {
  if (env["OSSTACK_HOME"] !== undefined) return null;
  const deployed = discovered ?? discoverDeployedEnv();
  if (deployed === null) return null;

  env["OSSTACK_HOME"] = expandHome(deployed.home);
  if (deployed.socket !== undefined && env["OSSTACK_SOCKET"] === undefined) {
    env["OSSTACK_SOCKET"] = expandHome(deployed.socket);
  }
  return deployed;
}
