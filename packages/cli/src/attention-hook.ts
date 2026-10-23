import type { Readable } from "node:stream";
import { readFile, lstat } from "node:fs/promises";
export interface ClaudeAttentionBinding {
  harness_version: string;
  session_id: string;
  scope_id: string;
  client_id: string;
  token: string;
  role: "foreground_owner";
}
/** Only a verified root Stop event can request a one-shot reminder. Never block Stop. */
export function classifyClaudeAttentionHook(
  event: unknown,
  binding: ClaudeAttentionBinding
): "remind" | "ignore" {
  if (
    binding.harness_version !== "2.1.291" ||
    binding.role !== "foreground_owner"
  )
    return "ignore";
  if (!event || typeof event !== "object") return "ignore";
  const p = event as Record<string, unknown>;
  if (
    p["session_id"] !== binding.session_id ||
    p["hook_event_name"] !== "Stop" ||
    p["stop_hook_active"] !== false ||
    p["agent_id"] !== undefined ||
    p["agent_type"] !== undefined
  )
    return "ignore";
  return "remind";
}
export async function handleClaudeAttentionHook(
  args: string[],
  rpc: (method: string, params?: unknown) => Promise<unknown>,
  out: (s: string) => void,
  input?: string
): Promise<number> {
  if (args.length !== 3 || args[1] !== "--binding-file")
    throw new Error("binding_file_required");
  const path = args[2]!;
  const st = await lstat(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.size > 4096 ||
    (st.mode & 0o077) !== 0
  )
    throw new Error("private_binding_file_required");
  const binding = JSON.parse(
    await readFile(path, "utf8")
  ) as ClaudeAttentionBinding;
  if (typeof binding.token !== "string" || binding.token.length !== 64)
    throw new Error("invalid_binding");
  const raw = input ?? await readClaudeHookInput(process.stdin);
  if (raw === null) { out("{}"); return 0; }
  if (Buffer.byteLength(raw) > 65536) throw new Error("oversized_hook_input");
  if (classifyClaudeAttentionHook(JSON.parse(raw), binding) === "ignore") {
    out("{}");
    return 0;
  }
  const response = (await rpc("attention.turn-end", {
    scope_id: binding.scope_id,
    client_id: binding.client_id,
    token: binding.token,
    role: binding.role,
  })) as { ok: boolean; result?: { reminder?: string | null } };
  out(
    JSON.stringify(
      response.ok && response.result?.reminder
        ? { systemMessage: response.result.reminder }
        : {}
    )
  );
  return 0;
}

/** Bound a broken producer's lifetime as well as its byte count. */
export function readClaudeHookInput(stream: Readable, timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData); stream.off("end", onEnd); stream.off("error", onError);
      stream.pause();
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 65536) { cleanup(); stream.destroy(); reject(new Error("oversized_hook_input")); }
      else chunks.push(bytes);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); stream.destroy(); resolve(null); }, timeoutMs);
    stream.on("data", onData); stream.once("end", onEnd); stream.once("error", onError);
  });
}
