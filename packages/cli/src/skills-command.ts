import {
  addSource,
  checkAll,
  defaultManifestPath,
  readManifest,
  removeSource,
  writeManifest,
} from "@osstack/skill-registry";

export interface SkillsCommandDeps {
  manifestPath?: typeof defaultManifestPath;
  readManifest?: typeof readManifest;
  writeManifest?: typeof writeManifest;
  checkAll?: typeof checkAll;
  addSource?: typeof addSource;
  removeSource?: typeof removeSource;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function handleSkillsCommand(
  args: string[],
  deps: SkillsCommandDeps = {},
): Promise<number> {
  const resolveManifestPath = deps.manifestPath ?? defaultManifestPath;
  const loadManifest = deps.readManifest ?? readManifest;
  const saveManifest = deps.writeManifest ?? writeManifest;
  const checkSources = deps.checkAll ?? checkAll;
  const upsertSource = deps.addSource ?? addSource;
  const deleteSource = deps.removeSource ?? removeSource;
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];
  const path = resolveManifestPath();

  if (sub === "list" || sub === undefined) {
    const manifest = loadManifest(path);
    stdout(`Skill manifest: ${path}`);
    stdout(`Schema version: ${manifest.version}`);
    stdout(`Tracked sources: ${manifest.sources.length}`);
    for (const source of manifest.sources) {
      const blessed = source.blessed_sha === null
        ? "(none)"
        : source.blessed_sha.slice(0, 12);
      stdout(`  • ${source.id}  ref=${source.ref}  blessed=${blessed}  auto_minor=${source.auto_minor}`);
      stdout(`      ${source.origin}`);
      if (source.notes) stdout(`      ${source.notes}`);
    }
    return 0;
  }

  if (sub === "check") {
    const manifest = loadManifest(path);
    stdout(`Checking ${manifest.sources.length} source(s) against their tracked refs...`);
    const result = await checkSources(manifest);
    let drifted = 0;
    let failed = 0;
    for (const entry of result.entries) {
      if (!entry.ok) {
        failed += 1;
        stdout(`  ✗ ${entry.source.id}  unreachable: ${entry.reason}`);
        continue;
      }
      if (entry.drifted) {
        drifted += 1;
        const head = entry.current_sha?.slice(0, 12) ?? "?";
        const blessed = entry.source.blessed_sha?.slice(0, 12) ?? "(none)";
        stdout(`  ⚠ ${entry.source.id}  drift  blessed=${blessed}  head=${head}  ref=${entry.source.ref}`);
      } else {
        stdout(`  ✓ ${entry.source.id}  up-to-date (${entry.current_sha?.slice(0, 12)})`);
      }
    }
    stdout(`\n${failed} source(s) failed to check.`);
    stdout(`${drifted} source(s) drifted from blessed_sha.`);
    if (failed > 0) return 1;
    return drifted > 0 ? 2 : 0;
  }

  if (sub === "add") {
    const id = args[1];
    const origin = args[2];
    const ref = args[3] ?? "main";
    if (!id || !origin) {
      stderr("usage: osstack skills add <id> <origin-url> [ref]");
      return 1;
    }
    const manifest = loadManifest(path);
    const next = upsertSource(manifest, { id, origin, ref });
    saveManifest(next, path);
    stdout(`added ${id} (${origin} @ ${ref})`);
    return 0;
  }

  if (sub === "remove") {
    const id = args[1];
    if (!id) {
      stderr("usage: osstack skills remove <id>");
      return 1;
    }
    const manifest = loadManifest(path);
    const next = deleteSource(manifest, id);
    saveManifest(next, path);
    stdout(`removed ${id}`);
    return 0;
  }

  if (sub === "bless") {
    const id = args[1];
    if (!id) {
      stderr("usage: osstack skills bless <id>");
      return 1;
    }
    const manifest = loadManifest(path);
    const source = manifest.sources.find((candidate) => candidate.id === id);
    if (!source) {
      stderr(`no source with id=${id}`);
      return 1;
    }
    const result = await checkSources({ version: 1, sources: [source] });
    const entry = result.entries[0]!;
    if (!entry.ok || !entry.current_sha) {
      stderr(`could not fetch head: ${entry.reason}`);
      return 1;
    }
    const next = upsertSource(manifest, {
      id: source.id,
      origin: source.origin,
      ref: source.ref,
      blessed_sha: entry.current_sha,
      last_checked: result.generated_at,
    });
    saveManifest(next, path);
    stdout(`blessed ${id} @ ${entry.current_sha.slice(0, 12)}`);
    return 0;
  }

  if (sub === "help") {
    stdout(`osstack skills — external skill registry (S6)

  osstack skills list                       Show tracked sources + versions
  osstack skills add <id> <origin> [ref]    Add or update a source
  osstack skills remove <id>                Remove a source
  osstack skills check                      Compare blessed_sha vs origin HEAD
  osstack skills bless <id>                 Pin the current HEAD as blessed
  osstack skills help                       This help

Manifest path: ${path}
`);
    return 0;
  }

  stderr(`osstack: unknown skills subcommand "${sub}"`);
  return 1;
}
