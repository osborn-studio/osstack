import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Runner, InMemorySessionService, Workflow, node, JoinNode, createEvent} from '@google/adk';
import {StateGraph, Annotation, START, END, MemorySaver, interrupt, Command} from '@langchain/langgraph';
import {z} from 'zod';

// Offline semantic probes, not osstack integration or crash-durability tests.
const results=[];
async function test(name, fn) {
  const begin=performance.now();
  try { results.push({name, pass:true, evidence:await fn(), durationMs:Math.round(performance.now()-begin)}); }
  catch(error) { results.push({name,pass:false,error:String(error),stack:error.stack}); }
}
async function adkRun(workflow, text='seed') {
  const sessionService=new InMemorySessionService();
  const session=await sessionService.createSession({appName:'probe',userId:'offline'});
  const runner=new Runner({appName:'probe',agent:workflow,sessionService});
  const events=[];
  for await(const event of runner.runAsync({userId:'offline',sessionId:session.id,newMessage:{role:'user',parts:[{text}]}})) events.push(event);
  return events;
}
await test('adk: typed parallel branches + AND barrier',async()=>{
  let active=0,maxActive=0,joins=0,received;
  const branch=(name)=>node(async()=>{active++;maxActive=Math.max(active,maxActive);await delay(name==='a'?30:8);active--;return {ok:true,revision:'rev1'};},{name,outputSchema:z.object({ok:z.boolean(),revision:z.string()})});
  const a=branch('a'),b=branch('b'),join=new JoinNode({name:'join'});
  const collect=node((ctx,input)=>{joins++;received=input;return 'joined';},{name:'collect'});
  await adkRun(new Workflow({name:'parallel',edges:[['START',a,join],['START',b,join],[join,collect]]}));
  assert.equal(maxActive,2); assert.equal(joins,1);assert.equal(received.a.revision,received.b.revision);
  return {maxActive,joins,received};
});
await test('adk: conditional route is exclusive',async()=>{
  const seen=[];
  const r=node(()=>createEvent({route:'repair',output:{ok:false}}),{name:'route'});
  const pass=node(()=>{seen.push('pass');return true;},{name:'pass'});
  const repair=node(()=>{seen.push('repair');return true;},{name:'repair'});
  await adkRun(new Workflow({name:'conditional',edges:[['START',r],[r,{pass,repair}]]}));
  assert.deepEqual(seen,['repair']);return {seen};
});
await test('adk: empty branch output still releases JoinNode',async()=>{
  let joins=0,received;
  const a=node(()=>({ok:true}),{name:'a'});
  const b=node(()=>undefined,{name:'b',outputSchema:z.object({ok:z.boolean()})});
  const join=new JoinNode({name:'join'});
  const collect=node((ctx,input)=>{joins++;received=input;return 'joined';},{name:'collect'});
  await adkRun(new Workflow({name:'missing_output',edges:[['START',a,join],['START',b,join],[join,collect]]}));
  assert.equal(joins,1);assert.equal(received.b,undefined);
  return {joins,receivedKeys:Object.keys(received),missingOutputIsUndefined:received.b===undefined,outputSchemaDidNotRejectAbsence:true};
});
await test('adk: invalid nonempty Zod output blocks downstream',async()=>{
  let downstream=0,caught;
  const bad=node(()=>({ok:'wrong'}),{name:'bad',outputSchema:z.object({ok:z.boolean()})});
  const after=node(()=>{downstream++;return true;},{name:'after'});
  try {await adkRun(new Workflow({name:'invalid',edges:[['START',bad,after]]}));}catch(e){caught=String(e);}
  assert.equal(downstream,0);assert.ok(caught);
  return {downstream,error:caught.slice(0,250)};
});
await test('adk: retry attempts bounded at three',async()=>{
  let attempts=0;
  const flaky=node(()=>{attempts++;if(attempts<3)throw new Error('transient');return {ok:true};},{name:'flaky',retryConfig:{maxAttempts:3,initialDelay:0.001,maxDelay:0.001,jitter:0}});
  await adkRun(new Workflow({name:'retry',edges:[['START',flaky]]}));assert.equal(attempts,3);return {attempts};
});

