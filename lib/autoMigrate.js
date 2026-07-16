// Apply the schema DDL (all CREATE/ALTER ... IF NOT EXISTS — fully idempotent) once per
// serverless instance, so new columns from a release reach the database WITHOUT anyone
// having to run `npm run migrate` by hand. This mirrors what db/migrate.js does, minus the
// one-time seed logic (which only matters on a brand-new database).
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

let _p = null;
let _attempts = 0;

function autoMigrate() {
  if (_p) return _p;                       // already running or done this instance
  if (_attempts >= 3) return Promise.resolve(); // gave up — never block requests forever
  _attempts++;
  _p = (async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await client.query(sql);             // multi-statement DDL, all idempotent
      console.log('[auto-migrate] schema ensured');
    } finally {
      client.release();
    }
  })();
  // On failure, clear the cache so the next request can retry (up to the attempt cap).
  _p.catch((e) => { console.error('[auto-migrate] failed:', e.message); _p = null; });
  return _p;
}

module.exports = { autoMigrate };
