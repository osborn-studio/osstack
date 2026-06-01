import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FrameTooLarge, FrameTruncated, MAX_FRAME_BYTES } from "./framing.js";

describe("framing", () => {
  it("roundtrips a single frame", () => {
    const payload = { id: 1, method: "version" };
    const buf = encodeFrame(payload);
    const dec = new FrameDecoder();
    const out = dec.push(buf);
    expect(out).toEqual([payload]);
  });

  it("roundtrips multiple frames in one chunk", () => {
    const a = { id: 1, method: "version" };
    const b = { id: 2, method: "health" };
    const buf = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
    const dec = new FrameDecoder();
    expect(dec.push(buf)).toEqual([a, b]);
  });

  it("buffers partial frames across pushes", () => {
    const a = { hello: "world" };
    const full = encodeFrame(a);
    const half = full.byteLength >>> 1;
    const dec = new FrameDecoder();
    expect(dec.push(full.subarray(0, half))).toEqual([]);
    expect(dec.push(full.subarray(half))).toEqual([a]);
  });

  it("rejects an oversized declared frame", () => {
    // Construct a header claiming MAX_FRAME_BYTES + 1
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const dec = new FrameDecoder();
    expect(() => dec.push(header)).toThrow(FrameTooLarge);
  });

  it("end() throws if a partial frame is dangling", () => {
    const dec = new FrameDecoder();
    dec.push(Buffer.from([0, 0, 0, 5, 0x68, 0x69])); // declares 5, only got 2
    expect(() => dec.end()).toThrow(FrameTruncated);
  });

  it("survives JSON strings containing newlines (NDJSON pitfall)", () => {
    const payload = { delta: "line one\nline two\n\nline four" };
    const dec = new FrameDecoder();
    expect(dec.push(encodeFrame(payload))).toEqual([payload]);
  });
});
