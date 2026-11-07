import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function selectedFile(root, path) {
  const canonical = await realpath(join(root, path));
  const within = relative(root, canonical);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw Error('bridge_runtime_path_escape');
  if (!(await stat(canonical)).isFile()) throw Error('bridge_runtime_file_required');
  const bytes = await readFile(canonical);
  return { bytes, marker: { path: canonical, sha256: sha256(bytes) } };
}

/**
 * Select an immutable checkout build or installed candidate. Imports execute only on call.
 * Installed prefixes must be absolute. A prefix alias is canonicalized; selected entry and
 * manifest symlinks must stay inside that canonical root. All validation precedes imports.
 * expectedSourceCommit is a full lowercase Git SHA and is supported only in installed mode.
 *
 * Returns { runtime, core, appModule, provenance }. provenance contains mode, canonical root,
 * sourceCommit (null in checkout mode), sourceMarker ({path, sha256} for the candidate manifest,
 * otherwise null), and entries keyed by runtime/core/appModule with {path, sha256}.
 * Hashes cover these files only, not transitive imports or the installed supply chain.
 * Keep the selected tree immutable for the process lifetime: Node caches imported modules.
 * This helper does not call exported functions, construct services, or read credentials.
 */
export async function loadBridgeRuntime({ checkoutRoot = process.cwd(), runtimePrefix, expectedSourceCommit } = {}) {
  const installed = runtimePrefix !== undefined;
  if (installed && (typeof runtimePrefix !== 'string' || !isAbsolute(runtimePrefix))) throw Error('bridge_runtime_prefix_absolute_required');
  if (expectedSourceCommit !== undefined && (typeof expectedSourceCommit !== 'string' || !SOURCE_COMMIT.test(expectedSourceCommit))) throw Error('bridge_runtime_expected_source_invalid');
  if (!installed && expectedSourceCommit !== undefined) throw Error('bridge_runtime_expected_source_requires_installed');
  if (!installed && (typeof checkoutRoot !== 'string' || checkoutRoot.length === 0)) throw Error('bridge_runtime_checkout_root_invalid');
  const root = await realpath(installed ? runtimePrefix : resolve(checkoutRoot));
  let sourceCommit = null;
  let sourceMarker = null;
  if (installed) {
    const selected = await selectedFile(root, 'candidate-manifest.json');
    let manifest;
    try { manifest = JSON.parse(selected.bytes.toString('utf8')); }
    catch { throw Error('bridge_runtime_manifest_invalid'); }
    if (!manifest || typeof manifest.source_commit !== 'string' || !SOURCE_COMMIT.test(manifest.source_commit)) throw Error('bridge_runtime_manifest_invalid');
    sourceCommit = manifest.source_commit;
    sourceMarker = selected.marker;
    if (expectedSourceCommit !== undefined && sourceCommit !== expectedSourceCommit) throw Error('bridge_runtime_source_mismatch');
  }
  const cli = installed ? 'lib/node_modules/@osstack/cli/dist' : 'packages/cli/dist';
  const paths = {
    runtime: `${cli}/bridge-production.js`,
    core: installed ? 'lib/node_modules/@osstack/core/dist/index.js' : 'packages/core/dist/index.js',
    appModule: `${cli}/bridge-github-app.js`,
  };
  const entries = {};
  for (const [key, path] of Object.entries(paths)) entries[key] = (await selectedFile(root, path)).marker;
  const [runtime, core, appModule] = await Promise.all([
    import(pathToFileURL(entries.runtime.path).href),
    import(pathToFileURL(entries.core.path).href),
    import(pathToFileURL(entries.appModule.path).href),
  ]);
  return { runtime, core, appModule, provenance: { mode: installed ? 'installed' : 'checkout', root, sourceCommit, sourceMarker, entries } };
}
