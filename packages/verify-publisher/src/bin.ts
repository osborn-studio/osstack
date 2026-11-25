#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { main } from "./main.js";

main(process.argv.slice(2), {
  fetchImpl: globalThis.fetch,
  now: () => new Date(),
  uuid: randomUUID,
  stdout: line => process.stdout.write(line + "\n"),
  ...(process.getuid && { getuid: process.getuid }),
}).then(code => { process.exitCode = code; }, () => {
  process.stdout.write('{"ok":false,"reason":"internal","detail":null}\n');
  process.exitCode = 1;
});
