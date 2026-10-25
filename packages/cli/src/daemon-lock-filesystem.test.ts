import { execFileSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { supportsLockFilesystem } from "./daemon-lock.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn(),
}));
const probe = vi.mocked(execFileSync);
const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const row = "Filesystem   1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1000 100 900 10% /System/Volumes/Data\n";
beforeEach(() => { probe.mockReset(); probe.mockImplementation(actual.execFileSync); });

it.each([0x19, 0x1a, 0x11, 99])("accepts named local filesystems independently of Darwin registration ID %i", (type) => {
  probe.mockReturnValueOnce(row);
  expect(supportsLockFilesystem("darwin", type, "/private/tmp/path with spaces")).toBe(true);
  expect(probe).toHaveBeenCalledWith("/bin/df", ["-k", "-P", "-T", "apfs,hfs", "/private/tmp/path with spaces"],
    expect.objectContaining({ timeout: 2000, maxBuffer: 65536, env: expect.objectContaining({ LC_ALL: "C" }) }));
});
it.each(["", row.split("\n")[0]!, row + "/dev/other 100 10 90 10% /other\n", "apfs", row.replace("900", "unknown")])("rejects missing or malformed named filesystem evidence", (output) => {
  probe.mockReturnValueOnce(output);
  expect(supportsLockFilesystem("darwin", 0x1a, "/private/tmp")).toBe(false);
});
it.each(["excluded NFS", "missing executable", "timeout", "output limit"])('fails closed on %s even with a previously allowed numeric ID', (reason) => {
  probe.mockImplementationOnce(() => { throw new Error(reason); });
  expect(supportsLockFilesystem("darwin", 0x1a, "/private/tmp")).toBe(false);
});
it.each([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630])("retains Linux filesystem support for %i without a Darwin subprocess", (type) => {
  expect(supportsLockFilesystem("linux", type, "/tmp")).toBe(true);
  expect(probe).not.toHaveBeenCalled();
});
it.each([0x6969, 0xff534d42, 0x19, 0x1a, 0x11])("rejects network or Darwin IDs on Linux: %i", (type) => {
  expect(supportsLockFilesystem("linux", type, "/tmp")).toBe(false);
  expect(probe).not.toHaveBeenCalled();
});
it("rejects unsupported platforms without probing", () => {
  expect(supportsLockFilesystem("win32", 0xef53, "C:\\temp")).toBe(false);
  expect(probe).not.toHaveBeenCalled();
});
