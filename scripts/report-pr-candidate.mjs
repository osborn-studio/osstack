#!/usr/bin/env node
import { mkdir, realpath, writeFile, readFile, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scratchRoot } from './lib/scratch.mjs';

const help = `Read one GitHub PR candidate snapshot. This is not a merge authorization.
Usage: node scripts/report-pr-candidate.mjs --repo OWNER/REPO --pr N --output ABSOLUTE_NEW_ROOT
       [--expect-head SHA40 --expect-base SHA40] [--required-check NAME ...]
The new output must be under OSSTACK_SCRATCH_ROOT. Its parent must exist.
Exit 0: report written (may contain blockers or unknowns). Exit 2: invalid input/output.
Exit 3: initial identity unavailable or report could not be written.
No watcher, retry, candidate execution, approval, Ready mutation or merge.
Required check names are caller-declared; forge policy is not collected.
`;
function parse(args) {
  const values = new Map(), requiredChecks = [];
  const allowed = ['--repo', '--pr', '--output', '--expect-head', '--expect-base', '--required-check'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.includes(key) || typeof value !== 'string' || value.startsWith('--')) throw new Error('invalid_arguments');
    if (key === '--required-check') requiredChecks.push(value);
    else { if (values.has(key)) throw new Error('duplicate_argument'); values.set(key, value); }
  }
  if (!values.has('--repo') || !/^[1-9][0-9]*$/.test(values.get('--pr') ?? '') || !values.has('--output')) throw new Error('missing_arguments');
  const input = { repo: values.get('--repo'), pr: Number(values.get('--pr')), requiredChecks };
  if (values.has('--expect-head')) input.expectedHead = values.get('--expect-head');
  if (values.has('--expect-base')) input.expectedBase = values.get('--expect-base');
  return { input, output: values.get('--output') };
}
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The optional runner is an offline test seam, not a separate proof of forge identity. */
export async function runPrCandidateReport(args, dependencies = {}) {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, help };
  let prepared, library, output;
  try {
    prepared = parse(args);
    library = await import('../packages/github/dist/pr-candidate-snapshot.js');
    library.validatePrCandidateInput(prepared.input);
    if (!isAbsolute(prepared.output)) throw new Error('absolute_output_required');
    const root = await realpath(scratchRoot());
    const parent = await realpath(dirname(resolve(prepared.output)));
    output = join(parent, resolve(prepared.output).split(sep).at(-1));
    if (!within(root, output)) throw new Error('output_outside_scratch');
    // mkdir is exclusive: existing files, directories and terminal symlinks all refuse.
    await mkdir(output, { mode: 0o700 });
  } catch { return { exitCode: 2, error: 'input_or_output_refused' }; }
  try {
    const observation = await library.inspectPrCandidate(prepared.input, dependencies.runner, dependencies.clock);
    await mkdir(join(output, 'raw'), { mode: 0o700 });
    const files = [];
    const write = async (path, content) => {
      const bytes = Buffer.from(content);
      await writeFile(join(output, path), bytes, { flag: 'wx', mode: 0o600 });
      const retained = await readFile(join(output, path));
      if (!retained.equals(bytes)) throw new Error('write_verification_failed');
      files.push({ path, bytes: bytes.length, sha256: digest(bytes), mode: (await lstat(join(output, path))).mode & 0o777 });
    };
    await write('snapshot.json', `${JSON.stringify(observation.snapshot, null, 2)}\n`);
    await write('queries.json', `${JSON.stringify(observation.queries, null, 2)}\n`);
    for (const raw of observation.raw) {
      // Labels are fixed by the collector; never use forge fields as filenames.
      if (!/^(initial|final|checks-[1-3]|threads-[1-3])$/.test(raw.label)) throw new Error('invalid_raw_label');
      await write(`raw/${raw.label}.stdout`, raw.stdout);
      await write(`raw/${raw.label}.stderr`, raw.stderr);
    }
    const manifest = {
      schema_version: 1, kind: 'pr_candidate_snapshot', repo: observation.snapshot.repo, pr: observation.snapshot.pr,
      binding: observation.snapshot.binding, execution_path: dependencies.runner ? 'injected_runner' : 'default_delivery_runner',
      files, merge_authorized: false, limitations: 'Hashes bind retained files only, not forge authenticity or an atomic transaction. No environment values are recorded.',
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(output, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    if (!(await readFile(join(output, 'manifest.json'))).equals(manifestBytes)) throw new Error('manifest_write_failed');
    return { exitCode: observation.snapshot.initial === null ? 3 : 0, output, summary: observation.snapshot.summary, merge_authorized: false, manifest_sha256: digest(manifestBytes) };
  } catch { return { exitCode: 3, error: 'report_failed', output }; }
}
let direct = false;
try { direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Importing the module does not execute it. */ }
if (direct) {
  const result = await runPrCandidateReport(process.argv.slice(2));
  if (result.help) process.stdout.write(result.help);
  else process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
