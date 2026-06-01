// Length-prefixed JSON framing for the Python bridge ↔ TS daemon Unix socket.
//
// Wire format per message: [4-byte big-endian uint32 length][JSON payload bytes].
//
// This is the same shape used by LSP and MCP. Avoids the NDJSON pitfall where
// a `\n` inside a string field (e.g. token.delta) corrupts the stream.

export const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB hard cap

export class FrameTooLarge extends Error {
  readonly size: number;
  constructor(size: number) {
    super(`Frame size ${size} bytes exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`);
    this.name = "FrameTooLarge";
    this.size = size;
  }
}

export class FrameTruncated extends Error {
  constructor() {
    super("Socket closed mid-frame");
    this.name = "FrameTruncated";
  }
}

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.byteLength > MAX_FRAME_BYTES) throw new FrameTooLarge(body.byteLength);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

/**
 * Stateful frame decoder. Feed it chunks from a stream as they arrive;
 * yields complete frames as they assemble. Buffers partial frames internally.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const size = this.buf.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES) throw new FrameTooLarge(size);
      if (this.buf.length < 4 + size) break;
      const body = this.buf.subarray(4, 4 + size);
      this.buf = this.buf.subarray(4 + size);
      out.push(JSON.parse(body.toString("utf8")));
    }
    return out;
  }

  /** Call when the stream ends. Throws if a partial frame is dangling. */
  end(): void {
    if (this.buf.length > 0) throw new FrameTruncated();
  }
}
