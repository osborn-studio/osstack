import { describe, expect, it } from "vitest";
import {
  classifyHostProcess,
  GATED_WRAPPER_SCRIPT,
  HolderScanUnavailableError,
  type HostProcessLeader,
  type HostProcessMarker,
  type HostProcessProbe,
  type HostProcessRecord,
  interpretLsof,
  parseLsofFields,
  parseProcStat,
  parsePsLeader,
} from "./host-process.js";

const marker: HostProcessMarker = { path: "/x/hp_1.hold", dev: "16777233", ino: "42" };

interface FakeProbeState {
  boot?: string | null;
  identity?: "ok" | "lost";
  held?: boolean | "scan_unavailable" | (() => boolean);
  groupPresent?: boolean | (() => boolean);
  leader?: HostProcessLeader | null | "throw";
  throwOn?: "boot" | "group" | "identity";
}

/** Probe whose every call is recorded; it has no signalling method at all, so classification cannot signal. */
function fakeProbe(state: FakeProbeState): HostProcessProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    bootSession() {
      calls.push("boot");
      if (state.throwOn === "boot") throw new Error("sysctl failed");
      return state.boot === undefined ? "boot-A" : state.boot;
    },
    groupPresent() {
      calls.push("group");
      if (state.throwOn === "group") throw new Error("EIO");
      return typeof state.groupPresent === "function" ? state.groupPresent() : (state.groupPresent ?? false);
    },
    leader() {
      calls.push("leader");
      if (state.leader === "throw") throw new Error("ps failed");
      return state.leader === undefined ? null : state.leader;
    },
    markerIdentity() {
      calls.push("identity");
      if (state.throwOn === "identity") throw new Error("EIO");
      return state.identity ?? "ok";
    },
    markerHeld() {
      calls.push("held");
      if (state.held === "scan_unavailable") throw new HolderScanUnavailableError("control_missing");
      return typeof state.held === "function" ? state.held() : (state.held ?? false);
    },
  };
}

const record = (overrides: Partial<HostProcessRecord> = {}): HostProcessRecord => ({
  op_id: "hp_1",
  state: "released",
  pid: 500,
  pgid: 500,
  leader_start: "Fri Nov  6 10:00:00 2026",
  boot_id: "boot-A",
  marker,
  ...overrides,
});
const sameLeader: HostProcessLeader = { pgid: 500, start: "Fri Nov  6 10:00:00 2026" };
const advance = (clock: { t: number }) => async (ms: number) => {
  clock.t += ms;
};
const fast = { waitMs: 0, pollMs: 1, sleep: async () => undefined };

