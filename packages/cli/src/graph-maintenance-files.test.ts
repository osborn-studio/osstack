import { createScratchDirSync } from '@osstack/core';
import Database from 'better-sqlite3';
import { linkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { reconcileUnstartedPreparation } from './graph-maintenance.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it.each(['database-hardlink','sidecar-symlink'])('refuses %s before maintenance can mutate SQLite',async kind=>{
 const home=realpathSync(createScratchDirSync('tests','maintenance-files'));roots.push(home);
 const path=join(home,'state.db');new Database(path).close();
 if(kind==='database-hardlink')linkSync(path,join(home,'alias.db'));
 else {writeFileSync(join(home,'external'),'preserved');symlinkSync(join(home,'external'),`${path}-wal`);}
 await expect(reconcileUnstartedPreparation({home,graphRunId:'00000000-0000-0000-0000-000000000000',expectedRevision:0,apply:true})).rejects.toThrow(kind==='database-hardlink'?'MAINTENANCE_OWNER_REQUIRED':'db_path_not_single_file');
 if(kind==='sidecar-symlink')rmSync(`${path}-wal`);
 const check=new Database(path);try{expect(check.pragma('user_version',{simple:true})).toBe(0);}finally{check.close();}
});
