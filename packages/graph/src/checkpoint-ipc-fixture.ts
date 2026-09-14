// Test support only: no core import in the graph runtime dependency tree.
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GraphCheckpointRequest, GraphCheckpointResponse } from '@osstack/protocol';
export async function checkpointServer(path: string) {
  const child: ChildProcess = fork(fileURLToPath(new URL('../../../scripts/fixtures/graph-checkpoint-server.mjs', import.meta.url)),
    [path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  let serial = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const events = new Map<string, () => void>();
  const observed = new Set<string>();
  const ready = new Promise<string>((resolve, reject) => {
    child.on('message', (raw: unknown) => {
      const message = raw as { event?: string; threadId?: string; id: number; error?: string; result?: unknown };
      if (message.event === 'ready') { resolve(message.threadId!); return; }
      if (message.event) { observed.add(message.event); events.get(message.event)?.(); return; }
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler?.reject(new Error(message.error)); else handler?.resolve(message.result);
    });
    child.on('error', reject);
    child.on('exit', () => {
      const error = new Error(`checkpoint transport exited (ACK unknown): ${stderr}`);
      reject(error);
      for (const handler of pending.values()) handler.reject(error);
      pending.clear();
    });
  });
  const send = (message: object) => new Promise<unknown>((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    child.send({ ...message, id }, (error) => { if (error) { pending.delete(id); reject(error); } });
  });
  return {
    threadId: await ready,
    transport: (request: GraphCheckpointRequest) => send({ request }) as Promise<GraphCheckpointResponse>,
    arm: (control: { phase: 'before' | 'after' | 'fail' | 'delay'; kind?: 'put' | 'writes'; channel?: string; batch?: boolean; delayMs?: number }) => send({ control }),
    event: (name: string) => observed.has(name) ? Promise.resolve() : new Promise<void>((resolve) => { events.set(name, resolve); }),
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', () => resolve()); child.kill('SIGKILL');
    }),
  };
}
