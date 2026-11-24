import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { random } from "./seeded-simulation.testkit.js";

it("is the same code as the core kit", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const loop = read("./seeded-simulation.testkit.ts");
  const header = "// Minimal package-local copy of core/src/testing/seeded-simulation.testkit.ts.\n"
    + "// loop rootDir is src; core intentionally does not export test helpers.\n";
  const repair = "copy the core file over the loop file and keep the two header lines";
  expect(loop.startsWith(header), repair).toBe(true);
  expect(loop.slice(header.length), repair).toBe(read("../../core/src/testing/seeded-simulation.testkit.ts"));
});

it("keeps the xorshift sequence", () => {
  expect(Array.from({ length: 5 }, random(1))).toEqual([270369, 67634689, 2647435461, 307599695, 2398689233]);
  expect(Array.from({ length: 5 }, random(0x71a77e))).toEqual([2807159569, 440734728, 2689418538, 367536798, 130529955]);
});
