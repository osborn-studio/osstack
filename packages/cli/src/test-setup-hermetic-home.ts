// R2.1 test hermeticity guard.
//
// Points OSSTACK_HOME at a fresh throwaway directory BEFORE any test module in
// this package loads. vitest imports setupFiles ahead of the test file (and its
// top-level code), so by the time any suite calls osstackHome() / openStateDb()
// / main() the home already resolves under the system tmpdir. This makes it
// structurally impossible for a test that forgets to override the home to read
// or migrate the developer's real ~/.osstack/state.db.
//
// Tests that intentionally exercise a custom home still set their own
// OSSTACK_HOME inside beforeEach/beforeAll; those run after this file and win.
//
// OSSTACK_SOCKET overrides the socket derived from OSSTACK_HOME (src/paths.ts),
// so an exported value would point the suite at a real daemon. It is cleared
// here; tests that need a socket set their own. Both assignments are
// unconditional so an external export (e.g. left over in a shell) can never
// leak the real home or daemon into the suite.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One fresh home per test FILE (setupFiles runs per isolated worker/file),
// which also gives each file cross-file isolation for free.
const hermeticHome = mkdtempSync(join(tmpdir(), "osstack-vitest-home-"));
process.env["OSSTACK_HOME"] = hermeticHome;
delete process.env["OSSTACK_SOCKET"];

process.on("exit", () => {
  rmSync(hermeticHome, { recursive: true, force: true });
});
