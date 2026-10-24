import {createHash} from 'node:crypto';
import {mkdirSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createScratchDirSync,openDb} from '@osstack/core';
import {createHostSourceObservationService} from '/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-completion-upgrade/packages/cli/src/source-observation-host.ts';
import {createHostSourceContext} from '/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-completion-upgrade/packages/cli/src/source-context.ts';
import {createExecutionContextAdapters} from '/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-completion-upgrade/packages/cli/src/execution-context.ts';
import {localSourceManifestDigest} from '/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-completion-upgrade/packages/cli/src/local-data-source-registry.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const root=realpathSync(createScratchDirSync('tests','source-independent-review'));
try {
 const repo=join(root,'repo');mkdirSync(repo,{mode:0o700});const home=join(repo,'authority');mkdirSync(home,{mode:0o700});const source=join(root,'source');mkdirSync(source,{mode:0o700});openDb({path:join(home,'state.db')}).close();const now=Date.now();
 const manifest={schema_version:1 as const,id:'alpha',version:'v1',protocol:'local_json_snapshot_v1' as const,repo_path:repo,default_tenant:true as const,capabilities:['snapshot.read'] as ['snapshot.read'],file:'alpha.json',max_bytes:65536,max_items:20,read_timeout_ms:1000,verified_at_ms:now-1000,expires_at_ms:now+60000,fresh_for_ms:60000};
 const reg=(id:string,revision:number)=>{const m={...manifest,id,file:id+'.json'},raw=JSON.stringify({schema_version:1,source_id:id,version:'v1',revision,entries:[{id:'entry',text:id+' secret snapshot'}]});writeFileSync(join(source,id+'.json'),raw);return{source_root:source,manifest:m,manifest_digest:localSourceManifestDigest(m),content_digest:hash(raw)};};
 let registrations=[reg('alpha',0),reg('beta',0)];const save=()=>writeFileSync(join(home,'source-registry.json'),JSON.stringify({schema_version:1,registrations}),{mode:0o600});save();
 const service=createHostSourceObservationService(home),scope={repo_path:repo,source_id:'alpha',default_tenant:true as const};await service.observe(scope);registrations=[reg('alpha',3),registrations[1]!];save();const gap=(await service.observe(scope)).observation!;
 writeFileSync(join(home,'source-acknowledgements.json'),JSON.stringify({schema_version:1,grants:[{id:'repo-created',scope,generation:'v1',revision:3,manifest_digest:registrations[0]!.manifest_digest,content_digest:registrations[0]!.content_digest,expected_record_revision:gap.record_revision,expires_at_ms:now+60000}]}),{mode:0o600});const ack=await service.acknowledge(scope,'repo-created');console.log(JSON.stringify({finding:'repository_writable_host_authority',home_in_repo:true,gap_before:gap.state,state_after_repository_created_ack:ack.state}));
 writeFileSync(join(home,'source-context.json'),JSON.stringify({schema_version:1,repo_path:repo,default_tenant:true,source_ids:['alpha','beta'],max_bytes:8192}),{mode:0o600});
 let observations=0;const wrapped={...service,observe:async(...args:Parameters<typeof service.observe>)=>{observations++;if(observations===4){registrations=registrations.filter(r=>r.manifest.id!=='alpha');save();}return service.observe(...args);}};const context=createHostSourceContext(home,wrapped);let captured='';
 const adapter={id:'fixture',display_name:'fixture',cost_tier:'low',capabilities:()=>[],isAvailable:async()=>({available:true,last_checked_at:0}),invoke:async function*(task:any){captured=task.prompt;yield {type:'run.started'} as any;}};
 const output=createExecutionContextAdapters({adapters:[adapter as any],workspacePath:repo,mode:'local',loadContext:context.load,validateContext:context.validate,recordReceipt:async()=>({path:join(root,'receipt'),digest:'a'.repeat(64)})});for await(const _ of output.adapters[0]!.invoke({run_id:'run',task_id:'task',session_id:'session',capability_id:'test',prompt:'Use references'},new AbortController().signal)){}
 const after=await service.inspect(scope);console.log(JSON.stringify({finding:'revoked_first_source_during_later_validation',observations,source_state_at_dispatch:after.state,adapter_invoked:captured.length>0,revoked_alpha_in_prompt:captured.includes('alpha secret snapshot')}));
} finally {rmSync(root,{recursive:true,force:true});}
