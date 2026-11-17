import { createHash } from 'node:crypto';

export type ContainedProfileCapture = { bytes: Buffer; sha256: string; observedBytes: number };
export interface ContainedProfileRunOptions {
  stdoutBytes: number; stderrBytes: number;
  trustedFiles: readonly { path: string; sha256: string; size: number }[];
  trustedProfile: { profileDigest: string; artifactDigest: string; contentDigest: string; baseImageReference: string };
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Holds only two capped buffers and one header. Never retains input chunks. */
export function createProfileOutputCapture(limits: { stdoutBytes: number; stderrBytes: number }) {
  const streams = { stdout: { bytes: Buffer.alloc(limits.stdoutBytes), observedBytes: 0 }, stderr: { bytes: Buffer.alloc(limits.stderrBytes), observedBytes: 0 } };
  const header = Buffer.alloc(8); let headerBytes = 0; let remaining = 0;
  let stream: 'stdout' | 'stderr' = 'stdout';
  let state: 'ok' | 'exceeded' | 'invalid' = 'ok'; let exceededStream: 'stdout' | 'stderr' | undefined;
  return {
    push(chunk: Buffer): void {
      if (state !== 'ok') return;
      let offset = 0;
      while (offset < chunk.length) {
        if (!remaining) {
          const n = Math.min(8 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + n); headerBytes += n; offset += n;
          if (headerBytes < 8) return;
          if (![1, 2].includes(header[0]!) || header.subarray(1, 4).some(b => b !== 0)) { state = 'invalid'; return; }
          stream = header[0] === 1 ? 'stdout' : 'stderr'; remaining = header.readUInt32BE(4); headerBytes = 0;
          if (!remaining) continue;
        }
        const target = streams[stream]; const n = Math.min(remaining, chunk.length - offset);
        const room = target.bytes.length - target.observedBytes; const kept = Math.min(room, n);
        chunk.copy(target.bytes, target.observedBytes, offset, offset + kept);
        target.observedBytes += n; offset += n; remaining -= n;
        if (n > room) { state = 'exceeded'; exceededStream = stream; return; }
      }
    },
    snapshot() {
      const capture = (s: typeof streams.stdout): ContainedProfileCapture => {
        const bytes = s.bytes.subarray(0, Math.min(s.bytes.length, s.observedBytes));
        return { bytes, sha256: sha(bytes), observedBytes: s.observedBytes };
      };
      return { state, ...(exceededStream ? { exceededStream } : {}), incompleteFrame: headerBytes !== 0 || remaining !== 0, stdout: capture(streams.stdout), stderr: capture(streams.stderr) };
    },
  };
}

/** Fail closed on tar extensions, aliases, ambiguous names, or untrusted metadata. */
export function verifyTrustedNamespaceArchive(
  tar: Buffer, pathStat: { name: string; mode: number; linkTarget: string },
  expected: readonly { path: string; sha256: string; size: number }[],
): void {
  const fail = (): never => { throw Error('CONTAINED_PROFILE_NAMESPACE_UNTRUSTED'); };
  if (!pathStat || pathStat.name !== 'osstack-trusted' || pathStat.linkTarget !== '' || !Number.isInteger(pathStat.mode)
    || !(pathStat.mode & 0x80000000) || (pathStat.mode & 0x08000000)) fail();
  const files = new Map(expected.map(f => [`osstack-trusted/${f.path}`, f]));
  if (files.size !== expected.length) fail();
  const dirs = new Set(['osstack-trusted']);
  for (const name of files.keys()) {
    if (name.split('/').some(p => !p || p === '.' || p === '..') || name.includes('\\')) fail();
    for (let at = name.indexOf('/'); at >= 0; at = name.indexOf('/', at + 1)) dirs.add(name.slice(0, at));
  }
  const seen = new Set<string>(); let offset = 0; let ended = false;
  const text = (h: Buffer, at: number, size: number) => {
    const field = h.subarray(at, at + size); const end = field.indexOf(0);
    if (end >= 0 && field.subarray(end).some(b => b !== 0)) fail();
    const bytes = end < 0 ? field : field.subarray(0, end); const result = bytes.toString('utf8');
    if (!Buffer.from(result).equals(bytes)) fail(); return result;
  };
  const octal = (h: Buffer, at: number, size: number) => {
    const field = h.subarray(at, at + size); if (field.some(b => b > 127)) return fail();
    const raw = field.toString('ascii');
    if (!/^[0-7 ]+[\0 ]*$/.test(raw)) return fail();
    const value = Number.parseInt(raw.replace(/[\0 ]+$/g, '').trim(), 8);
    if (!Number.isSafeInteger(value) || value < 0) return fail(); return value;
  };
  if (tar.length % 512 !== 0) fail();
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(b => b === 0)) {
      if (offset + 1024 > tar.length || tar.subarray(offset).some(b => b !== 0)) fail();
      ended = true; break;
    }
    const magic = h.subarray(257, 265).toString('ascii');
    if (magic !== ('ustar\0' + '00') && magic !== 'ustar  \0') fail();
    const sum = h.reduce((total, b, at) => total + (at >= 148 && at < 156 ? 32 : b), 0);
    if (sum !== octal(h, 148, 8)) fail();
    const type = h[156]; if (type !== 0 && type !== 48 && type !== 53) fail();
    const prefix = magic === ('ustar\0' + '00') ? text(h, 345, 155) : '';
    const raw = `${prefix ? `${prefix}/` : ''}${text(h, 0, 100)}`;
    const directory = type === 53; const name = directory && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (!(name === 'osstack-trusted' || name.startsWith('osstack-trusted/')) || name.split('/').some(p => !p || p === '.' || p === '..')
      || name.includes('\\') || seen.has(name) || text(h, 157, 100) !== '') fail();
    seen.add(name);
    const mode = octal(h, 100, 8); const size = octal(h, 124, 12);
    if (octal(h, 108, 8) !== 0 || octal(h, 116, 8) !== 0) fail();
    offset += 512;
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length) fail();
    if (directory) { if (size !== 0 || !dirs.delete(name) || (mode & 0o22)) fail(); }
    else {
      const file = files.get(name);
      if (!file || file.size !== size || (mode & 0o7222) || sha(tar.subarray(offset, offset + size)) !== file.sha256) fail();
      files.delete(name);
    }
    if (tar.subarray(offset + size, offset + padded).some(b => b !== 0)) fail();
    offset += padded;
  }
  if (!ended || files.size || dirs.size) fail();
}
