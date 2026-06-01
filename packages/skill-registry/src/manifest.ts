// Skill manifest — ~/.osstack/skills.config.yaml.
//
// Tracks external skill packages osstack knows about, their git origin,
// the version we currently treat as "blessed", and per-skill flags
// (auto-update for patch versions, require human approval for major bumps,
// etc.). The schema is intentionally small so users can hand-edit.

import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as yaml from "js-yaml";

export const SkillSource = z.object({
  /** Stable identifier (e.g. "gstack", "everything-claude-code", "anthropic-skills"). */
  id: z.string().min(1),
  /** Display name. */
  name: z.string().default(""),
  /** Git origin URL (https or ssh). */
  origin: z.string().url().or(z.string().regex(/^git@/)),
  /** Branch or tag pin. Use a tag when you want stability; branch when you
   *  trust the upstream. Default "main". */
  ref: z.string().default("main"),
  /** SHA we currently consider blessed. Null until the first ingest. */
  blessed_sha: z.string().nullable().default(null),
  /** Last time we successfully checked the origin (ISO 8601). */
  last_checked: z.string().nullable().default(null),
  /** Auto-promote minor/patch bumps. Default false (every change goes through review). */
  auto_minor: z.boolean().default(false),
  /** Optional notes the user keeps about why this skill is tracked. */
  notes: z.string().default(""),
});

export type SkillSource = z.infer<typeof SkillSource>;

export const SkillManifest = z.object({
  version: z.literal(1).default(1),
  sources: z.array(SkillSource).default([]),
});

export type SkillManifest = z.infer<typeof SkillManifest>;

export function defaultManifestPath(): string {
  const home = process.env["OSSTACK_HOME"] ?? join(process.env["HOME"] ?? "", ".osstack");
  return join(home, "skills.config.yaml");
}

const STARTER_SOURCES: SkillSource[] = [
  SkillSource.parse({
    id: "gstack",
    name: "GStack (Garry Tan)",
    origin: "https://github.com/garrytan/gstack.git",
    ref: "main",
    notes: "Reference for CEO/Eng/Design review skills. Watched but not auto-pulled.",
  }),
  SkillSource.parse({
    id: "everything-claude-code",
    name: "Everything Claude Code",
    origin: "https://github.com/anthropics/claude-cookbooks.git",
    ref: "main",
    notes: "Sandboxed for now — narrow inclusion list per skill.",
  }),
  SkillSource.parse({
    id: "anthropic-skills",
    name: "Anthropic skill marketplace",
    origin: "https://github.com/anthropics/claude-agent-sdk-demos.git",
    ref: "main",
    notes: "Official agent SDK examples.",
  }),
];

export function readManifest(path: string = defaultManifestPath()): SkillManifest {
  if (!existsSync(path)) {
    return SkillManifest.parse({ version: 1, sources: STARTER_SOURCES });
  }
  const raw = readFileSync(path, "utf8");
  const parsed = yaml.load(raw) as unknown;
  return SkillManifest.parse(parsed);
}

export function writeManifest(manifest: SkillManifest, path: string = defaultManifestPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dumped = yaml.dump(manifest, { lineWidth: 100, noRefs: true, sortKeys: false });
  writeFileSync(path, `# osstack skill registry manifest. Hand-edits are fine.\n# Generated/updated by \`osstack skills\` commands.\n\n${dumped}`);
}

export function addSource(manifest: SkillManifest, src: Partial<SkillSource> & { id: string; origin: string }): SkillManifest {
  const parsed = SkillSource.parse({ ref: "main", ...src });
  const idx = manifest.sources.findIndex((s) => s.id === parsed.id);
  const sources = manifest.sources.slice();
  if (idx >= 0) sources[idx] = parsed;
  else sources.push(parsed);
  return { ...manifest, sources };
}

export function removeSource(manifest: SkillManifest, id: string): SkillManifest {
  return { ...manifest, sources: manifest.sources.filter((s) => s.id !== id) };
}
