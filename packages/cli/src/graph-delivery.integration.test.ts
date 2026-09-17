import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDb, CapabilitySchema } from '@osstack/core';
import { FifoSemaphore } from '@osstack/autonomy';
import { GraphDelivery } from './graph-delivery.js';
import { GovernedExecution } from './governed-execution.js';
import type { AgentAdapter } from '@osstack/agents';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function delivery(mode: 'direct' | 'repair' | 'retry' | 'failure' | 'negative', slow: 'review' | 'tests' = 'review') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'g21-delivery-'))); const repo = join(root, 'source'); await mkdir(repo);
  git(repo, 'init','-q'); await writeFile(join(repo, 'answer'), '0\n'); git(repo, 'add','.'); git(repo,'-c','user.name=G21','-c','user.email=g21@invalid','commit','-qm','base');
  const base = git(repo,'rev-parse','HEAD');
  const db = openDb({ path: join(root, 'control.sqlite') });
  let writes = 0; let reviews = 0; let originalCreatedAt: number | undefined; const prompts: string[] = []; const paths: string[] = [];
  const stopped = new Set<string>();
  const waitConfirmed = async (kind: string) => {
    const until = Date.now() + 10000;
    while (!(db.prepare("SELECT 1 FROM graph_actions WHERE node_id=? AND state='confirmed'").get(`e0.${kind}`))) {
      if (Date.now() > until) throw Error('COMPLETION_BARRIER_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const writer: AgentAdapter = { id: 'writer', display_name: 'writer', cost_tier: 'low',
    capabilities: () => [CapabilitySchema.parse({ id:'write',agent_id:'writer',kind:'code.write',description:'write' })],
    isAvailable: async () => ({ available:true,last_checked_at:0 }),
    invoke: async function* (task) { originalCreatedAt ??= (db.prepare('SELECT created_at FROM graph_runs').get() as { created_at: number }).created_at; writes++; prompts.push(task.prompt); const path = String(task.context?.['repo_path']); paths.push(path);
      await writeFile(join(path, 'answer'), mode === 'negative' || (mode === 'repair' && writes === 1) ? '0\n' : '1\n');
      stopped.add(task.run_id);
      yield { event_id: task.run_id,run_id:task.run_id,session_id:task.session_id,seq:1,created_at:Date.now()/1000,type:'done',terminal:true,payload:{status:'completed',last_seq:0,result_summary:'implemented',usage:{tokens_in:1,tokens_out:1,duration_ms:1}} };
    }, confirmStopped: async id => ({ stopped:stopped.has(id), evidence:`finite-writer:${id}` }) };
  const reviewer: AgentAdapter = { ...writer, id:'reviewer', capabilities: () => [CapabilitySchema.parse({ id:'review',agent_id:'reviewer',kind:'review.code',description:'review' })],
    invoke: async function* (task) { reviews++; paths.push(String(task.context?.['repo_path'])); if (mode === 'direct' && slow === 'review') await waitConfirmed('tests');
      const good = (await readFile(join(String(task.context?.['repo_path']),'answer'),'utf8')).trim() === '1';
      const summary = mode === 'failure' || (mode === 'retry' && reviews === 1) ? 'malformed' : JSON.stringify({schemaVersion:1,verdict:good?'accept':'changes_requested',summary:'actual candidate inspected',findings:good?[]:['answer must be 1']});
      stopped.add(task.run_id);
      yield {event_id:task.run_id,run_id:task.run_id,session_id:task.session_id,seq:1,created_at:Date.now()/1000,type:'done',terminal:true,payload:{status:'completed',last_seq:0,result_summary:summary,usage:{tokens_in:1,tokens_out:1,duration_ms:1}}};
    } };
  const admission = new GovernedExecution({ reads:new FifoSemaphore(2),writes:new FifoSemaphore(2),repositories:new Map(),checkHealth:async()=>{} });
  const containedConfigPath = process.env['G25_CONTAINED_CONFIG'];
  const containedConfig = containedConfigPath ? JSON.parse(await readFile(containedConfigPath, 'utf8')) as { socketPath: string; daemonId: string; baseImageId: string } : undefined;
  const journalRoot = join(root, 'contained-journal'); if (containedConfig) await mkdir(journalRoot);
  const host = new GraphDelivery({db,
    ...(containedConfig ? { containedTests: { ...containedConfig, journalRoot, authorizeStop: () => {}, authorizeRead: () => {} } } : {}), root:join(root,'delivery'),repositoryPath:repo,task:'Set answer to 1',writer:{identity:'writer',adapter:writer,capabilityId:'write'},
    reviewer:{identity:'reviewer',adapter:reviewer,capabilityId:'review'},verifyReviewer:async p=>{if(p.writerIdentity === p.reviewerIdentity) throw Error('not independent');},
    acceptanceRegistry:[{ref:'acceptance',command:`${slow === 'tests' ? 'sleep 0.2; ' : ''}test "$(cat answer)" = 1`,passExitCodes:[0],failExitCodes:[1]}],acquire:async i=>{ if(mode === 'direct' && slow === 'tests' && /\/tests-[^/]+$/.test(i.workspacePath ?? '')) await waitConfirmed('review'); return admission.acquire(i); },authorize:()=>{},
    request:{schemaVersion:1,kind:'start',scope:{schemaVersion:1,tenantId:'t',principalId:'p',workspaceId:'w'},idempotencyKey:'delivery',inputArtifactRef:'input',source:{product:'osstack',requestId:'delivery'},
      spec:{schemaVersion:1,template:'code-delivery-v1',publication:'artifact_only',input:{taskRef:'task',repositoryRef:'repo',baseRevision:base,acceptanceRef:'acceptance'},
        limits:{maxEpochs:mode === 'repair'?2:1,maxBranchAttempts:2,maxConcurrentReaders:2,maxConcurrentWritersPerRepo:1,maxActionStarts:22,tokenReservationLimit:200000,deadlineSeconds:120}}} });
  try {
    const result = await host.run();
    expect(await readFile(join(repo,'answer'),'utf8')).toBe('0\n'); expect(git(repo,'rev-parse','HEAD')).toBe(base);
    const actions = db.prepare('SELECT * FROM graph_actions ORDER BY created_at,rowid').all() as Array<{node_id:string;state:string;reservation_tokens:number;action_json:string}>;
    expect(actions.every(a=>['confirmed','failed'].includes(a.state))).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({n:0});
    expect(actions.filter(a=>a.node_id.includes('.prepare_'))).toHaveLength(mode === 'repair'?4:mode === 'retry'||mode === 'failure'?3:2);
    expect(actions.filter(a=>a.node_id.endsWith('.review')).every(a=>a.reservation_tokens===16384)).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM graph_checkpoints').get()).toMatchObject({n:expect.any(Number)});
    expect(new Set(paths).size).toBe(paths.length);
    expect(host.current().createdAt).toBe(originalCreatedAt);
    expect(host.current().spec).toEqual(host.compiled.spec);
    if (mode === 'direct') expect((db.prepare("SELECT node_id FROM graph_actions WHERE node_id IN ('e0.review','e0.tests') ORDER BY updated_at").all() as {node_id:string}[]).map(a=>a.node_id)).toEqual(slow === 'review' ? ['e0.tests','e0.review'] : ['e0.review','e0.tests']);
    if (mode === 'repair') {
      expect(db.prepare('SELECT generation FROM graph_worker_launches ORDER BY generation').all()).toEqual([{generation:1},{generation:2}]);
      const permits = db.prepare('SELECT epoch,join_ref FROM graph_delivery_epochs ORDER BY epoch').all() as {epoch:number;join_ref:string|null}[];
      expect(permits[0]).toEqual({epoch:0,join_ref:null}); expect(permits[1]!.join_ref).toMatch(/^graph-join:/);
    }
    expect(db.prepare("SELECT count(*) AS n FROM graph_checkpoint_writes WHERE channel='__return__' AND value LIKE '%OUTPUT_CONTRACT_INVALID%'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM graph_worker_launches').get()).toEqual({n: mode === 'repair' ? 2 : 1});
    expect(db.prepare('SELECT count(*) AS n FROM graph_verification_joins').get()).toEqual({n: mode === 'repair' ? 2 : mode === 'failure' ? 0 : 1});
    if (containedConfig && process.env['G25_CONTAINED_REPORT_DIR']) await writeFile(join(process.env['G25_CONTAINED_REPORT_DIR'], `delivery-${mode}-${slow}.json`), JSON.stringify({ route: result.route, writes, reviews, generation: host.current().generation, actions, root }, null, 2));
    return {result,writes,reviews,prompts,actions,root,run:host.current()};
  } finally { db.close(); }
}
it.each(['review','tests'] as const)('actual child delivery succeeds with %s finishing last', async slow=>{
  const f = await delivery('direct',slow); expect(f.result.route.kind).toBe('ready'); expect(f.writes).toBe(1); expect(f.reviews).toBe(1); expect(f.actions).toHaveLength(7);
},30000);
it('repairs from immutable complete join through physical child stop and G15 resume',async()=>{
  const f=await delivery('repair'); expect(f.result.route.kind).toBe('ready'); expect(f.writes).toBe(2); expect(f.prompts[1]).toContain('"kind":"review"'); expect(f.prompts[1]).toContain('"kind":"tests"'); expect(f.run.generation).toBe(2); expect(f.actions).toHaveLength(14);
},45000);
it('host bounded retry returns only final confirmed task result and fresh independent workspace',async()=>{
  const f=await delivery('retry'); expect(f.result.route.kind).toBe('ready'); expect(f.reviews).toBe(2); expect(f.actions).toHaveLength(9);
},30000);
it('finite branch failure stops without a failed task RETURN or poisoned join',async()=>{
  const f=await delivery('failure'); expect(f.result.route).toMatchObject({kind:'stop',reason:'branch_budget'}); expect(f.reviews).toBe(2);
},30000);
it('negative quality at epoch cap stops',async()=>{
  const f=await delivery('negative'); expect(f.result.route).toMatchObject({kind:'stop',reason:'epoch_budget'}); expect(f.writes).toBe(1);
},30000);
