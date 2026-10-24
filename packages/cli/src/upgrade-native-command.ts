import { UpgradeJournal } from './upgrade-journal.js';
import { coordinateUpgrade } from './upgrade-coordinator.js';
import { ManagedNativeUpgradePort } from './upgrade-native-port.js';
import { provisionManagedInstallation } from './upgrade-managed-provision.js';
import { upgradeDigest } from './upgrade-plan.js';
export const NATIVE_UPGRADE_HELP = `homes prepare-managed-installation --request FILE --approve-registry SHA256 --artifact FILE --artifact-sha256 SHA256
homes apply-upgrade --journal DIR --digest SHA256 --group ID --registry FILE --registry-sha256 SHA256 --artifact FILE --artifact-sha256 SHA256 --approve-plan SHA256
homes reconcile-upgrade (same flags) --approve-history SHA256
Managed launchd installations only. Explicit plan approval authorizes forward installation; planning does not.
Reconciliation requires current upgrade-status records digest, never restores a database, and stops on unknown observations.`;
export async function handleNativeUpgradeCommand(args: string[], io: {stdout?:(s:string)=>void;stderr?:(s:string)=>void} = {}): Promise<number> {
  const out = io.stdout ?? console.log; const err = io.stderr ?? console.error;
  if (args.at(-1) === '--help') { out(NATIVE_UPGRADE_HELP); return 0; }
  let port: ManagedNativeUpgradePort | undefined;
  try {
    const command = args[0]; if (!['apply-upgrade','reconcile-upgrade','prepare-managed-installation'].includes(command!)) throw Error('upgrade_invalid_command');
    const required = command === 'prepare-managed-installation' ? ['--request','--approve-registry','--artifact','--artifact-sha256'] : ['--journal','--digest','--group','--registry','--registry-sha256','--artifact','--artifact-sha256','--approve-plan',...(command === 'reconcile-upgrade' ? ['--approve-history'] : [])];
    const flags = new Map<string,string>();
    for (let i=1;i<args.length;i++) { const key=args[i]!; const value=args[++i]; if (!required.includes(key) || flags.has(key) || !value || value.startsWith('--') || value.length>4096) throw Error('upgrade_invalid_arguments'); flags.set(key,value); }
    if (flags.size !== required.length) throw Error('upgrade_invalid_arguments');
    if (command === 'prepare-managed-installation') { out(JSON.stringify(await provisionManagedInstallation({request:flags.get('--request')!,approvedRegistryDigest:flags.get('--approve-registry')!,artifact:flags.get('--artifact')!,artifactDigest:flags.get('--artifact-sha256')!},AbortSignal.timeout(300000)))); return 0; }
    if (flags.get('--digest') !== flags.get('--approve-plan')) throw Error('upgrade_explicit_approval_required');
    const journal = new UpgradeJournal(flags.get('--journal')!); const plan = await journal.plan(flags.get('--digest')!); const group=plan.plan.groups.find(g=>g.group_id===flags.get('--group'));
    if (!group) throw Error('upgrade_group_missing');
    port = new ManagedNativeUpgradePort({registry:flags.get('--registry')!,registryDigest:flags.get('--registry-sha256')!,artifact:flags.get('--artifact')!,artifactDigest:flags.get('--artifact-sha256')!,approvedPlanDigest:flags.get('--approve-plan')!});
    const initialStatus=await journal.status(plan.digest,group.group_id);
    if(command==='apply-upgrade'&&initialStatus.completed){out(JSON.stringify({state:'verified',history_digest:upgradeDigest(initialStatus.records),reason:'inspect_native_fence_before_new_plan'}));return 0;}
    const signal=AbortSignal.timeout(Math.min(plan.plan.budget.max_total_ms,300000));
    if (command==='reconcile-upgrade') { out(JSON.stringify(await port.reconcileForward(plan,group,journal,flags.get('--approve-history')!,signal))); return 0; }
    const result=await coordinateUpgrade({journal,plan,groupId:group.group_id,port,signal});
    if(result.state==='verified'&&result.reason===null) await port.complete();
    const status=await journal.status(plan.digest,group.group_id); out(JSON.stringify({...result,history_digest:upgradeDigest(status.records)})); return result.state==='verified'?0:2;
  } catch(error) { err(error instanceof Error && /^upgrade_[a-z_]+$/.test(error.message)?error.message:'upgrade_unavailable'); return 1; }
  finally { await port?.close(); }
}
