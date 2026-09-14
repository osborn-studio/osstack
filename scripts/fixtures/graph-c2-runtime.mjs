// TEST ONLY. Bounded single-writer public-call journal, not a production saver.
import assert from 'node:assert/strict';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const requireGraph = createRequire(new URL('../../packages/graph/package.json', import.meta.url));
export const engine = await import(pathToFileURL(requireGraph.resolve('@langchain/langgraph')).href);
export const checkpointApi = await import(pathToFileURL(requireGraph.resolve('@langchain/langgraph-checkpoint')).href);
const manifestUrl = new URL('../../packages/graph/package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const { CheckpointCodec } = await import(new URL(manifest.exports['./codec'].import, manifestUrl).href);
const codec = new CheckpointCodec({ allowBytes: true });
export function persist(file, value) {
  const bytes = codec.encode(value);
  const fd = openSync(`${file}.next`, 'w', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${file}.next`, file);
}
export function read(file) {
  assert.ok(statSync(file).size <= 1_048_576, 'fixture file bound');
  return codec.decode(readFileSync(file));
}
const identity = (config) => ({ configurable: Object.fromEntries(
  ['thread_id', 'checkpoint_ns', 'checkpoint_id'].filter((key) => config.configurable?.[key] !== undefined)
    .map((key) => [key, config.configurable[key]]),
) });
const roundTrip = (value) => value === undefined ? undefined : codec.decode(codec.encode(value));
function validateRecord(row) {
  const invalid = () => { throw new Error('invalid journal method or arguments'); };
  if (!row || !['put', 'putWrites', 'deleteThread'].includes(row.method) || !Array.isArray(row.args)) invalid();
  const [config, value, third, fourth] = row.args;
  if (row.method === 'deleteThread') {
    if (row.args.length !== 1 || typeof config !== 'string') invalid();
    return;
  }
  if (typeof config?.configurable?.thread_id !== 'string') invalid();
  if (row.method === 'putWrites') {
    if (row.args.length !== 3 || typeof config.configurable.checkpoint_id !== 'string'
      || typeof third !== 'string' || !Array.isArray(value)
      || value.some((w) => !Array.isArray(w) || w.length !== 2 || typeof w[0] !== 'string')) invalid();
  } else if (row.args.length !== 4 || value?.v !== 4 || typeof value.id !== 'string'
    || !third || typeof third !== 'object' || !fourth || typeof fourth !== 'object') invalid();
}
export class JournalSaver extends checkpointApi.BaseCheckpointSaver {
  constructor(file) { super(); this.file = file; this.memory = new engine.MemorySaver(); this.records = []; }
  static async open(file) {
    const saver = new JournalSaver(file);
    saver.records = existsSync(file) ? read(file) : [];
    // Rehydrate using public methods only. Never read MemorySaver private fields.
    assert.ok(Array.isArray(saver.records), 'invalid journal rows');
    for (const row of saver.records) validateRecord(row);
    for (const row of saver.records) await saver.memory[row.method](...row.args);
    return saver;
  }
  async append(method, args) {
    const frozen = codec.decode(codec.encode({ method, args }));
    validateRecord(frozen);
    const next = [...this.records, frozen];
    persist(this.file, next);
    this.records = next;
    return this.memory[method](...frozen.args);
  }
  async getTuple(config) { return roundTrip(await this.memory.getTuple(identity(config))); }
  async *list(config, options) {
    for await (const tuple of this.memory.list(config === undefined ? undefined : identity(config), options)) yield roundTrip(tuple);
  }
  async put(config, checkpoint, metadata, versions) {
    await this.beforePut?.({ checkpoint, metadata });
    const result = await this.append('put', [identity(config), checkpoint, metadata, versions]);
    await this.afterPut?.({ checkpoint, metadata });
    return result;
  }
  async putWrites(config, writes, taskId) {
    await this.beforeWrites?.(writes);
    await this.append('putWrites', [identity(config), writes, taskId]);
    await this.afterWrites?.(writes);
  }
  async deleteThread(threadId) { return this.append('deleteThread', [threadId]); }
}