describe("classifyHostProcess (design 5.2)", () => {
  it("rule 0: a different boot session id proves the process is gone without touching the marker", async () => {
    const probe = fakeProbe({ boot: "boot-B", identity: "lost" });
    expect(await classifyHostProcess(record(), probe, fast)).toMatchObject({ kind: "stopped", proof: "rebooted" });
    expect(probe.calls).toEqual(["boot"]);
  });

  it.each([
    ["current id unreadable", null, "boot-A"],
    ["current id 'unknown'", "unknown", "boot-A"],
    ["recorded id 'unknown'", "boot-B", "unknown"],
  ])("rule 0 does not apply when %s", async (_name, current, recorded) => {
    const result = await classifyHostProcess(record({ boot_id: recorded }), fakeProbe({ boot: current, groupPresent: true, leader: sameLeader }), fast);
    expect(result).toMatchObject({ kind: "unknown", reason: "group_alive" });
  });

  it("rule 1: a missing or replaced marker is unknown(marker_lost) even if the group looks empty", async () => {
    const probe = fakeProbe({ identity: "lost", groupPresent: false });
    expect(await classifyHostProcess(record(), probe, fast)).toMatchObject({ kind: "unknown", reason: "marker_lost" });
    expect(probe.calls).not.toContain("held");
  });

  it("rule 2: a failed lsof positive control is unknown(holder_scan_unavailable), never stopped", async () => {
    for (const rec of [record(), record({ state: "launching", pid: null, pgid: null, leader_start: null })]) {
      const result = await classifyHostProcess(rec, fakeProbe({ held: "scan_unavailable", groupPresent: false }), fast);
      expect(result).toMatchObject({ kind: "unknown", reason: "holder_scan_unavailable" });
    }
  });

  it("rule 3: launching row with an unheld marker is stopped(never_registered+marker_unheld)", async () => {
    const launching = record({ state: "launching", pid: null, pgid: null, leader_start: null });
    expect(await classifyHostProcess(launching, fakeProbe({ held: false }), fast)).toMatchObject({
      kind: "stopped",
      proof: "never_registered+marker_unheld",
    });
  });

  it("rule 4: launching row whose holder disappears within the wait becomes stopped; a persistent holder is unknown(unregistered_holder)", async () => {
    const launching = record({ state: "launching", pid: null, pgid: null, leader_start: null });
    let polls = 0;
    const clock = { t: 0 };
    const opts = { waitMs: 5000, pollMs: 1000, now: () => clock.t, sleep: advance(clock) };
    const gone = await classifyHostProcess(launching, fakeProbe({ held: () => ++polls < 3 }), opts);
    expect(gone).toMatchObject({ kind: "stopped", proof: "never_registered+marker_unheld" });
    clock.t = 0;
    const stuck = await classifyHostProcess(launching, fakeProbe({ held: true }), opts);
    expect(stuck).toMatchObject({ kind: "unknown", reason: "unregistered_holder" });
    expect(stuck.detail.waited_ms).toBeGreaterThanOrEqual(5000);
  });

  it("rule 5: empty group and unheld marker is stopped(group_empty+marker_unheld)", async () => {
    expect(await classifyHostProcess(record(), fakeProbe({ groupPresent: false, held: false }), fast)).toMatchObject({
      kind: "stopped",
      proof: "group_empty+marker_unheld",
    });
  });

  it("rule 6: empty group with a held marker is unknown(escaped_holder)", async () => {
    expect(await classifyHostProcess(record(), fakeProbe({ groupPresent: false, held: true }), fast)).toMatchObject({
      kind: "unknown",
      reason: "escaped_holder",
    });
  });

  describe("rule 7: pid reuse", () => {
    const reused: HostProcessLeader = { pgid: 500, start: "Fri Nov  6 11:30:00 2026" };

    it("different start time and unheld marker is stopped(leader_reused+marker_unheld)", async () => {
      expect(await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader: reused, held: false }), fast)).toMatchObject({
        kind: "stopped",
        proof: "leader_reused+marker_unheld",
      });
    });

    it("different start time but held marker is unknown(escaped_holder)", async () => {
      expect(await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader: reused, held: true }), fast)).toMatchObject({
        kind: "unknown",
        reason: "escaped_holder",
      });
    });

    it("equal start time (same-second reuse is indistinguishable) is unknown(group_alive)", async () => {
      expect(await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader: sameLeader, held: false }), fast)).toMatchObject({
        kind: "unknown",
        reason: "group_alive",
      });
    });

    it("a recorded start time of NULL never proves reuse", async () => {
      const result = await classifyHostProcess(record({ leader_start: null }), fakeProbe({ groupPresent: true, leader: reused, held: false }), fast);
      expect(result).toMatchObject({ kind: "unknown", reason: "group_present" });
    });

    it("an unreadable start time never proves reuse", async () => {
      const result = await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader: { pgid: 500, start: null }, held: false }), fast);
      expect(result).toMatchObject({ kind: "unknown", reason: "group_present" });
    });

    it.each(["-", "", "Fri Nov", "Fri Nov  6 10:00 2026", "garbage"])("a malformed start time %j never proves reuse", async (bad) => {
      const result = await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader: { pgid: 500, start: bad }, held: false }), fast);
      expect(result).toMatchObject({ kind: "unknown", reason: "group_present" });
      const recorded = await classifyHostProcess(record({ leader_start: bad }), fakeProbe({ groupPresent: true, leader: reused, held: false }), fast);
      expect(recorded).toMatchObject({ kind: "unknown", reason: "group_present" });
    });

    it("a leader pid that sits in a different process group is not evidence of anything", async () => {
      const result = await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader: { pgid: 1, start: "Fri Nov  6 10:00:00 2026" }, held: false }), fast);
      expect(result).toMatchObject({ kind: "unknown", reason: "group_present" });
    });
  });

  it("rule 8: a released row with the same leader is unknown(group_alive) with no waiting", async () => {
    const probe = fakeProbe({ groupPresent: true, leader: sameLeader, held: true });
    let slept = 0;
    const result = await classifyHostProcess(record(), probe, { waitMs: 5000, pollMs: 1, sleep: async () => void slept++ });
    expect(result).toMatchObject({ kind: "unknown", reason: "group_alive" });
    expect(slept).toBe(0);
  });

  it("rule 8: a registered row (never released) gets the EOF grace period and settles once the wrapper exits", async () => {
    let alive = 3;
    const clock = { t: 0 };
    const probe = fakeProbe({ groupPresent: () => --alive > 0, leader: sameLeader, held: () => alive > 1 });
    const result = await classifyHostProcess(record({ state: "registered" }), probe, {
      waitMs: 5000,
      pollMs: 500,
      now: () => clock.t,
      sleep: advance(clock),
    });
    expect(result).toMatchObject({ kind: "stopped", proof: "group_empty+marker_unheld" });
    expect(result.detail.waited_ms).toBeGreaterThan(0);
  });

  it("rule 8: a registered row that never exits is unknown(group_alive) after the grace period", async () => {
    const clock = { t: 0 };
    const result = await classifyHostProcess(record({ state: "registered" }), fakeProbe({ groupPresent: true, leader: sameLeader, held: true }), {
      waitMs: 5000,
      pollMs: 1000,
      now: () => clock.t,
      sleep: advance(clock),
    });
    expect(result).toMatchObject({ kind: "unknown", reason: "group_alive" });
  });

  it.each([
    ["leader absent", null],
    ["ps unreadable (leader start NULL)", { pgid: 500, start: null }],
  ] as const)("rule 9: group present and %s is unknown(group_present)", async (_name, leader) => {
    expect(await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader, held: true }), fast)).toMatchObject({
      kind: "unknown",
      reason: "group_present",
    });
  });

  it.each([
    ["boot", "boot"],
    ["group", "group"],
    ["identity", "identity"],
  ] as const)("rule 10: a throwing %s probe is unknown(probe_failed)", async (_name, throwOn) => {
    expect(await classifyHostProcess(record(), fakeProbe({ throwOn, groupPresent: false }), fast)).toMatchObject({
      kind: "unknown",
      reason: "probe_failed",
    });
  });

  it("rule 10: a throwing leader probe is unknown(probe_failed)", async () => {
    expect(await classifyHostProcess(record(), fakeProbe({ groupPresent: true, leader: "throw" }), fast)).toMatchObject({
      kind: "unknown",
      reason: "probe_failed",
    });
  });

  it("rejects ledger rows the DDL would not allow instead of guessing", async () => {
    for (const bad of [record({ pgid: 501 }), record({ pid: null }), record({ pid: 1, pgid: 1 }), record({ state: "launching" })]) {
      expect(await classifyHostProcess(bad, fakeProbe({ groupPresent: false }), fast)).toMatchObject({ kind: "unknown", reason: "record_invalid" });
    }
  });

  it("only ever calls read-only probe methods (the Probe interface has no signalling method)", async () => {
    const probe = fakeProbe({ groupPresent: true, leader: { pgid: 500, start: "Fri Nov  6 11:30:00 2026" }, held: false });
    await classifyHostProcess(record(), probe, fast);
    expect(new Set(probe.calls)).toEqual(new Set(["boot", "identity", "held", "group", "leader"]));
  });
});

