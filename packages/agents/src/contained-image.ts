import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ContainedDocker } from './contained-docker.js';

export interface ContainedCandidateFile { path: string; mode: '100644' | '100755'; bytes: Uint8Array }
export interface ContainedImageOptions { socketPath: string; daemonId: string; baseImageId: string; authorize: () => void }
export interface ContainedImageReceipt {
  version: 1; daemonId: string; baseImageId: string; imageId: string;
  contentDigest: string; archiveDigest: string; workingDirectory: string;
}
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Restricted USTAR regular files only. No links, devices, PAX overrides or host paths. */
function tarFile(path: string, mode: number, bytes: Buffer): Buffer {
  const header = Buffer.alloc(512); let name = path; let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const split = path.lastIndexOf('/'); prefix = path.slice(0, split); name = path.slice(split + 1);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw Error('CONTAINED_CANDIDATE_PATH_LIMIT');
  header.write(name, 0, 100); header.write(prefix, 345, 155);
  const octal = (value: number, offset: number, length: number) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
export function snapshotContainedCandidate(input: readonly ContainedCandidateFile[]) {
  if (!input.length || input.length > 10000) throw Error('CONTAINED_CANDIDATE_FILE_LIMIT');
  let bytes = 0;
  for (const file of input) { bytes += file.bytes.byteLength; if (bytes > 32 * 1024 * 1024) throw Error('CONTAINED_CANDIDATE_SIZE_LIMIT'); }
  const files = input.map(file => ({ ...file, bytes: Buffer.from(file.bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const seen = new Set<string>(); let size = 0;
  for (const file of files) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes at this untrusted input boundary.
    if (!file.path || /[\x00-\x1f\x7f\\]/.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')
      || !['100644', '100755'].includes(file.mode) || seen.has(file.path)) throw Error('CONTAINED_CANDIDATE_ENTRY_INVALID');
    for (let at = file.path.indexOf('/'); at >= 0; at = file.path.indexOf('/', at + 1)) if (seen.has(file.path.slice(0, at))) throw Error('CONTAINED_CANDIDATE_PATH_CONFLICT');
    seen.add(file.path); size += file.bytes.length;
    if (size > 32 * 1024 * 1024) throw Error('CONTAINED_CANDIDATE_SIZE_LIMIT');
  }
  const contentDigest = sha(JSON.stringify(files.map(f => [f.path, f.mode, sha(f.bytes)])));
  return { files, contentDigest };
}
/** Host supplies bytes already checked against the frozen candidate. Build never
 * runs candidate code: only pinned local FROM, COPY and WORKDIR. No registry auth. */
export async function prepareContainedImage(options: ContainedImageOptions, input: readonly ContainedCandidateFile[]): Promise<ContainedImageReceipt> {
  const { socketPath, daemonId, baseImageId, authorize } = options;
  if (!isAbsolute(socketPath) || socketPath.includes('\0') || !daemonId || !/^sha256:[a-f0-9]{64}$/.test(baseImageId)) throw Error('CONTAINED_IMAGE_CONFIG');
  const check = () => { const value: unknown = authorize(); if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('CONTAINED_AUTHORITY_MUST_BE_SYNC'); } };
  check(); const { files, contentDigest } = snapshotContainedCandidate(input);
  const workingDirectory = `/osstack-candidate-${randomUUID()}`;
  const dockerfile = `FROM ${baseImageId}\nCOPY candidate/ ${workingDirectory}/\nWORKDIR ${workingDirectory}\n`;
  const archive = Buffer.concat([tarFile('Dockerfile', 0o644, Buffer.from(dockerfile)), ...files.map(f => tarFile(`candidate/${f.path}`, f.mode === '100755' ? 0o755 : 0o644, f.bytes)), Buffer.alloc(1024)]);
  const archiveDigest = sha(archive); const api = new ContainedDocker(socketPath, 120000);
  const call = async (method: string, path: string, body?: unknown) => { check(); const value = await api.call(method, path, body); check(); return value; };
  const daemon = async () => { const r = await call('GET', '/info'); const info = JSON.parse(r.bytes.toString()) as { ID?: string; OSType?: string };
    if (r.status !== 200 || info.ID !== daemonId || info.OSType !== 'linux') throw Error('CONTAINED_DAEMON_MISMATCH'); };
  const inspect = async (imageId: string) => {
    const r = await call('GET', `/images/${imageId}/json`);
    const image = JSON.parse(r.bytes.toString()) as { Id?: string; Config?: { OnBuild?: unknown[] | null; Volumes?: object | null; WorkingDir?: string; Labels?: Record<string, string> } };
    if (r.status !== 200 || image.Id !== imageId || !image.Config || (image.Config.OnBuild?.length ?? 0) || Object.keys(image.Config.Volumes ?? {}).length) throw Error('CONTAINED_IMAGE_UNSAFE');
    return image.Config;
  };
  await daemon(); await inspect(baseImageId); await daemon();
  const labels = { 'osstack.candidate.content': contentDigest, 'osstack.candidate.archive': archiveDigest };
  const query = new URLSearchParams({ version: '1', pull: 'false', networkmode: 'none', rm: 'true', forcerm: 'true', labels: JSON.stringify(labels) });
  const built = await call('POST', `/build?${query}`, archive);
  if (built.status !== 200) throw Error('CONTAINED_IMAGE_BUILD_FAILED');
  let imageId: string | undefined;
  for (const line of built.bytes.toString().split('\n').filter(s => s.trim())) {
    const event = JSON.parse(line) as { error?: unknown; errorDetail?: unknown; aux?: { ID?: string } };
    if (event.error !== undefined || event.errorDetail !== undefined) throw Error('CONTAINED_IMAGE_BUILD_FAILED');
    if (event.aux?.ID) imageId = event.aux.ID;
  }
  if (!imageId || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw Error('CONTAINED_IMAGE_ID_MISSING');
  await daemon(); const config = await inspect(imageId); await daemon();
  if (config.WorkingDir !== workingDirectory || Object.entries(labels).some(([key, value]) => config.Labels?.[key] !== value)) throw Error('CONTAINED_IMAGE_BINDING_MISMATCH');
  check(); return { version: 1, daemonId, baseImageId, imageId, contentDigest, archiveDigest, workingDirectory };
}
