import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchDir } from "@osstack/core";
import { consumeViewerHandoff, launchWorkerViewer, viewerLaunchArguments, ViewerHostConfigSchema } from "./worker-viewer-launch.js";
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(kind: "tmux" | "cmux" = "tmux") {
  const root = await realpath(await createScratchDir("tests", "viewer-launch")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  const program = join(root, "program"); await writeFile(program, "pinned", { mode: 0o700 });
  // Short socket spelling is canonical on macOS (/private/tmp), under managed scratch.
  const socket = join(root, "v.sock"); const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve()))); await chmod(socket, 0o600);
  const config = ViewerHostConfigSchema.parse({ schema_version: 1, home, node: { path: program, sha256: sha("pinned") }, cli: { path: program, sha256: sha("pinned") },
    backends: [{ kind, executable: { path: program, sha256: sha("pinned") }, version_output: "pinned-version", socket,
      target: kind === "tmux" ? "$7" : "11111111-1111-1111-1111-111111111111", shell: "posix" }] });
  const configPath = join(home, "viewer-backends.json"); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const reference = { repo_path: root, default_tenant: true as const, view_id: "opaque_token" };
  const response = { schema_version: 1, mode: "readonly_state_view", scope: { repo_path: root, tenant: "default", scope_id: "a".repeat(64) }, sampled_at_ms: 1,
    coverage: { graph: "unsupported_authenticated_registration_required", unbound_runs: "excluded_not_bound", repository_binding: "canonical_stored_paths_only", content: "structured_metadata_only", counting: "source_views_not_unique_workers" },
    view: { view_id: reference.view_id, source_kind: "run", state: "running", revision: 1, latest_turn: null, last_updated_at_ms: 1, freshness: "recent", process_liveness: "unknown", wait_reason: "none", uncertain_delivery_recorded: false, controls: "unsupported" } };
  return { root, home, program, config, configPath, reference, response };
}
describe("host pinned viewer launch", () => {
  it("launches only a new detached read-only tmux viewer via argv", async () => {
    const f = await fixture(); const calls: string[][] = [];
    const result = await launchWorkerViewer({ home: f.home, backend: "tmux", reference: f.reference, inspect: async () => f.response,
      run: async (_exe, args, env) => { expect(env).not.toHaveProperty("NODE_OPTIONS"); calls.push(args); return calls.length === 1 ? "pinned-version\n" : "%17\n"; } });
    expect(result.state).toBe("launch_requested"); expect(calls[1]).toContain("-N"); expect(calls[1]).toContain("new-window");
    expect(calls[1]).toContain("-d"); expect(calls[1]).toContain("watch-handoff"); expect(calls.flat()).not.toContain("send-keys");
    expect(calls.flat()).not.toContain("kill-pane"); expect(calls.flat()).not.toContain("select-pane");
  });
  it("does not launch after registry revocation during inspection", async () => {
    const f = await fixture(); let calls = 0;
    await expect(launchWorkerViewer({ home: f.home, backend: "tmux", reference: f.reference,
      inspect: async () => { await writeFile(f.configPath, "{}"); return f.response; }, run: async () => { calls++; return "pinned-version"; } })).rejects.toThrow("viewer_configuration_changed");
    expect(calls).toBe(1);
  });
  it("never retries an ambiguous launcher failure", async () => {
    const f = await fixture(); let calls = 0;
    const result = await launchWorkerViewer({ home: f.home, backend: "tmux", reference: f.reference, inspect: async () => f.response,
      run: async () => { if (++calls === 1) return "pinned-version"; throw Error("response lost"); } });
    expect(result.state).toBe("launch_unknown"); expect(result.auto_retry).toBe(false); expect(calls).toBe(2);
  });
  it("rejects a changed executable before invoking anything", async () => {
    const f = await fixture(); await writeFile(f.program, "replaced");
    await expect(launchWorkerViewer({ home: f.home, backend: "tmux", reference: f.reference, inspect: async () => f.response,
      run: async () => { throw Error("must not invoke"); } })).rejects.toThrow("viewer_pin_mismatch");
  });
  it("keeps capability and repository text out of cmux shell commands", async () => {
    const f = await fixture("cmux"); const handoff = join(f.home, "viewer-handoff-11111111-1111-1111-1111-111111111111.json");
    const args = viewerLaunchArguments(f.config, f.config.backends[0]!, handoff);
    expect(args.slice(0, 5)).toEqual(["--socket", f.config.backends[0]!.socket, "--window", f.config.backends[0]!.target, "--json"]);
    expect(args.at(-1)).not.toContain(f.reference.view_id); expect(args.at(-1)).toContain("watch-handoff");
    expect(() => viewerLaunchArguments({...f.config, home:"/tmp/a'$(touch NO)"}, f.config.backends[0]!, handoff)).toThrow("viewer_shell_contract_invalid");
  });
  it("consumes a private handoff exactly once without exposing authority in argv", async () => {
    const f = await fixture(); let captured: string[] = [];
    await launchWorkerViewer({home:f.home,backend:"tmux",reference:f.reference,inspect:async()=>f.response,
      run:async(_exe,args)=>{captured=args;return args[0]==="-V"?"pinned-version":"%1";}});
    expect(captured).not.toContain(f.reference.view_id);
    const path = join(f.home,(await readdir(f.home)).find(n=>n.startsWith("viewer-handoff-"))!);
    const results = await Promise.allSettled([consumeViewerHandoff(f.home,path),consumeViewerHandoff(f.home,path)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(results.find(r=>r.status==="fulfilled")).toMatchObject({value:["watch",f.reference.view_id,"--repo",f.root,"--default-tenant","--duration-ms","60000"]});
  });
  it("rejects a response for another view before launch", async()=>{
    const f=await fixture();let calls=0;
    await expect(launchWorkerViewer({home:f.home,backend:"tmux",reference:f.reference,
      inspect:async()=>({...f.response,view:{...f.response.view,view_id:"different"}}),run:async()=>{calls++;return "pinned-version";}})).rejects.toThrow("viewer_scope_mismatch");
    expect(calls).toBe(1);
  });
  it("executes the pinned launcher as a real child with bounded argv, without a shell", async () => {
    const f = await fixture(); const log = join(f.root, "argv.json");
    const source = `#!${process.execPath}\nconst fs=require('fs');if(process.argv[2]==='-V'){console.log('pinned-version')}else{fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),env:process.env}));console.log('%3')}\n`;
    await writeFile(f.program, source); f.config.backends[0]!.executable.sha256 = sha(source); f.config.node.sha256 = sha(source); f.config.cli.sha256 = sha(source);
    await writeFile(f.configPath, JSON.stringify(f.config));
    const result = await launchWorkerViewer({ home: f.home, backend: "tmux", reference: f.reference, inspect: async () => f.response });
    expect(result.state).toBe("launch_requested");
    const actual = JSON.parse(await readFile(log, "utf8")); expect(actual.args).toContain("watch-handoff");
    expect(actual.args).toContain(`OSSTACK_HOME=${f.home}`); expect(actual.env).not.toHaveProperty("NODE_OPTIONS");
    expect(actual.args).not.toContain("send-keys");
  });
  it("rejects another uid's writable ancestor before any launcher process",async()=>{
    const f=await fixture();await chmod(f.root,0o777);
    try{await expect(launchWorkerViewer({home:f.home,backend:"tmux",reference:f.reference,inspect:async()=>f.response,
      run:async()=>{throw Error("must not invoke");}})).rejects.toThrow("viewer_unsafe_ancestor");}
    finally{await chmod(f.root,0o700);}
  });
  it("consumes but rejects expired handoff authority",async()=>{
    const f=await fixture();const path=join(f.home,"viewer-handoff-11111111-1111-1111-1111-111111111111.json");
    await writeFile(path,JSON.stringify({schema_version:1,expires_at_ms:Date.now()-1,reference:f.reference,duration_ms:1000}),{mode:0o600});
    await expect(consumeViewerHandoff(f.home,path)).rejects.toThrow("viewer_handoff_expired");
    expect(await readdir(f.home)).toEqual(["viewer-backends.json"]);
  });

});
