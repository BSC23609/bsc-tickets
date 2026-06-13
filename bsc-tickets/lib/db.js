const { Pool } = require('pg');

// Use the POOLED Neon connection string (…-pooler.…neon.tech) in DATABASE_URL.
// Small max keeps us well under Neon free-tier connection limits on serverless.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
});

const q = (text, params) => pool.query(text, params);

module.exports = { pool, q };
