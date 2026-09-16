import { readFile, writeFile, appendFile } from 'node:fs/promises';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation';
const out='/Volumes/AIMATE_WORK/tmp/g25-recovery'; process.env.TMPDIR=out; process.env.OSSTACK_HOME=out+'/home';
const {KimiCodeAdapter}=await import(root+'/packages/agents/dist/index.js');
const name=process.argv[2]; const input=JSON.parse(await readFile(out+'/'+name+'-input.json','utf8'));
const adapter=new KimiCodeAdapter({model:'kimi-code/k3',timeoutMs:600000,outputLimit:524288,reviewAgentFile:root+'/packages/agents/src/adapters/kimi-review-agent.md'});
const readiness=await adapter.readiness(); await writeFile(out+'/'+name+'-readiness.json',JSON.stringify(readiness,null,2));
const events=[];for await(const event of adapter.invoke({run_id:name,task_id:name,session_id:name,capability_id:'kimi-code.code.review',prompt:input.task,context:{kimi_review_input:input}},new AbortController().signal)){events.push(event);await appendFile(out+'/'+name+'-events.jsonl',JSON.stringify(event)+'\n');}
await writeFile(out+'/'+name+'-result.json',JSON.stringify(events,null,2)); console.log(JSON.stringify(events.at(-1)));
