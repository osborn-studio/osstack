import { expect,it } from 'vitest';
import { handleNativeUpgradeCommand } from './upgrade-native-command.js';
import { managedStartupIdentity, verifyManagedRuntime } from './upgrade-native-backend.js';
it('explains explicit authority and refuses missing or mismatched plan approval before native work',async()=>{
 const errors:string[]=[];expect(await handleNativeUpgradeCommand(['apply-upgrade'],{stderr:s=>errors.push(s)})).toBe(1);
 expect(errors).toEqual(['upgrade_invalid_arguments']);const output:string[]=[];
 expect(await handleNativeUpgradeCommand(['reconcile-upgrade','--help'],{stdout:s=>output.push(s)})).toBe(0);
 expect(output.join('')).toContain('--approve-history');expect(output.join('')).toContain('never restores a database');
});
it('does not convert an artifact declaration into evidence of a running version or schema',()=>{
 const expected={deployment_kind:'npm' as const,build_digest:'a'.repeat(64),build_evidence:'host_manifest' as const,version:'2.0.0',protocol_version:1,database_schema:45};
 expect(()=>verifyManagedRuntime(expected,{version:'1.0.0',protocol_version:1,database_schema:45})).toThrow('upgrade_running_build_mismatch');
 expect(()=>verifyManagedRuntime(expected,{version:'2.0.0',protocol_version:1,database_schema:44})).toThrow('upgrade_running_build_mismatch');
 expect(verifyManagedRuntime(expected,{version:'2.0.0',protocol_version:1,database_schema:45})).toEqual({deployment_kind:'npm',build_digest:'a'.repeat(64),build_evidence:'host_manifest'});
});

it('leaves unmanaged invocations with a missing entry path alone',()=>{ expect(managedStartupIdentity('/missing-unmanaged-home','/missing-unmanaged-entry')).toBeNull(); });
