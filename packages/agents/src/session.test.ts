import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "./base.js";
import {
  AgentSessionDescriptorSchema,
  AgentSessionEventSchema,
  AgentSessionInputSchema,
  isSessionCapableAdapter,
  type SessionCapableAdapter,
} from "./session.js";

const descriptor = {
  session_id: "sess_01",
  task_id: "task_01",
  run_id: "run_01",
  agent_id: "codex-cli",
  native_session_id: "019f-thread",
  state: "idle",
  resume_supported: true,
  version: 1,
  updated_at: 1_784_000_000,
} as const;

describe("resumable agent session contracts", () => {
  it("parses a strict, positive-version session descriptor", () => {
    expect(AgentSessionDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(() => AgentSessionDescriptorSchema.parse({ ...descriptor, version: 0 })).toThrow();
    expect(() => AgentSessionDescriptorSchema.parse({ ...descriptor, shell: "pwd" })).toThrow();
  });

  it("requires an exact session binding for every inbound turn", () => {
    const input = {
      session_id: "sess_01",
      task_id: "task_01",
      run_id: "run_01",
      turn_id: "turn_07",
      native_session_id: "019f-thread",
      expected_version: 4,
      message_id: "msg_feishu_01",
      prompt: "采用方案 B，继续测试",
    };

    expect(AgentSessionInputSchema.parse(input)).toEqual(input);
    expect(() => AgentSessionInputSchema.parse({ ...input, expected_version: true })).toThrow();
    expect(() => AgentSessionInputSchema.parse({ ...input, prompt: "" })).toThrow();
  });

  it("accepts only the bounded public session event variants", () => {
    expect(AgentSessionEventSchema.parse({
      type: "native_session.started",
      native_session_id: "019f-thread",
    })).toEqual({ type: "native_session.started", native_session_id: "019f-thread" });
    expect(AgentSessionEventSchema.parse({
      type: "assistant.message",
      message_id: "assistant_01",
      text: "已完成接口核对。",
    })).toMatchObject({ type: "assistant.message" });
    expect(() => AgentSessionEventSchema.parse({
      type: "assistant.message",
      message_id: "assistant_01",
      text: "ok",
      command_output: "secret",
    })).toThrow();
  });

  it("keeps ordinary adapters valid and detects optional session capability", () => {
    const ordinary: AgentAdapter = {
      id: "ordinary",
      display_name: "Ordinary adapter",
      cost_tier: "low",
      capabilities: () => [],
      isAvailable: async () => ({ available: true, last_checked_at: 1 }),
      invoke: async function* () {},
    };
    const resumable = {
      ...ordinary,
      id: "resumable",
      sessionCapabilities: () => ({ resume: true, snapshot: true }),
      startSession: async function* () {
        yield { type: "native_session.started", native_session_id: "native-1" } as const;
      },
      resumeSession: async function* () {
        yield { type: "session.state", state: "running" } as const;
      },
    } satisfies SessionCapableAdapter;

    expect(isSessionCapableAdapter(ordinary)).toBe(false);
    expect(isSessionCapableAdapter(resumable)).toBe(true);
  });
});
