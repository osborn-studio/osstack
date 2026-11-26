#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { main } from "./main.js";

if (process.getuid) {
  process.exitCode = await main(process.argv.slice(2), {
    fetchImpl: globalThis.fetch, now: () => new Date(), uuid: randomUUID,
    stdout: line => process.stdout.write(line + "\n"), getuid: process.getuid,
  });
} else {
  process.stdout.write('{"ok":false,"reason":"internal"}\n');
  process.exitCode = 1;
}
