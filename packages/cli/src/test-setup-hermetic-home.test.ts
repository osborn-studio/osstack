import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveSocketPath } from "./paths.js";

it("derives the socket from the hermetic home even when OSSTACK_SOCKET was exported", () => {
  expect(process.env["OSSTACK_SOCKET"]).toBeUndefined();
  expect(resolveSocketPath()).toBe(join(process.env["OSSTACK_HOME"]!, "daemon.sock"));
});
