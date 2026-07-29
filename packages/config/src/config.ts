// Osstack config loading / saving / profile selection.
//
// Config lives at $OSSTACK_CONFIG, else ~/.osstack/config.yaml. If the file is
// missing, loadConfig() returns a built-in default (it is NOT written to disk
// until `config init` / `config set` / saveConfig is called explicitly).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OsstackConfig, type OsstackConfig as OsstackConfigT, type RoleMap } from "./types.js";

export function osstackHome(): string {
  return process.env["OSSTACK_HOME"] ?? join(process.env["HOME"] ?? "", ".osstack");
}

export function configPath(): string {
  return process.env["OSSTACK_CONFIG"] ?? join(osstackHome(), "config.yaml");
}

// Mac Mini: code with Claude Code, verify with Kimi, design with Claude Design.
const MAC_MINI_ROLES: RoleMap = {
  coding: { primary: "claude-code", fallback: ["codex-cli"] },
  "test-verify": {
    primary: "kimi-code",
    fallback: ["codex-cli", "claude-cli"],
  },
  design: { primary: "claude-design", fallback: ["google-stitch"] },
};

// MacBook Pro: code with Codex, verify with Kimi, design with Stitch.
const MACBOOK_ROLES: RoleMap = {
  coding: { primary: "codex-cli", fallback: ["claude-code"] },
  "test-verify": {
    primary: "kimi-code",
    fallback: ["claude-code", "codex-cli"],
  },
  design: { primary: "google-stitch", fallback: ["claude-design"] },
};

export function defaultConfig(): OsstackConfigT {
  return OsstackConfig.parse({
    version: 1,
    active_profile: "auto",
    profiles: {
      "mac-mini": {
        match: {
          hostnames: [],
          model_hints: ["Macmini"],
        },
        roles: MAC_MINI_ROLES,
      },
      "macbook-pro": {
        match: {
          hostnames: [],
          model_hints: ["MacBookPro"],
        },
        roles: MACBOOK_ROLES,
      },
    },
    defaults: { roles: MAC_MINI_ROLES },
  });
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export function loadConfig(): OsstackConfigT {
  const path = configPath();
  if (!existsSync(path)) return defaultConfig();
  const raw = readFileSync(path, "utf8");
  return OsstackConfig.parse(parseYaml(raw) ?? {});
}

export function saveConfig(config: OsstackConfigT): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  // Re-parse to normalise (apply defaults, drop unknown keys) before writing.
  writeFileSync(path, stringifyYaml(OsstackConfig.parse(config)), "utf8");
  return path;
}

export interface ResolvedProfile {
  name: string;
  roles: RoleMap;
  reason: string;
}

export interface SelectOpts {
  hostname?: string;
  model?: string;
  /** Explicit override (CLI --profile, $OSSTACK_AGENT_PROFILE, or $OSSTACK_PROFILE). */
  override?: string | undefined;
}

/**
 * Pick the active profile. Priority:
 *   1. explicit override (flag/env)
 *   2. active_profile, when not "auto"
 *   3. hostname match against each profile's match.hostnames
 *   4. defaults
 */
export function selectProfile(config: OsstackConfigT, opts: SelectOpts = {}): ResolvedProfile {
  const hostname = opts.hostname ?? osHostname();
  const model = opts.model ?? currentMacModel();
  const pin =
    opts.override ??
    (config.active_profile !== "auto" ? config.active_profile : undefined);

  if (pin) {
    const p = config.profiles[pin];
    if (p) return { name: pin, roles: p.roles, reason: `pinned profile "${pin}"` };
    return {
      name: "defaults",
      roles: config.defaults.roles,
      reason: `pinned profile "${pin}" not found; using defaults`,
    };
  }

  const target = hostname.toLowerCase();
  const modelTarget = model.toLowerCase();
  for (const [name, p] of Object.entries(config.profiles)) {
    if (p.match.hostnames.some((h) => h.toLowerCase() === target)) {
      return { name, roles: p.roles, reason: `hostname "${hostname}" matched profile "${name}"` };
    }
    if (modelTarget !== "" && p.match.model_hints.some((hint) => modelTarget.includes(hint.toLowerCase()))) {
      return { name, roles: p.roles, reason: `model "${model}" matched profile "${name}"` };
    }
  }

  return {
    name: "defaults",
    roles: config.defaults.roles,
    reason: `no profile matched hostname "${hostname}"; using defaults`,
  };
}

export function currentHostname(): string {
  return osHostname();
}

export function currentMacModel(): string {
  try {
    return execFileSync("sysctl", ["-n", "hw.model"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
