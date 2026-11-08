/** AttentionStore writes require FULL on every connection, including reopened and worker connections. */
export function openDurableSandboxDb(core, path) {
  const db = core.openDb({ path });
  try {
    db.pragma('synchronous=FULL');
    if (db.pragma('synchronous', { simple: true }) !== 2) throw Error('sandbox_database_durability_required');
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the durability failure. */ }
    throw error;
  }
}
