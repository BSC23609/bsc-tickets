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
  connectionTimeoutMillis: 15000,
});

const q = (text, params) => pool.query(text, params);

module.exports = { pool, q };
