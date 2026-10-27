// Regenerate candidate pins after a state-owner-approved rebase. Never opens a serving home.
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runMigrations } from '../../dist/state/db.js';
import { CURRENT_SCHEMA_VERSION } from '../../dist/state/migrations.js';
import { canonicalJointJson, schemaSpecDigest } from '@osstack/protocol/joint';
const root = new URL('./', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileSha = name => sha(readFileSync(new URL(name, root)));
const db = new Database(':memory:');
try {
  db.pragma('foreign_keys=ON'); runMigrations(db);
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all().map(row => row.name);
  const catalog = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' ORDER BY type,name").all();
  const sourceCatalog = catalog(); const sourceTables = tables();
  db.exec(readFileSync(new URL('source-hold.sql', root), 'utf8'));
  if (db.pragma('foreign_key_check').length) throw Error('INVALID_SOURCE_FIXTURE');
  db.exec(readFileSync(new URL('bootstrap.sql', root), 'utf8'));
  const targetCatalog = catalog();
  const spec = {kind:'migration_spec',schema_version:1,schema_change_id:'operator-recovery-bootstrap-v1',source_schema:CURRENT_SCHEMA_VERSION,target_schema:CURRENT_SCHEMA_VERSION+1,ddl_digest:fileSha('bootstrap.sql'),fixture_digest:fileSha('source-hold.sql'),source_schema_digest:sha(canonicalJointJson(sourceCatalog)),target_schema_digest:sha(canonicalJointJson(targetCatalog)),expected_lineage_tables:tables()};
  const manifest = {status:'candidate_spec_only',base_commit:execFileSync('git',['rev-parse','origin/main'],{encoding:'utf8'}).trim(),spec,schema_spec_digest:schemaSpecDigest(spec),source_lineage_tables:sourceTables,source_schema:sourceCatalog,target_schema:targetCatalog,future_storage_digest:fileSha('future-storage.sql')};
  writeFileSync(new URL('manifest.json',root), JSON.stringify(manifest,null,2)+'\n');
} finally { db.close(); }
