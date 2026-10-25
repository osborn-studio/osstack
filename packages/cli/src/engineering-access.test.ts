import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDir } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineeringAccess, readEngineeringCredential } from "./engineering-access.js";
let root: string;
let path: string;
const credential = "secret-for-host-qualification-".repeat(2);
const scope = "a".repeat(64);
const row = {credential_sha256:createHash("sha256").update(credential).digest("hex"),principal_id:"owner",client_session_id:"console",read_scopes:[scope],write_scopes:[scope],stop_scopes:[scope],operator_scopes:[]};
function write(principals: unknown[] = [row]) { writeFileSync(path,JSON.stringify({version:1,principals}),{mode:0o600}); }
beforeEach(async () => {root=await createScratchDir("tests","engineering-access");path=join(root,"authority.json");write();});
afterEach(() => {vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
describe("host-owned engineering authority", () => {
  it("resolves identity and separate stop authority without exposing bearer hashes", () => {
    const access=new EngineeringAccess(path);
    const identity=access.authenticate(credential);
    expect(identity).toMatchObject({principal_id:"owner",client_session_id:"console",stop_scopes:[scope],operator_scopes:[]});
    expect(identity).not.toHaveProperty("credential_sha256");
    expect(()=>access.authenticate("different".repeat(8))).toThrow("permission_denied");
  });
  it("reloads write revocation while preserving independently granted stop", () => {
    const access=new EngineeringAccess(path);write([{...row,write_scopes:[]}]);
    expect(access.refresh("owner","console")).toMatchObject({write_scopes:[],stop_scopes:[scope]});
    write([]);expect(()=>access.authenticate(credential)).toThrow("permission_denied");
    expect(()=>access.refresh("owner","console")).toThrow("permission_denied");
  });
  it("rejects public authority files and final symlinks", () => {
    chmodSync(path,0o644);expect(()=>new EngineeringAccess(path)).toThrow("engineering_auth_invalid");
    chmodSync(path,0o600);const link=join(root,"link.json");symlinkSync(path,link);
    expect(()=>new EngineeringAccess(link)).toThrow("engineering_auth_invalid");
  });
  it("rejects repository-contained authority and accepts a sibling host directory", () => {
    const access=new EngineeringAccess(path);
    expect(()=>access.assertOutsideRepository(root)).toThrow("engineering_auth_inside_repository");
    const repo=join(root,"repo");mkdirSync(repo);expect(()=>access.assertOutsideRepository(repo)).not.toThrow();
  });
  it("refuses malformed or ambiguous authority even after construction", () => {
    const access=new EngineeringAccess(path);write([row,row]);expect(()=>access.authenticate(credential)).toThrow("engineering_auth_invalid");
    write([{...row,role:"admin"}]);expect(()=>access.authenticate(credential)).toThrow("engineering_auth_invalid");
    write([{...row,stop_scopes:["*"]}]);expect(()=>access.authenticate(credential)).toThrow("engineering_auth_invalid");
  });
  it("requires explicit client credential without loading the host authority", () => {
    vi.stubEnv("OSSTACK_ENGINEERING_CREDENTIAL","");expect(()=>readEngineeringCredential()).toThrow("engineering_credential_required");
    vi.stubEnv("OSSTACK_ENGINEERING_CREDENTIAL",credential);expect(readEngineeringCredential()).toBe(credential);
  });
});
