// Vercel serverless entry. All routes are handled by this single Express app
// (vercel.json rewrites /api/* and /api/cron/* here). Static pages live in /public.
const express = require('express');
const { q } = require('../lib/db');
const wati = require('../lib/wati');

const app = express();
app.use(express.json({ limit: '1mb' })); // photos go straight to OneDrive, not through here

app.get('/api/health', (req, res) =>
  res.json({ ok: true, wati: wati.configured(), graph: require('../lib/graph').configured() }));

app.use('/api', require('../routes/auth.routes'));
app.use('/api/tickets', require('../routes/tickets.routes'));
app.use('/api/admin', require('../routes/admin.routes'));

// ---- Cron: 48-hr auto-confirm-close of resolved tickets ----
// Triggered daily by Vercel Cron (see vercel.json). Protected by CRON_SECRET.
app.all('/api/cron/auto-close', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.key;
  if (secret && provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await q(
    `UPDATE tickets SET status='closed', closed_at=now(), closed_auto=TRUE
     WHERE status='resolved' AND resolved_at < now() - interval '48 hours'
     RETURNING id`);
  for (const r of rows) {
    await q(`INSERT INTO ticket_events(ticket_id,event,note) VALUES($1,'auto_closed','Auto-closed after 48h no response')`, [r.id]);
  }
  res.json({ ok: true, auto_closed: rows.length });
});

app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'Server error' });
});

module.exports = app;
