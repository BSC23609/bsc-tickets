// Vercel serverless entry. All routes are handled by this single Express app
// (vercel.json rewrites /api/* and /api/cron/* here). Static pages live in /public.
const express = require('express');
const { q } = require('../lib/db');
const wati = require('../lib/wati');

const app = express();
app.use(express.json({ limit: '1mb' })); // photos go straight to OneDrive, not through here

app.get('/api/health', (req, res) =>
  res.json({ ok: true, wati: wati.configured(), graph: require('../lib/graph').configured() }));

// Deep link target for WhatsApp buttons: /t/<id> -> login (or app) carrying the ticket.
app.get('/t/:id', (req, res) =>
  res.redirect('/?t=' + encodeURIComponent(req.params.id)));

// Outpass approver deep link: /og/<id> -> login -> approval page for that request.
app.get('/og/:id', (req, res) =>
  res.redirect('/?og=' + encodeURIComponent(req.params.id)));

// Public, no-login PDF download for an approved pass (token from the WhatsApp button).
// The slip is regenerated from the DB on demand, so the link always works.
app.get('/dl/:token', async (req, res) => {
  try {
    const o = (await q(
      `SELECT o.*, r.emp_no AS req_code, r.name AS req_name, r.job_title AS designation
       FROM outpass_requests o JOIN employees r ON r.id = o.requester_id
       WHERE o.pdf_token=$1 AND o.status='approved'`, [req.params.token])).rows[0];
    if (!o) return res.status(404).send('Pass not found.');
    const { buildOutpassPDF } = require('../lib/outpass_pdf');
    const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const fmtDateTime = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const pdf = await buildOutpassPDF({
      type: o.type, on_duty: o.on_duty, date: fmtDate(o.req_date), emp_code: o.req_code,
      name: o.req_name, designation: o.designation || '', purpose: o.purpose, out_time: o.out_time,
      in_time: o.in_time, ref_no: o.ref_no, approver: o.actioned_by_name, approved_at: fmtDateTime(o.actioned_at) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${o.req_name} ${o.ref_no.replace(/\//g, '-')}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error('dl', e); res.status(500).send('Could not generate the pass.'); }
});

app.use('/api', require('../routes/auth.routes'));
app.use('/api/tickets', require('../routes/tickets.routes'));
app.use('/api/outpass', require('../routes/outpass.routes'));
app.use('/api/expense', require('../routes/expense.routes'));
app.use('/api/admin', require('../routes/admin.routes'));

// Public, no-login download of an expense PDF (token from the portal / email).
app.get('/dlx/:token', async (req, res) => {
  try {
    const exp = require('../routes/expense.routes')._internal;
    const row = (await q(`SELECT s.*, e.name AS emp_name, e.emp_no AS emp_code, e.job_title AS designation,
      e.expense_category FROM expense_submissions s JOIN employees e ON e.id=s.employee_id
      WHERE s.pdf_token=$1`, [req.params.token])).rows[0];
    if (!row) return res.status(404).send('Not found.');
    let pdf;
    const approved = row.status === 'approved';
    const approver = approved ? row.reviewed_by_name : undefined;
    const approvedAt = approved && row.reviewed_at ? new Date(row.reviewed_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : undefined;
    if (row.form_type === 'conveyance') pdf = await exp.conveyancePdf(row, row.status, approver, approvedAt);
    else if (row.form_type === 'outstation') pdf = await exp.outstationPdf(row, row.status, approver, approvedAt);
    else if (row.form_type === 'misc') pdf = await exp.miscPdf(row);
    else return res.status(404).send('Not available.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.emp_name} ${row.ref_no.replace(/\//g, '-')}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error('dlx', e); res.status(500).send('Could not generate the PDF.'); }
});

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
  // Safety-net rebuild of the OneDrive Excel log from the DB (covers any missed sync).
  try { await require('../lib/excel').syncLogToOneDrive(); } catch (e) { console.error('cron log sync', e); }
  res.json({ ok: true, auto_closed: rows.length });
});

app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'Server error' });
});

module.exports = app;
