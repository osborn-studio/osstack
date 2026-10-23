import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { GraphWorkerIdentity, WorkerFrameDecoder, WorkerFramedTransport, encodeWorkerFrame } from './graph-worker.js';

it('rejects an oversize header before allocating body or parsing JSON', () => {
  const parse = vi.spyOn(JSON, 'parse');
  const decoder = new WorkerFrameDecoder(() => {}, 32);
  const header = Buffer.alloc(4); header.writeUInt32BE(0xffffffff);
  expect(() => decoder.push(header)).toThrow('WORKER_FRAME_LIMIT');
  expect(decoder.bufferedBytes).toBe(0);
  expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
});
it('decodes fragmented and coalesced frames with bounded retained bytes', () => {
  const values: unknown[] = []; const decoder = new WorkerFrameDecoder(v => values.push(v), 128);
  const frames = Buffer.concat([encodeWorkerFrame({ ok: 1 }, 128), encodeWorkerFrame({ ok: 2 }, 128)]);
  for (const byte of frames) decoder.push(Buffer.from([byte]));
  expect(values).toEqual([{ ok: 1 }, { ok: 2 }]); expect(decoder.bufferedBytes).toBe(0);
});
it('refuses outbound backlog without enqueueing more frames', () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  const transport = new WorkerFramedTransport(stream, stream, () => {}, () => {}, { maxFrameBytes: 64, maxBufferedBytes: 72 });
  // Do not consume the output; this is a blocked peer.
  stream.pause();
  transport.send({ text: 'x'.repeat(40) });
  expect(() => transport.send({ text: 'x'.repeat(40) })).toThrow('WORKER_BACKPRESSURE');
  transport.close();
});
it.each(['async', 'exit'])('rejects durability %s', durability => {
  expect(() => GraphWorkerIdentity.parse({ executionModel: 'langgraph-functional-v1', durability })).toThrow();
});
