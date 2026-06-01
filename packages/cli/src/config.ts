// `osstack config` — Osstack's agent-configuration control surface.
//
// Configure which agent plays which role (coding / test-verify / design) on
// this machine, probe what's installed, and see how roles resolve (with
// fallback). All commands work without the daemon: we instantiate the shared
// adapter registry directly and probe isAvailable().

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stringify as stringifyYaml } from "yaml";
import { defaultAdapters } from "@osstack/agents";
import type { RoutableAdapter } from "@osstack/core";
import {
  ALL_ROLES,
  ROLE_KINDS,
  configExists,
  configPath,
  currentHostname,
  defaultConfig,
  loadConfig,
  resolveAll,
  saveConfig,
  selectProfile,
  type AgentRole,
  type RoleMap,
} from "@osstack/config";

function adapters(): RoutableAdapter[] {
  return defaultAdapters() as unknown as RoutableAdapter[];
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function overrideFrom(args: string[]): string | undefined {
  return flagValue(args, "--profile") ?? process.env["OSSTACK_PROFILE"];
}

function advertises(a: RoutableAdapter, role: AgentRole): boolean {
  const kinds = ROLE_KINDS[role];
  return a.capabilities().some((c) => kinds.includes(c.kind));
}

export async function handleConfigCommand(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "show":
      return await configShow(args.slice(1));
    case "doctor":
      return await configDoctor();
    case "pick":
      return await configPick(args.slice(1));
    case "init":
      return configInit();
    case "use":
      return configUse(args[1]);
    case "bind":
      return configBind(args[1]);
    case "get":
      return configGet(args.slice(1));
    case "set":
      return configSet(args.slice(1));
    case "help":
      printConfigHelp();
      return 0;
    default:
      console.error(`osstack: unknown config subcommand "${sub}"`);
      printConfigHelp();
      return 1;
  }
}

function printConfigHelp(): void {
  console.log(`osstack config — role-based agent configuration

  osstack config [show] [--profile P]  Show the active profile and how each role resolves
  osstack config doctor                Probe every agent's availability on this machine
  osstack config pick [--profile P]    Interactively choose the primary agent per role
  osstack config init                  Write the default config to ${configPath()}
  osstack config use <profile|auto>    Set active_profile
  osstack config bind <profile>        Attach this machine's hostname to a profile
  osstack config get [path]            Print config (or a dotted path)
  osstack config set <profile>.<role>.<primary|fallback> <value...>
  osstack config set active_profile <name|auto>

Config file: ${configPath()}  (override with OSSTACK_CONFIG)
Roles: coding · test-verify · design

Examples:
  osstack config get mac-mini.coding.primary
  osstack config set mac-mini.test-verify.primary codex-cli
  osstack config set defaults.design.fallback claude-design,google-stitch`);
}

async function configShow(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const override = overrideFrom(args);
  const prof = selectProfile(cfg, override !== undefined ? { override } : {});
  const res = await resolveAll(prof.roles, adapters(), { autoFallback: true });

  console.log(`Osstack — profile: ${prof.name}`);
  console.log(`  (${prof.reason})`);
  console.log(`  hostname: ${currentHostname()}   config: ${configExists() ? configPath() : "(defaults, not yet written)"}`);
  console.log("");
  for (const role of ALL_ROLES) {
    const b = prof.roles[role];
    const r = res[role];
    const chain = [b.primary, ...b.fallback].join(" → ");
    if (r.available && r.chosen) {
      console.log(`  ${role.padEnd(12)} ${r.chosen}`);
      console.log(`  ${"".padEnd(12)} configured: ${chain}`);
      console.log(`  ${"".padEnd(12)} ${r.reason}`);
    } else {
      console.log(`  ${role.padEnd(12)} ⚠ UNAVAILABLE`);
      console.log(`  ${"".padEnd(12)} configured: ${chain}`);
      console.log(`  ${"".padEnd(12)} ${r.reason}`);
    }
    console.log("");
  }
  return 0;
}

async function configDoctor(): Promise<number> {
  const list = adapters();
  console.log("Osstack doctor — agent availability on this machine\n");
  for (const a of list) {
    let mark = "✗";
    let detail = "";
    try {
      const av = await a.isAvailable();
      mark = av.available ? "✓" : "✗";
      detail = av.available ? "available" : `unavailable — ${av.reason ?? "no reason"}`;
    } catch (err) {
      detail = `probe threw — ${err instanceof Error ? err.message : String(err)}`;
    }
    const roles = ALL_ROLES.filter((r) => advertises(a, r));
    console.log(`  ${mark} ${a.id.padEnd(14)} ${detail}`);
    console.log(`    roles: ${roles.length ? roles.join(", ") : "(none)"}`);
  }
  console.log("\nBy role:");
  for (const role of ALL_ROLES) {
    const serving = list.filter((a) => advertises(a, role)).map((a) => a.id);
    console.log(`  ${role.padEnd(12)} ${serving.join(", ") || "(no agents)"}`);
  }
  return 0;
}

