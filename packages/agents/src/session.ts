import { z } from "zod";
import type { AgentAdapter } from "./base.js";

const IdSchema = z.string().trim().min(1).max(256);

export const AgentSessionStateSchema = z.enum([
  "starting",
  "running",
  "awaiting_decision",
  "idle",
  "completed",
  "failed",
  "cancelled",
]);
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;

export const AgentSessionDescriptorSchema = z.object({
  session_id: IdSchema,
  task_id: IdSchema,
  run_id: IdSchema,
  agent_id: IdSchema,
  native_session_id: IdSchema,
  state: AgentSessionStateSchema,
  resume_supported: z.boolean(),
  version: z.number().int().positive(),
  updated_at: z.number().finite().nonnegative(),
}).strict();
export type AgentSessionDescriptor = z.infer<typeof AgentSessionDescriptorSchema>;

export const AgentSessionInputSchema = z.object({
  session_id: IdSchema,
  task_id: IdSchema,
  run_id: IdSchema,
  turn_id: IdSchema,
  native_session_id: IdSchema,
  expected_version: z.number().int().positive(),
  message_id: IdSchema,
  prompt: z.string().trim().min(1).max(16_000),
  context: z.record(z.unknown()).optional(),
}).strict();
export type AgentSessionInput = z.infer<typeof AgentSessionInputSchema>;

export const AgentSessionCapabilitiesSchema = z.object({
  resume: z.boolean(),
  snapshot: z.boolean(),
}).strict();
export type AgentSessionCapabilities = z.infer<typeof AgentSessionCapabilitiesSchema>;

const NativeSessionStartedSchema = z.object({
  type: z.literal("native_session.started"),
  native_session_id: IdSchema,
}).strict();

const AssistantMessageSchema = z.object({
  type: z.literal("assistant.message"),
  message_id: IdSchema,
  text: z.string().max(4_000),
}).strict();

const DecisionRequestedSchema = z.object({
  type: z.literal("decision.requested"),
  decision_id: IdSchema,
  question: z.string().trim().min(1).max(1_000),
  choices: z.array(z.object({
    choice_id: IdSchema,
    label: z.string().trim().min(1).max(160),
  }).strict()).max(8),
}).strict();

const SessionStateEventSchema = z.object({
  type: z.literal("session.state"),
  state: AgentSessionStateSchema,
}).strict();

const SessionTerminalEventSchema = z.object({
  type: z.literal("session.terminal"),
  state: z.enum(["completed", "failed", "cancelled"]),
  error_code: IdSchema.optional(),
  summary: z.string().max(1_000).optional(),
}).strict();

export const AgentSessionEventSchema = z.discriminatedUnion("type", [
  NativeSessionStartedSchema,
  AssistantMessageSchema,
  DecisionRequestedSchema,
  SessionStateEventSchema,
  SessionTerminalEventSchema,
]);
export type AgentSessionEvent = z.infer<typeof AgentSessionEventSchema>;

export interface SessionCapableAdapter extends AgentAdapter {
  sessionCapabilities(): AgentSessionCapabilities;
  resumeSession(
    input: AgentSessionInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentSessionEvent>;
}

export function isSessionCapableAdapter(adapter: AgentAdapter): adapter is SessionCapableAdapter {
  const candidate = adapter as Partial<SessionCapableAdapter>;
  return typeof candidate.sessionCapabilities === "function"
    && typeof candidate.resumeSession === "function";
}
