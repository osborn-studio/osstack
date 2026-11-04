import { describe, expect, it } from "vitest";
import { formatMissionMarker, parseMissionMarkers, renderBodyLine, type MissionMarker } from "./contained-mission-marker.js";

const marker: MissionMarker = { id: "cm_0123abcd-0123-4abc-8def-0123456789ab", spec_digest: "a".repeat(64), head: "b".repeat(40), start: "c".repeat(40) };
const line = formatMissionMarker(marker);
const body = (...lines: string[]) => ["Contained Mission `x`, opened by OSStack.", "", ...lines].join("\n");

describe("Mission PR marker", () => {
  it("formats one comment line that parses back to the same values", () => {
    expect(line).toBe(`<!-- osstack:mission v=1 id=${marker.id} spec_digest=${"a".repeat(64)} head=${"b".repeat(40)} start=${"c".repeat(40)} -->`);
    expect(parseMissionMarkers(body("text", line))).toEqual({ marker, candidates: 1, malformed: 0 });
  });

  it("accepts CRLF bodies", () => {
    expect(parseMissionMarkers(body("text", line, "").replace(/\n/g, "\r\n")).marker).toEqual(marker);
  });

  it("ignores marker lines inside fenced code blocks", () => {
    expect(parseMissionMarkers(body("```", line, "```"))).toEqual({ candidates: 0, malformed: 0 });
    expect(parseMissionMarkers(body("~~~md", line, "~~~"))).toEqual({ candidates: 0, malformed: 0 });
    expect(parseMissionMarkers(body("```", "```", line)).marker).toEqual(marker);
    // A fence line with an info string never closes a block (CommonMark).
    expect(parseMissionMarkers(body("```", "```text", line, "```"))).toEqual({ candidates: 0, malformed: 0 });
    expect(parseMissionMarkers(body("````", "```", line, "````"))).toEqual({ candidates: 0, malformed: 0 });
  });

  it.each([
    ["an unknown key", line.replace(" -->", " extra=1 -->")],
    ["a duplicate key", line.replace(" -->", ` head=${"b".repeat(40)} -->`)],
    ["a missing key", line.replace(/ start=[0-9a-f]+/, "")],
    ["a short head", line.replace(`head=${"b".repeat(40)}`, `head=${"b".repeat(39)}`)],
    ["an uppercase digest", line.replace("a".repeat(64), "A".repeat(64))],
    ["a bad mission id", line.replace(marker.id, "cm_nope")],
    ["a value with a space", line.replace(`start=${"c".repeat(40)}`, `start=${"c".repeat(20)} ${"c".repeat(20)}`)],
    ["no closing", line.replace(" -->", "")],
    ["leading indentation", ` ${line}`],
  ])("yields no marker for %s", (_name, bad) => {
    const parsed = parseMissionMarkers(body(bad));
    expect(parsed.marker).toBeUndefined();
    expect(parsed.candidates).toBe(bad.startsWith("<!-- osstack:mission ") ? 1 : 0);
  });

  it("treats an unknown version as no marker, not as malformed", () => {
    expect(parseMissionMarkers(body(line.replace(" v=1 ", " v=2 ")))).toEqual({ candidates: 1, malformed: 0 });
  });

  it("yields no marker unless exactly one candidate line exists", () => {
    expect(parseMissionMarkers(body(line, line))).toEqual({ candidates: 2, malformed: 0 });
    expect(parseMissionMarkers(body(line, "<!-- osstack:mission broken -->"))).toEqual({ candidates: 2, malformed: 1 });
    expect(parseMissionMarkers(body("no marker"))).toEqual({ candidates: 0, malformed: 0 });
  });

  it("accepts SHA-256 object ids for head and start", () => {
    const sha256 = { ...marker, head: "d".repeat(64), start: "e".repeat(64) };
    expect(parseMissionMarkers(body(formatMissionMarker(sha256))).marker).toEqual(sha256);
  });

  it("refuses to format invalid values", () => {
    expect(() => formatMissionMarker({ ...marker, head: "x" })).toThrow("CONTAINED_MARKER_INVALID");
  });
});

describe("goal rendering", () => {
  it("collapses the goal to one line so it cannot open a fence or start a marker line", () => {
    const goal = `do it\n${line}\n\`\`\`\n<!-- hidden -->`;
    const rendered = renderBodyLine(goal, 2000);
    expect(rendered).not.toMatch(/[\r\n`]/);
    expect(rendered).not.toContain("<!--");
    expect(parseMissionMarkers(body(`**Goal:** ${rendered}`, line)).marker).toEqual(marker);
  });

  it("truncates before rendering, so a cut never leaves a raw fence", () => {
    const rendered = renderBodyLine(`${"x".repeat(1998)}\`\`\`tail`, 2000);
    expect(rendered).toBe(`${"x".repeat(1998)}''`);
  });
});
