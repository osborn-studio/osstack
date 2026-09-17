import { request } from 'node:http';

/** Local, explicit Docker Engine only. Never inherits DOCKER_HOST/context or credentials. */
export class ContainedDocker {
  constructor(readonly socketPath: string, private readonly timeoutMs = 5000) {}
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = request({ socketPath: this.socketPath, path: `/v1.47${path}`, method,
        headers: { ...(bytes ? { 'content-type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json', 'content-length': bytes.length } : {}) } }, res => {
        const chunks: Buffer[] = []; let length = 0;
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1024 * 1024) req.destroy(Error('CONTAINED_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        res.on('error', reject); res.on('aborted', () => reject(Error('CONTAINED_RESPONSE_ABORTED')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
      });
      const timer = setTimeout(() => req.destroy(Error('CONTAINED_API_TIMEOUT')), this.timeoutMs);
      req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(bytes);
    });
  }
}

export function dockerLogs(bytes: Buffer): string {
  const chunks: Buffer[] = []; let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length || ![1, 2].includes(bytes[offset]!) || bytes.subarray(offset + 1, offset + 4).some(x => x !== 0)) throw Error('CONTAINED_LOG_FRAME');
    const length = bytes.readUInt32BE(offset + 4); offset += 8;
    if (offset + length > bytes.length) throw Error('CONTAINED_LOG_FRAME');
    chunks.push(bytes.subarray(offset, offset + length)); offset += length;
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, 16000);
}
