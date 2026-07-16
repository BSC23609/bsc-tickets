const { Pool } = require('pg');

// SSL is configured explicitly below (encrypted, no cert-chain validation — works
// with Neon's pooled endpoint on Vercel). A bare `sslmode=require` left in the URL
// makes newer pg emit a deprecation warning, so we drop it and let `ssl` govern.
function stripSslMode(raw) {
  if (!raw) return raw;
  try { const u = new URL(raw); u.searchParams.delete('sslmode'); return u.toString(); }
  catch { return raw; }
}

// Use the POOLED Neon connection string (…-pooler.…neon.tech) in DATABASE_URL.
// Small max keeps us well under Neon free-tier connection limits on serverless.
const pool = new Pool({
  connectionString: stripSslMode(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  // Keep these well inside the Vercel function budget. A suspended Neon compute (free tier
  // sleeps after ~5 min idle) can otherwise leave a cold cron blocked until the platform
  // kills it — which the caller sees as a 504 rather than a clean error.
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  // Server-side statement timeout only. We deliberately DROP node-pg's client-side `query_timeout`:
  // when it fires mid-transaction it rejects the JS promise while the statement may still be running
  // server-side, which can leave a connection half-in-transaction and poison the pool. `statement_timeout`
  // is cancelled cleanly by Postgres itself and leaves the connection usable.
  statement_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 20000),
});

// Never let an error on an idle pooled connection crash the function; drop the bad client instead.
pool.on('error', (err) => { console.error('[pg pool] idle client error:', err.message); });

const q = (text, params) => pool.query(text, params);

module.exports = { pool, q };