describe("lsof parsing (design 5.3)", () => {
  const ok = (pid: number, fd: string, dev: string, ino: string) => `p${pid}\nf${fd}\nD${dev}\ni${ino}\n`;
  const control = { dev: 0x1000011n, ino: 7n };
  const markerId = { dev: 0x1000011n, ino: 9n };
  const self = 100;
  const ours = ok(self, "4", "0x1000011", "9") + ok(self, "5", "0x1000011", "7");
  const sections = (...parts: string[]) => parts.join("");

  it("parses multi-process output and hex or decimal devices", () => {
    expect(parseLsofFields(`${ok(10, "3", "0x1000011", "9")}p11\nf4\nD16777233\ni9\n`)).toEqual([
      { pid: 10, fd: "3", dev: 16777233n, ino: 9n },
      { pid: 11, fd: "4", dev: 16777233n, ino: 9n },
    ]);
    expect(parseLsofFields("")).toEqual([]);
    expect(parseLsofFields("p1\nf3\nD0x1\ni1\nf4\nD0x1\ni2\n")).toHaveLength(2);
  });

  it.each([
    ["unknown field", "p1\nf3\nDx1\ni1\n"],
    ["extra field letter", "p1\nf3\nn/some/path\nD0x1\ni1\n"],
    ["missing inode", "p1\nf3\nD0x1\n"],
    ["fd before pid", "f3\nD0x1\ni1\n"],
    ["no trailing newline", "p1\nf3\nD0x1\ni1"],
    ["blank line", "p1\n\nf3\nD0x1\ni1\n"],
    ["duplicate device", "p1\nf3\nD0x1\nD0x2\ni1\n"],
    ["trailing process without a file record", "p1\nf3\nD0x1\ni1\np555\n"],
    ["process without a file record in the middle", "p1\np2\nf3\nD0x1\ni1\n"],
    ["process line only", "p1\n"],
  ])("rejects %s", (_name, text) => {
    expect(parseLsofFields(text)).toBeNull();
  });

  it("held marker: another pid has it; our own marker descriptor is not a holder", () => {
    const stdout = sections(ok(555, "3", "0x1000011", "9"), ours);
    expect(interpretLsof({ code: 0, stdout, stderr: "" }, markerId, control, self)).toEqual({ held: true, holders: [555] });
  });

  it("unheld marker: only our own marker and control descriptors", () => {
    expect(interpretLsof({ code: 0, stdout: ours, stderr: "" }, markerId, control, self)).toEqual({ held: false, holders: [] });
  });

  it("a second marker descriptor in our own pid is a leak and counts as held", () => {
    const stdout = sections(ours, ok(self, "9", "0x1000011", "9"));
    expect(interpretLsof({ code: 0, stdout, stderr: "" }, markerId, control, self)).toEqual({ held: true, holders: [self] });
  });

  it.skipIf(process.platform !== "darwin")("darwin: a sign-extended Node dev matches lsof's unsigned 32-bit hex dev", () => {
    const signExtended = BigInt.asIntN(32, 0xb6000001n) & 0xffffffffffffffffn;
    const stdout = sections(ok(555, "3", "0xb6000001", "9"), ok(self, "4", "0xb6000001", "9"), ok(self, "5", "0xb6000001", "7"));
    expect(interpretLsof({ code: 0, stdout, stderr: "" }, { dev: signExtended, ino: 9n }, { dev: signExtended, ino: 7n }, self)).toEqual({
      held: true,
      holders: [555],
    });
  });

  it.each([
    ["no control record (lsof blind to our own descriptor table)", { code: 0, stdout: ok(100, "4", "0x1000011", "9"), stderr: "" }],
    ["control owned by another pid", { code: 0, stdout: sections(ok(100, "4", "0x1000011", "9"), ok(999, "5", "0x1000011", "7")), stderr: "" }],
    ["two control records", { code: 0, stdout: sections(ours, ok(100, "6", "0x1000011", "7")), stderr: "" }],
    ["our own marker descriptor missing (path resolved to a different inode)", { code: 0, stdout: ok(100, "5", "0x1000011", "7"), stderr: "" }],
    ["a warning on stderr next to complete output", { code: 0, stdout: ours, stderr: "lsof: WARNING: can't stat() fuse file system" }],
    ["exit code 1 (an argument matched nothing)", { code: 1, stdout: ok(100, "5", "0x1000011", "7"), stderr: "" }],
    ["exit code 2", { code: 2, stdout: ours, stderr: "" }],
    ["killed (null code)", { code: null, stdout: "", stderr: "" }],
    ["unparseable", { code: 0, stdout: "garbage\n", stderr: "" }],
    ["a record for an unrelated file", { code: 0, stdout: sections(ours, ok(321, "3", "0x1000011", "12345")), stderr: "" }],
    ["a trailing process section without files", { code: 0, stdout: `${ours}p555\n`, stderr: "" }],
  ])("sanity failure: %s", (_name, run) => {
    expect(() => interpretLsof(run, markerId, control, self)).toThrow(HolderScanUnavailableError);
  });
});

describe("process table parsing", () => {
  it("parses macOS ps output with a space-padded day", () => {
    expect(parsePsLeader("  500 Fri Nov  6 10:00:00 2026\n")).toEqual({ pgid: 500, start: "Fri Nov 6 10:00:00 2026" });
    expect(parsePsLeader("")).toBeNull();
    expect(() => parsePsLeader("garbage")).toThrow();
    expect(() => parsePsLeader("500 -\n")).toThrow();
    expect(() => parsePsLeader("500 Fri Nov\n")).toThrow();
  });

  it("parses /proc/<pid>/stat even when comm contains spaces and parentheses", () => {
    const stat = "500 (a b) c) S 1 500 500 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 18446744073709551615";
    expect(parseProcStat(stat, 500)).toEqual({ pgid: 500, start: "987654" });
    expect(() => parseProcStat(stat, 501)).toThrow();
    expect(() => parseProcStat("500 (x) S 1", 500)).toThrow();
  });
});

describe("wrapper script", () => {
  it("is constant and never interpolates program or arguments", () => {
    expect(GATED_WRAPPER_SCRIPT).toBe('IFS= read -r g || exit 97; [ "$g" = "$0" ] || exit 98; exec "$@"');
  });
});
