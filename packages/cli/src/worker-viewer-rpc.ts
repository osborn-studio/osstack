import { connect } from "node:net";
import { FrameDecoder, encodeFrame } from "@osstack/hermes-adapter";
import {
  WORKER_VIEW_ERROR_CODES,
  WORKER_VIEW_MAX_BYTES,
  WorkerInspectParamsSchema,
} from "./worker-view-service.js";
/** One bounded read over an existing socket; never starts a daemon or changes worker state. */
export function inspectWorkerForViewer(
  socketPath: string,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(Error("viewer_closed"));
  const request = WorkerInspectParamsSchema.parse(params);
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const decoder = new FrameDecoder();
    let settled = false;
    let bytes = 0;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(Error("viewer_closed"));
    const timer = setTimeout(() => finish(Error("worker_read_timeout")), 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    socket.on("connect", () => {
      if (!settled)
        socket.write(
          encodeFrame({ id: 1, method: "worker.inspect", params: request }),
        );
    });
    socket.on("error", () => finish(Error("worker_request_failed")));
    socket.on("close", () => finish(Error("worker_request_failed")));
    socket.on("data", (chunk) => {
      if (settled) return;
      try {
        bytes += chunk.length;
        if (bytes > WORKER_VIEW_MAX_BYTES + 1024)
          throw Error("invalid_worker_response");
        const frames = decoder.push(chunk);
        if (!frames.length) return;
        if (frames.length !== 1) throw Error("invalid_worker_response");
        const response = frames[0] as {
          id?: unknown;
          ok?: unknown;
          result?: unknown;
          error?: { code?: unknown };
        };
        if (!response || response.id !== 1 || typeof response.ok !== "boolean")
          throw Error("invalid_worker_response");
        if (!response.ok) {
          const code = response.error?.code;
          throw Error(
            typeof code === "string" &&
              (WORKER_VIEW_ERROR_CODES as readonly string[]).includes(code)
              ? code
              : "worker_request_failed",
          );
        }
        finish(undefined, response.result);
      } catch (error) {
        finish(
          error instanceof Error ? error : Error("invalid_worker_response"),
        );
      }
    });
  });
}
