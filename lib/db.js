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
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 15000),
  statement_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 15000),
});

const q = (text, params) => pool.query(text, params);

module.exports = { pool, q };
