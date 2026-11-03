// Apply the schema DDL (all CREATE/ALTER ... IF NOT EXISTS — fully idempotent) once per
// serverless instance, so new columns from a release reach the database WITHOUT anyone
// having to run `npm run migrate` by hand. This mirrors what db/migrate.js does, minus the
// one-time seed logic (which only matters on a brand-new database).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./db');

let _p = null;
let _attempts = 0;

function autoMigrate() {
  if (_p) return _p;                       // already running or done this instance
  if (_attempts >= 3) return Promise.resolve(); // gave up — never block requests forever
  _attempts++;
  _p = (async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const ver = crypto.createHash('sha1').update(sql).digest('hex');
    const client = await pool.connect();
    try {
      // Version gate: run the full 152-statement DDL only when schema.sql actually changed.
      // Steady-state cold starts then cost 2 cheap queries instead of re-running everything,
      // so the first page load after the DB wakes isn't dragged down by the migrator.
      await client.query('CREATE TABLE IF NOT EXISTS schema_meta (version TEXT)');
      const cur = (await client.query('SELECT version FROM schema_meta LIMIT 1')).rows[0];
      if (cur && cur.version === ver) { console.log('[auto-migrate] schema already current'); return; }
      await client.query(sql);             // multi-statement DDL, all idempotent
      await client.query('DELETE FROM schema_meta');
      await client.query('INSERT INTO schema_meta(version) VALUES ($1)', [ver]);
      console.log('[auto-migrate] schema ensured + version recorded');
    } finally {
      client.release();
    }
  })();
  // On failure, clear the cache so the next request can retry (up to the attempt cap).
  _p.catch((e) => { console.error('[auto-migrate] failed:', e.message); _p = null; });
  return _p;
}

module.exports = { autoMigrate };
