import type { HermesEvent } from '@osstack/hermes-adapter';
import type { AgentAdapter, AgentTask } from '../base.js';
import { ContainedCommandExecutor, type ContainedCommandOptions } from '../contained-command.js';

/** Explicit host registration only: command/code comes from the pinned image and
 * constructor, never task.prompt/context or the host workspace. No default router entry. */
export function createContainedCommandAdapter(options: ContainedCommandOptions): AgentAdapter {
  const executor = new ContainedCommandExecutor(options);
  return {
    id: 'contained-command', display_name: 'Contained image command', cost_tier: 'low', capabilities: () => [],
    isAvailable: async () => {
      try { await executor.probe(); return { available: true, last_checked_at: Date.now() / 1000 }; }
      catch { return { available: false, reason: 'Contained daemon identity or authority unavailable', last_checked_at: Date.now() / 1000 }; }
    },
    confirmStopped: runId => executor.confirmStopped(runId),
    invoke: async function* (task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
      let seq = 0;
      const envelope = (terminal: boolean) => ({ event_id: `${task.run_id}:${seq}`, seq: seq++, run_id: task.run_id,
        session_id: task.session_id, created_at: Date.now() / 1000, terminal });
      yield { ...envelope(false), type: 'run.started', payload: { status: 'running',
        controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false } } };
      try {
        const result = await executor.execute(task.run_id, signal);
        if (result.output) yield { ...envelope(false), type: 'token.delta', payload: { message_id: task.run_id, delta: result.output, content_type: 'text' } };
        const last = seq - 1;
        yield { ...envelope(true), type: 'done', payload: { status: result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'completed' : 'failed',
          last_seq: last, result_summary: result.evidence } };
      } catch (error) {
        yield { ...envelope(true), type: 'error', payload: { code: 'CONTAINED_EXECUTION_UNCONFIRMED', message: String(error).slice(0, 1000), terminal: true } };
      }
    },
  };
}