async function configPick(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const override = overrideFrom(args);
  const prof = selectProfile(cfg, override !== undefined ? { override } : {});

  // Resolve the RoleMap we will mutate: a named profile, or defaults.
  const target: RoleMap =
    prof.name === "defaults" ? cfg.defaults.roles : cfg.profiles[prof.name]!.roles;

  console.log(`Editing profile: ${prof.name} (${prof.reason})`);
  console.log("Press Enter to keep the current primary.\n");

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const list = adapters();
    for (const role of ALL_ROLES) {
      const candidates = list.filter((a) => advertises(a, role));
      const avail = await Promise.all(
        candidates.map(async (a) => {
          try {
            return (await a.isAvailable()).available;
          } catch {
            return false;
          }
        }),
      );
      console.log(`Role: ${role}  (current primary: ${target[role].primary})`);
      candidates.forEach((a, i) => {
        console.log(`  ${i + 1}) ${a.id}${avail[i] ? "" : "  (not available here)"}`);
      });
      const answer = (await rl.question("  choose number (Enter=keep): ")).trim();
      if (answer !== "") {
        const idx = Number.parseInt(answer, 10) - 1;
        const chosen = candidates[idx];
        if (chosen) {
          const rest = candidates.filter((a) => a.id !== chosen.id).map((a) => a.id);
          target[role] = { primary: chosen.id, fallback: rest };
          console.log(`  → primary set to ${chosen.id}, fallback: [${rest.join(", ")}]`);
        } else {
          console.log("  (invalid choice, kept current)");
        }
      }
      console.log("");
    }
  } finally {
    rl.close();
  }

  const path = saveConfig(cfg);
  console.log(`Saved ${path}`);
  return 0;
}

function configInit(): number {
  if (configExists()) {
    console.log(`osstack: config already exists at ${configPath()} (not overwriting)`);
    return 0;
  }
  const path = saveConfig(defaultConfig());
  console.log(`Wrote default Osstack config to ${path}`);
  return 0;
}

function configUse(name: string | undefined): number {
  if (!name) {
    console.error("osstack: config use <profile|auto>");
    return 1;
  }
  const cfg = loadConfig();
  if (name !== "auto" && !cfg.profiles[name]) {
    console.error(`osstack: no profile named "${name}" (have: ${Object.keys(cfg.profiles).join(", ")})`);
    return 1;
  }
  cfg.active_profile = name;
  const path = saveConfig(cfg);
  console.log(`active_profile = ${name}  (${path})`);
  return 0;
}

function configBind(name: string | undefined): number {
  if (!name) {
    console.error("osstack: config bind <profile>");
    return 1;
  }
  const cfg = loadConfig();
  const prof = cfg.profiles[name];
  if (!prof) {
    console.error(`osstack: no profile named "${name}" (have: ${Object.keys(cfg.profiles).join(", ")})`);
    return 1;
  }
  const host = currentHostname();
  if (!prof.match.hostnames.includes(host)) prof.match.hostnames.push(host);
  const path = saveConfig(cfg);
  console.log(`bound "${host}" to profile "${name}"  (${path})`);
  return 0;
}

function configGet(args: string[]): number {
  const cfg = loadConfig();
  const path = args[0];
  if (!path) {
    process.stdout.write(stringifyYaml(cfg));
    return 0;
  }
  let node: unknown = cfg;
  for (const key of path.split(".")) {
    if (node && typeof node === "object" && key in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[key];
    } else {
      console.error(`osstack: no such config path "${path}"`);
      return 1;
    }
  }
  process.stdout.write(typeof node === "string" ? node + "\n" : stringifyYaml(node));
  return 0;
}

const ROLE_NAMES = new Set<string>(ALL_ROLES);

function configSet(args: string[]): number {
  const path = args[0];
  const rest = args.slice(1);
  if (!path || rest.length === 0) {
    console.error("osstack: config set <path> <value...>");
    return 1;
  }
  const cfg = loadConfig();

  if (path === "active_profile") {
    const name = rest[0]!;
    if (name !== "auto" && !cfg.profiles[name]) {
      console.error(`osstack: no profile named "${name}"`);
      return 1;
    }
    cfg.active_profile = name;
    console.log(`active_profile = ${name}  (${saveConfig(cfg)})`);
    return 0;
  }

  const parts = path.split(".");
  if (parts.length !== 3) {
    console.error('osstack: path must be "<profile>.<role>.<primary|fallback>" or "active_profile"');
    return 1;
  }
  const [scope, role, field] = parts as [string, string, string];
  if (!ROLE_NAMES.has(role)) {
    console.error(`osstack: unknown role "${role}" (coding|test-verify|design)`);
    return 1;
  }
  let roles: RoleMap;
  if (scope === "defaults") {
    roles = cfg.defaults.roles;
  } else {
    const prof = cfg.profiles[scope];
    if (!prof) {
      console.error(`osstack: no profile named "${scope}" (have: ${Object.keys(cfg.profiles).join(", ")}, or "defaults")`);
      return 1;
    }
    roles = prof.roles;
  }
  const binding = roles[role as AgentRole];

  if (field === "primary") {
    binding.primary = rest[0]!;
  } else if (field === "fallback") {
    binding.fallback = rest.join(",").split(/[,\s]+/).filter(Boolean);
  } else {
    console.error(`osstack: unknown field "${field}" (primary|fallback)`);
    return 1;
  }

  const out = saveConfig(cfg);
  console.log(`set ${path} = ${field === "fallback" ? `[${binding.fallback.join(", ")}]` : binding.primary}  (${out})`);
  return 0;
}
