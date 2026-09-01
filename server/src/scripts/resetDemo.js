// Deletes the test accounts created while building phase 1, leaving the real admin alone.
// Handy while checking the app; not something to keep once real users exist.
const { withDatabase, runAsync, allAsync } = require('../db/connection');
(async () => {
  const removed = await withDatabase(async (db) => {
    const rows = await allAsync(db, "SELECT id, login_id FROM users WHERE role != 'admin'");
    for (const r of rows) await runAsync(db, 'DELETE FROM users WHERE id = ?', [r.id]);
    return rows.map((r) => r.login_id);
  });
  console.log(removed.length ? `  removed: ${removed.join(', ')}` : '  nothing to remove');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
