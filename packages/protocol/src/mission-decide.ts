import { z } from 'zod';

/** Shape of the contained Mission decision RPC. Authorization and admission are host checks. */
export const MissionDecideRequest = z.object({
  credential: z.string().min(32).max(4096),
  mission_id: z.string().regex(/^cm_[0-9a-f-]{36}$/),
  decision_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  expected_revision: z.number().int().safe().positive().optional(),
  decision: z.enum(['abandon', 'extra_repair', 'approve_publication', 'discard_changes', 'adopt_worktree', 'resume_workspace', 'retry_stop_check', 'resume_budget', 'resume_grant']),
}).strict();
