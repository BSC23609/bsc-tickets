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

// One-tap approve/reject straight from the WhatsApp buttons (token = the request's
// action_token). No login: the unguessable token is the authorisation. Single-use
// (a second tap shows the current status) and dead once the pass date has passed.
const outpassActions = require('../routes/outpass.routes')._internal;
function actionPage(emoji, title, msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9">
  <div style="max-width:440px;margin:12vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px 24px;text-align:center">
    <div style="font-size:56px;line-height:1">${emoji}</div>
    <h2 style="color:#112532;margin:.5em 0 .2em">${title}</h2>
    <p style="color:#64748b;font-size:15px;margin:0">${msg}</p>
  </div></body></html>`;
}
async function loadByToken(token) {
  return (await q(
    `SELECT o.*, ap.name AS approver_name, r.name AS req_name
     FROM outpass_requests o LEFT JOIN employees ap ON ap.id = o.approver_id
     JOIN employees r ON r.id = o.requester_id WHERE o.action_token=$1`, [token])).rows[0];
}
function passExpired(reqDate) {
  const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(reqDate).toISOString().slice(0, 10) < istToday;
}
const typeName = (t) => (t === 'gatepass' ? 'gate pass' : 'outpass');

app.get('/oga/:token', async (req, res) => {
  try {
    const o = await loadByToken(req.params.token);
    if (!o) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This approval link is not recognised.'));
    if (o.status !== 'pending') return res.send(actionPage(o.status === 'approved' ? '✅' : '⛔', `Already ${o.status}`, `This request was already ${o.status}${o.actioned_by_name ? ' by ' + o.actioned_by_name : ''}.`));
    if (passExpired(o.req_date)) return res.send(actionPage('🕒', 'Link expired', 'The date on this pass has already passed.'));
    await outpassActions.applyApprove(o, o.approver_id, o.approver_name || o.approver_label || 'Approver');
    res.send(actionPage('✅', 'Approved', `${o.req_name}'s ${typeName(o.type)} is approved. The pass has been sent to them on WhatsApp.`));
  } catch (e) { console.error('oga', e); res.status(500).send(actionPage('⚠️', 'Something went wrong', 'Please try again, or use the app.')); }
});

app.get('/ogr/:token', async (req, res) => {
  try {
    const o = await loadByToken(req.params.token);
    if (!o) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This link is not recognised.'));
    if (o.status !== 'pending') return res.send(actionPage(o.status === 'approved' ? '✅' : '⛔', `Already ${o.status}`, `This request was already ${o.status}${o.actioned_by_name ? ' by ' + o.actioned_by_name : ''}.`));
    if (passExpired(o.req_date)) return res.send(actionPage('🕒', 'Link expired', 'The date on this pass has already passed.'));
    await outpassActions.applyReject(o, o.approver_id, o.approver_name || o.approver_label || 'Approver', null);
    res.send(actionPage('⛔', 'Rejected', `${o.req_name}'s ${typeName(o.type)} has been rejected. They have been notified.`));
  } catch (e) { console.error('ogr', e); res.status(500).send(actionPage('⚠️', 'Something went wrong', 'Please try again, or use the app.')); }
});

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

// ---- Cron: working-hours reminder / escalation engine ----
// Runs every ~15 min (GitHub Actions). Protected by CRON_SECRET. Only sends
// during Mon–Sat 09:30–18:00 IST (minus holidays); timers count working minutes.
app.all('/api/cron/escalate', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.key;
  if (secret && provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  const wati = require('../lib/wati');
  const { businessMinutesBetween, isWorkingNow, elapsedLabel } = require('../lib/util');

  const holidaySet = new Set((await q(`SELECT to_char(d,'YYYY-MM-DD') AS d FROM holidays`)).rows.map(r => r.d));
  if (!isWorkingNow(holidaySet)) return res.json({ ok: true, skipped: 'outside working hours', sent: 0 });

  const { rows: tickets } = await q(
    `SELECT t.id, t.ref_no, t.subject, t.priority, t.status, t.escalation_level,
            t.l1_emp_id, t.l2_emp_id, t.l3_emp_id, t.raised_at, t.assigned_at, t.last_reminder_at,
            c.pattern, c.wait_unassigned_mins, c.wait_cycle_mins, c.wait_l3_mins, c.name AS category_name,
            r.name AS requester_name,
            l1.name AS l1_name, l1.phone AS l1_phone, l2.name AS l2_name, l2.phone AS l2_phone,
            l3.name AS l3_name, l3.phone AS l3_phone
     FROM tickets t
     JOIN categories c ON c.id = t.category_id
     JOIN employees r ON r.id = t.requester_id
     LEFT JOIN employees l1 ON l1.id = t.l1_emp_id
     LEFT JOIN employees l2 ON l2.id = t.l2_emp_id
     LEFT JOIN employees l3 ON l3.id = t.l3_emp_id
     WHERE t.status IN ('open','in_progress','reopened')`);

  const now = Date.now();
  let sent = 0, fired = 0;
  for (const t of tickets) {
    const assigned = t.pattern === 'assign' && t.l1_emp_id;
    let threshold, cadenceAnchor, recipients, level = t.escalation_level || 0, markL3 = false;

    if (t.pattern === 'assign' && !t.l1_emp_id) {
      // unassigned: nudge L2 to assign
      threshold = t.wait_unassigned_mins || 60;
      cadenceAnchor = t.last_reminder_at || t.raised_at;
      recipients = [{ name: t.l2_name, phone: t.l2_phone }];
    } else if (assigned) {
      threshold = t.wait_cycle_mins || 120;
      cadenceAnchor = t.last_reminder_at || t.assigned_at;
      recipients = [{ name: t.l1_name, phone: t.l1_phone }, { name: t.l2_name, phone: t.l2_phone }];
      const sinceAssigned = businessMinutesBetween(t.assigned_at, now, holidaySet);
      if (t.l3_emp_id && sinceAssigned >= (t.wait_l3_mins || 240)) {
        recipients.push({ name: t.l3_name, phone: t.l3_phone });
        markL3 = true; level = 3;
      } else if (level < 2) { level = 2; }
    } else {
      // direct pattern: nudge the single L1
      threshold = t.wait_cycle_mins || 120;
      cadenceAnchor = t.last_reminder_at || t.raised_at;
      recipients = [{ name: t.l1_name, phone: t.l1_phone }];
    }

    if (businessMinutesBetween(cadenceAnchor, now, holidaySet) < threshold) continue;

    fired++;
    const label = elapsedLabel(businessMinutesBetween(t.raised_at, now, holidaySet));
    const tObj = { id: t.id, ref_no: t.ref_no, requester_name: t.requester_name,
      category_name: t.category_name, subject: t.subject };
    for (const h of recipients) { if (h.phone) { await wati.notify.reminder(h, tObj, label); sent++; } }

    await q(`UPDATE tickets SET last_reminder_at=now(), escalation_level=$2,
             escalated_l3_at=CASE WHEN $3 AND escalated_l3_at IS NULL THEN now() ELSE escalated_l3_at END
             WHERE id=$1`, [t.id, level, markL3]);
    await q(`INSERT INTO ticket_events(ticket_id,event,note) VALUES($1,'reminder',$2)`,
      [t.id, `${label} · notified ${recipients.map(r => r.name).filter(Boolean).join(', ')}`]);
  }

  res.json({ ok: true, scanned: tickets.length, fired, sent });
});

app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'Server error' });
});

module.exports = app;
