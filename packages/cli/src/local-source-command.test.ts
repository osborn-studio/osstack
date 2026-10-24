import { realpathSync,rmSync } from "node:fs";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { handleLocalSourceCommand } from "./local-source-command.js";
const roots:string[]=[];const repo=()=>{const root=realpathSync(createScratchDirSync('tests','source-command'));roots.push(root);return root;};
afterEach(()=>{vi.useRealTimers();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('rejects request-selected paths or actions before any RPC',async()=>{
  const rpc=vi.fn(async()=>({}));for(const args of [['inspect','notes','--repo','/repo'],['inspect','notes','--repo','/repo','--default-tenant','--file','secret'],['execute','notes','--repo','/repo','--default-tenant']])expect(await handleLocalSourceCommand(args,{rpc,stderr:()=>{}})).toBe(1);
  expect(rpc).not.toHaveBeenCalled();
});
it('reports unavailable registration as unknown with no raw transport error',async()=>{
  let text='';expect(await handleLocalSourceCommand(['inspect','notes','--repo','/repo','--default-tenant'],{rpc:async()=>{throw Error('secret credential');},stderr:value=>{text+=value;}})).toBe(1);expect(text).toBe('source_observation_unknown\n');
});

it('locally bounds a hung RPC without echoing malformed responses',async()=>{
  const root=repo();let text='';let signal:AbortSignal|undefined;
  const result=handleLocalSourceCommand(['inspect','notes','--repo',root,'--default-tenant'],{rpc:async(_method,_params,_timeout,readSignal)=>{signal=readSignal;return new Promise(()=>{});},stderr:value=>{text+=value;}});
  expect(await result).toBe(1);expect(signal?.aborted).toBe(true);expect(text).toBe('source_observation_unknown\n');vi.useRealTimers();
});

it('never displays a substituted ready snapshot from another repository',async()=>{
  const root=repo();let text='';let error='';const raw={schema_version:1,source_id:'notes',scope:{repo_path:'/other-repo',tenant:'default'},state:'ready',reason:null,freshness:'recent',qualification:'pinned_local_snapshot_only',actions:'unsupported',provenance:{version:'1',manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),verified_at_ms:1,expires_at_ms:1000,revision:1},entries:[{id:'one',text:'private other repo'}]};
  expect(await handleLocalSourceCommand(['inspect','notes','--repo',root,'--default-tenant'],{rpc:async()=>raw,stdout:value=>{text+=value;},stderr:value=>{error+=value;}})).toBe(1);
  expect(text).toBe('');expect(error).toBe('source_observation_unknown\n');
});