const State=Annotation.Root({a:Annotation(),b:Annotation(),joined:Annotation(),route:Annotation(),approved:Annotation()});
await test('langgraph: typed parallel branches + AND barrier',async()=>{
  let active=0,maxActive=0,joins=0;
  const branch=(key)=>async()=>{active++;maxActive=Math.max(active,maxActive);await delay(key==='a'?30:8);active--;return {[key]:z.object({ok:z.boolean(),revision:z.string()}).parse({ok:true,revision:'rev1'})};};
  const graph=new StateGraph(State).addNode('branch_a',branch('a')).addNode('branch_b',branch('b')).addNode('join',s=>{joins++;assert.equal(s.a.revision,s.b.revision);return {joined:true};}).addEdge(START,'branch_a').addEdge(START,'branch_b').addEdge(['branch_a','branch_b'],'join').addEdge('join',END).compile();
  const output=await graph.invoke({});assert.equal(maxActive,2);assert.equal(joins,1);assert.equal(output.joined,true);return {maxActive,joins,output};
});
await test('langgraph: business false requires explicit route/check',async()=>{
  let joins=0;const seen=[];
  const graph=new StateGraph(State).addNode('branch_a',()=>({a:{ok:true}})).addNode('branch_b',()=>({b:{ok:false}})).addNode('join',s=>{joins++;return {route:s.a.ok&&s.b.ok?'pass':'repair'};}).addNode('pass',()=>{seen.push('pass');return {};}).addNode('repair',()=>{seen.push('repair');return {};}).addEdge(START,'branch_a').addEdge(START,'branch_b').addEdge(['branch_a','branch_b'],'join').addConditionalEdges('join',s=>s.route,{pass:'pass',repair:'repair'}).addEdge('pass',END).addEdge('repair',END).compile();
  await graph.invoke({});assert.equal(joins,1);assert.deepEqual(seen,['repair']);return {joins,seen,engineDoesNotInterpretBusinessOk:true};
});
await test('langgraph: retry attempts bounded at three',async()=>{
  let attempts=0;
  const graph=new StateGraph(State).addNode('flaky',()=>{attempts++;if(attempts<3)throw new Error('transient');return {joined:true};},{retryPolicy:{maxAttempts:3,initialInterval:1,maxInterval:1,jitter:false,retryOn:()=>true}}).addEdge(START,'flaky').addEdge('flaky',END).compile();
  await graph.invoke({});assert.equal(attempts,3);return {attempts};
});
await test('langgraph: interrupt resumes by restarting interrupted node',async()=>{
  let priorRuns=0,beforeInterruptRuns=0,afterInterruptRuns=0;
  const graph=new StateGraph(State).addNode('prior',()=>{priorRuns++;return {a:'saved'};}).addNode('gate',()=>{beforeInterruptRuns++;const reply=interrupt({kind:'approval_request'});afterInterruptRuns++;return {approved:reply};}).addEdge(START,'prior').addEdge('prior','gate').addEdge('gate',END).compile({checkpointer:new MemorySaver()});
  const config={configurable:{thread_id:'offline_gate'}};
  const paused=await graph.invoke({},config);assert.ok(paused.__interrupt__?.length);
  const completed=await graph.invoke(new Command({resume:true}),config);
  assert.equal(priorRuns,1);assert.equal(beforeInterruptRuns,2);assert.equal(afterInterruptRuns,1);assert.equal(completed.approved,true);
  return {priorRuns,beforeInterruptRuns,afterInterruptRuns,persistence:'same-process MemorySaver only',resumeValueIsNotAuthorization:true};
});
await test('langgraph: recursion limit stops unbounded cycle',async()=>{
  let runs=0;const graph=new StateGraph(State).addNode('cycle',()=>{runs++;return {};}).addEdge(START,'cycle').addEdge('cycle','cycle').compile();
  let caught;try{await graph.invoke({},{recursionLimit:4});}catch(e){caught=e.name;}
  assert.equal(caught,'GraphRecursionError');assert.equal(runs,4);return {runs,error:caught};
});
writeFileSync('results.json',JSON.stringify({node:process.version,offline:true,integrationTested:false,results},null,2)+'\n');
console.log(`${results.filter(r=>r.pass).length}/${results.length} semantic probes passed`);
process.exitCode=results.every(r=>r.pass)?0:1;
