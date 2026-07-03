// Vercel serverless entry. All routes are handled by this single Express app
// (vercel.json rewrites /api/* and /api/cron/* here). Static pages live in /public.
const express = require('express');
const { q } = require('../lib/db');
const wati = require('../lib/wati');

const app = express();
app.use(express.json({ limit: '1mb' })); // photos go straight to OneDrive, not through here
app.use(express.urlencoded({ extended: false })); // reject-reason form post from the WhatsApp link

app.get('/api/health', (req, res) =>
  res.json({ ok: true, wati: wati.configured(), graph: require('../lib/graph').configured() }));

// Deep link target for WhatsApp buttons: /t/<id> -> login (or app) carrying the ticket.
app.get('/t/:id', (req, res) =>
  res.redirect('/?t=' + encodeURIComponent(req.params.id)));

// Outpass approver deep link: /og/<id> -> login -> approval page for that request.
app.get('/og/:id', (req, res) =>
  res.redirect('/?og=' + encodeURIComponent(req.params.id)));

// Expense approver deep link: /e/<id> -> login -> that claim opens in the portal.
app.get('/e/:id', (req, res) =>
  res.redirect('/?claim=' + encodeURIComponent(req.params.id)));

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

// ---- Local Conveyance: reporting-manager one-tap approve/reject (per trip) ----
const fmtTripDate = (s) => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const tripRouteLabel = (t) => [t.from_loc, t.to_loc].filter(Boolean).join(' \u2192 ') || (t.purpose || 'Trip');
const inrLabel = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function rejectPage(token, t) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reject trip</title></head>
  <body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9">
  <div style="max-width:440px;margin:8vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 24px">
    <div style="font-size:44px;line-height:1;text-align:center">📝</div>
    <h2 style="color:#112532;margin:.4em 0 .2em;text-align:center">Reject this trip?</h2>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;color:#334155;font-size:14px">
      <div><b>${t.emp_name}</b></div>
      <div style="color:#64748b">${fmtTripDate(t.trip_date_s)} · ${tripRouteLabel(t)}</div>
      <div style="color:#64748b">${t.purpose ? t.purpose + ' · ' : ''}${t.km} km · ${inrLabel(t.amount)}</div>
    </div>
    <form method="POST" action="/cvr/${token}">
      <label style="font-size:13px;color:#64748b">Reason (optional, shown to the employee)</label>
      <textarea name="reason" rows="3" placeholder="e.g. Wrong distance / personal trip" style="width:100%;box-sizing:border-box;margin-top:6px;padding:10px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px"></textarea>
      <button type="submit" style="width:100%;margin-top:14px;background:#dc2626;color:#fff;border:0;border-radius:10px;padding:13px;font-size:15px;font-weight:600">Confirm rejection</button>
    </form>
  </div></body></html>`;
}
app.get('/cva/:token', async (req, res) => {
  try {
    const conv = require('../routes/expense.routes')._internal;
    const t = await conv.loadTripByToken(req.params.token);
    if (!t) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This approval link is not recognised, or the trip was already handled.'));
    if (t.status !== 'pending') return res.send(actionPage(t.status === 'approved' ? '✅' : '⛔', `Already ${t.status}`, `This trip was already ${t.status}.`));
    await conv.applyTripApprove(t);
    res.send(actionPage('✅', 'Approved', `${t.emp_name}'s trip on ${fmtTripDate(t.trip_date_s)} (${tripRouteLabel(t)}) is approved. They have been notified.`));
  } catch (e) { console.error('cva', e); res.status(500).send(actionPage('⚠️', 'Something went wrong', 'Please try again.')); }
});
app.get('/cvr/:token', async (req, res) => {
  try {
    const conv = require('../routes/expense.routes')._internal;
    const t = await conv.loadTripByToken(req.params.token);
    if (!t) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This link is not recognised, or the trip was already handled.'));
    if (t.status !== 'pending') return res.send(actionPage(t.status === 'approved' ? '✅' : '⛔', `Already ${t.status}`, `This trip was already ${t.status}.`));
    res.send(rejectPage(req.params.token, t));
  } catch (e) { console.error('cvr-get', e); res.status(500).send(actionPage('⚠️', 'Something went wrong', 'Please try again.')); }
});
app.post('/cvr/:token', async (req, res) => {
  try {
    const conv = require('../routes/expense.routes')._internal;
    const t = await conv.loadTripByToken(req.params.token);
    if (!t) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This link is not recognised, or the trip was already handled.'));
    if (t.status !== 'pending') return res.send(actionPage(t.status === 'approved' ? '✅' : '⛔', `Already ${t.status}`, `This trip was already ${t.status}.`));
    const reason = ((req.body && req.body.reason) || '').toString().trim();
    await conv.applyTripReject(t, reason);
    res.send(actionPage('⛔', 'Rejected', `${t.emp_name}'s trip on ${fmtTripDate(t.trip_date_s)} has been rejected. They have been notified.`));
  } catch (e) { console.error('cvr-post', e); res.status(500).send(actionPage('⚠️', 'Something went wrong', 'Please try again.')); }
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
    const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
    const fmtDateTime = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
app.use('/api/genset', require('../routes/genset.routes'));

// Public, no-login download of an expense PDF (token from the portal / email).
app.get('/rx/:token', async (req, res) => {
  try {
    const report = require('../lib/expense_report');
    const period = report.verifyLink(req.params.token);
    if (!period) return res.status(404).send('This report link has expired or is invalid.');
    const buf = await report.buildReportBuffer(period);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${report.reportFileName(period)}"`);
    res.send(buf);
  } catch (e) { console.error('rx', e); res.status(500).send('Could not generate the report.'); }
});
app.get('/dlx/:token', async (req, res) => {
  try {
    const exp = require('../routes/expense.routes')._internal;
    const row = (await q(`SELECT s.*, e.name AS emp_name, e.emp_no AS emp_code, e.job_title AS designation,
      e.expense_category FROM expense_submissions s JOIN employees e ON e.id=s.employee_id
      WHERE s.pdf_token=$1`, [req.params.token])).rows[0];
    if (!row) return res.status(404).send('Not found.');
    let pdf;
    const approved = row.status === 'approved';
    const approver = approved ? (row.final_by_name || row.reviewed_by_name) : undefined;
    const approvedAt = approved && (row.final_at || row.reviewed_at) ? new Date(row.final_at || row.reviewed_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : undefined;
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

// ---- Ticket resolve: one-tap Confirm-close / Reopen from the requester's WhatsApp ----
// Token = the ticket's confirm_token (rotated on every resolve). No login needed.
async function loadTicketByToken(token) {
  return (await q(
    `SELECT t.*, c.name AS category_name, r.name AS requester_name
     FROM tickets t JOIN categories c ON c.id=t.category_id JOIN employees r ON r.id=t.requester_id
     WHERE t.confirm_token=$1`, [token])).rows[0];
}

app.get('/rc/:token', async (req, res) => {
  try {
    const t = await loadTicketByToken(req.params.token);
    if (!t) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This link is not recognised, or a newer update has replaced it.'));
    if (t.status === 'closed') return res.send(actionPage('✅', 'Already closed', `Ticket ${t.ref_no} is already closed. Thank you!`));
    if (t.status !== 'resolved') return res.send(actionPage('ℹ️', 'Ticket is active', `Ticket ${t.ref_no} is currently "${t.status}", so there's nothing to confirm right now.`));
    await q(`UPDATE tickets SET status='closed', closed_at=now() WHERE id=$1`, [t.id]);
    await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'confirmed_closed',$2,'Confirmed from WhatsApp')`, [t.id, t.requester_id]);
    require('../lib/bg').background(require('../lib/excel').syncLogToOneDrive());
    res.send(actionPage('✅', 'Confirmed & closed', `Thanks! Ticket ${t.ref_no} — "${t.subject}" is now closed.`));
  } catch (e) { console.error('rc', e); res.status(500).send(actionPage('⚠️', 'Something went wrong', 'Please try again, or open the app.')); }
});

app.get('/rr/:token', async (req, res) => {
  try {
    const t = await loadTicketByToken(req.params.token);
    if (!t) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This link is not recognised, or a newer update has replaced it.'));
    if (['open', 'in_progress', 'reopened'].includes(t.status))
      return res.send(actionPage('↩️', 'Already reopened', `Ticket ${t.ref_no} is open again — the team is on it.`));
    if (!['resolved', 'closed'].includes(t.status))
      return res.send(actionPage('ℹ️', 'No action needed', `Ticket ${t.ref_no} is "${t.status}".`));
    await q(`UPDATE tickets SET status='reopened', resolved_at=NULL, closed_at=NULL WHERE id=$1`, [t.id]);
    await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'reopened',$2,'Reopened from WhatsApp')`, [t.id, t.requester_id]);
    require('../lib/bg').background((async () => {
      const l1 = (await q('SELECT id,name,phone FROM employees WHERE id=$1', [t.l1_emp_id])).rows[0];
      if (l1 && l1.phone) await wati.notify.reopened(l1, { ...t, requester_name: t.requester_name });
      await require('../lib/excel').syncLogToOneDrive();
    })());
    res.send(actionPage('↩️', 'Reopened', `Ticket ${t.ref_no} — "${t.subject}" has been reopened and the handler notified.`));
  } catch (e) { console.error('rr', e); res.status(500).send(actionPage('⚠️', 'Something went wrong', 'Please try again, or open the app.')); }
});

// ---- Resolution attachments: tokenized download (no login), linked from the WhatsApp button ----
const _docMime = (name) => {
  const ext = (name || '').toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain', csv: 'text/csv' })[ext] || 'application/octet-stream';
};
async function streamDoc(res, doc) {
  const buf = await require('../lib/graph').fetchDriveItemContent(doc.drive_item_id);
  if (!buf) return res.status(502).send('Could not fetch the file from storage.');
  res.setHeader('Content-Type', _docMime(doc.file_name));
  res.setHeader('Content-Disposition', `inline; filename="${(doc.file_name || 'document').replace(/"/g, '')}"`);
  res.send(buf);
}
app.get('/rd/:token', async (req, res) => {
  try {
    const t = (await q(`SELECT id, ref_no, subject FROM tickets WHERE confirm_token=$1`, [req.params.token])).rows[0];
    if (!t) return res.status(404).send(actionPage('⛔', 'Link not valid', 'This link is not recognised, or a newer update has replaced it.'));
    const docs = (await q(`SELECT id, file_name, drive_item_id FROM ticket_photos WHERE ticket_id=$1 AND kind='resolution' ORDER BY id`, [t.id])).rows;
    if (!docs.length) return res.send(actionPage('📄', 'No documents', `No documents are attached to ticket ${t.ref_no}.`));
    if (docs.length === 1) return streamDoc(res, docs[0]);
    const tok = encodeURIComponent(req.params.token);
    const items = docs.map((d) => `<a href="/rd/${tok}/file/${d.id}" style="display:block;margin:8px 0;padding:12px 16px;background:#1B7BC0;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">⬇ ${String(d.file_name).replace(/</g, '&lt;')}</a>`).join('');
    return res.send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#112532"><h2 style="margin:0 0 4px">Resolution documents</h2><div style="color:#8A97A3;font-size:14px;margin-bottom:16px">${t.ref_no} — ${String(t.subject).replace(/</g, '&lt;')}</div>${items}</body>`);
  } catch (e) { console.error('rd', e); res.status(500).send('error'); }
});
app.get('/rd/:token/file/:docId', async (req, res) => {
  try {
    const t = (await q(`SELECT id FROM tickets WHERE confirm_token=$1`, [req.params.token])).rows[0];
    if (!t) return res.status(404).send('Link not valid');
    const d = (await q(`SELECT file_name, drive_item_id FROM ticket_photos WHERE id=$1 AND ticket_id=$2 AND kind='resolution'`, [+req.params.docId, t.id])).rows[0];
    if (!d) return res.status(404).send('Not found');
    return streamDoc(res, d);
  } catch (e) { console.error('rd file', e); res.status(500).send('error'); }
});

// ---- SSO: hand a sibling app (e.g. QMS) a short-lived signed emp_no token ----
// The portal is the login authority; the other app trusts this token and starts its own session.
app.get('/sso/go', require('../lib/auth').requireAuth, (req, res) => {
  const targets = { qms: process.env.QMS_SSO_URL || 'https://qms.bharatsteels.in/auth/sso' };
  const base = targets[req.query.to];
  if (!base) return res.status(404).send('Unknown app');
  // Restricted apps require an explicit grant (admins always allowed).
  if (!require('../lib/apps').appAccessFor(req.user)[req.query.to])
    return res.status(403).send('You do not have access to this app. Contact IT if you need it.');
  const secret = process.env.SSO_SECRET;
  if (!secret) return res.status(500).send('SSO is not configured (set SSO_SECRET).');
  const token = require('jsonwebtoken').sign(
    { emp_no: req.user.emp_no, name: req.user.name }, secret,
    { expiresIn: '90s', issuer: 'bsc-portal' });
  res.redirect(`${base}?token=${encodeURIComponent(token)}`);
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
            t.l1_emp_id, t.l2_emp_id, t.l3_emp_id, t.raised_at, t.last_reminder_at,
            t.external_hold, t.external_set_at, t.external_hours,
            c.name AS category_name, c.wait_cycle_mins, c.wait_l3_mins, r.name AS requester_name,
            l1.name AS l1_name, l1.phone AS l1_phone, l2.name AS l2_name, l2.phone AS l2_phone,
            l3.name AS l3_name, l3.phone AS l3_phone
     FROM tickets t
     JOIN categories c ON c.id = t.category_id
     JOIN employees r ON r.id = t.requester_id
     LEFT JOIN employees l1 ON l1.id = t.l1_emp_id
     LEFT JOIN employees l2 ON l2.id = t.l2_emp_id
     LEFT JOIN employees l3 ON l3.id = t.l3_emp_id
     WHERE t.status IN ('open','in_progress','reopened')`);

  // Uniform escalation for every category/trade:
  //   >= 2h unresolved -> remind L1 + L2      (level 2)
  //   >= 4h unresolved -> remind L1 + L2 + L3  (level 3), then re-nudge every cycle.
  // Per-category timing, falling back to global app_settings, then defaults.
  const S = (await q(`SELECT key,value FROM app_settings WHERE key IN ('remind_l2_mins','remind_l3_mins','remind_repeat_mins')`)).rows
    .reduce((m, r) => (m[r.key] = Number(r.value) || null, m), {});
  const REPEAT = S.remind_repeat_mins || 120;

  const now = Date.now();
  let sent = 0, fired = 0;
  for (const t of tickets) {
    // On external/vendor hold: stay quiet until the working-hours ETA lapses, then resume reminders.
    if (t.external_hold && t.external_set_at) {
      const held = businessMinutesBetween(t.external_set_at, now, holidaySet);
      if (held < (Number(t.external_hours) || 0) * 60) continue;
    }
    const L2_AFTER = t.wait_cycle_mins || S.remind_l2_mins || 120;
    const L3_AFTER = t.wait_l3_mins || S.remind_l3_mins || 240;
    const sinceRaised = businessMinutesBetween(t.raised_at, now, holidaySet);
    let newLevel = 0;
    if (sinceRaised >= L3_AFTER && t.l3_emp_id) newLevel = 3;
    else if (sinceRaised >= L2_AFTER) newLevel = 2;
    if (newLevel === 0) continue;

    const recipients = newLevel === 3
      ? [{ name: t.l1_name, phone: t.l1_phone }, { name: t.l2_name, phone: t.l2_phone }, { name: t.l3_name, phone: t.l3_phone }]
      : [{ name: t.l1_name, phone: t.l1_phone }, { name: t.l2_name, phone: t.l2_phone }];

    // Send if we just crossed into a higher level, or the repeat interval has elapsed.
    const leveledUp = newLevel > (t.escalation_level || 0);
    const dueByCadence = !t.last_reminder_at || businessMinutesBetween(t.last_reminder_at, now, holidaySet) >= REPEAT;
    if (!leveledUp && !dueByCadence) continue;

    fired++;
    const label = elapsedLabel(sinceRaised);
    const tObj = { id: t.id, ref_no: t.ref_no, requester_name: t.requester_name,
      category_name: t.category_name, subject: t.subject };
    const named = [];
    for (const h of recipients) { if (h.phone) { await wati.notify.reminder(h, tObj, label); sent++; } if (h.name) named.push(h.name); }

    await q(`UPDATE tickets SET last_reminder_at=now(), escalation_level=$2,
             escalated_l2_at=CASE WHEN escalated_l2_at IS NULL THEN now() ELSE escalated_l2_at END,
             escalated_l3_at=CASE WHEN $2=3 AND escalated_l3_at IS NULL THEN now() ELSE escalated_l3_at END
             WHERE id=$1`, [t.id, newLevel]);
    await q(`INSERT INTO ticket_events(ticket_id,event,note) VALUES($1,'reminder',$2)`,
      [t.id, `${label} · notified ${named.join(', ')}`]);
  }

  res.json({ ok: true, scanned: tickets.length, fired, sent });
});

// ---- Daily report PDF (token-guarded so the WhatsApp link opens without login) ----
app.get('/api/report/daily.pdf', async (req, res) => {
  const token = process.env.REPORT_TOKEN;
  if (!token || req.query.key !== token) return res.status(401).send('unauthorized');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  let date = today, scope = null, subtitle = null;
  try {
    if (req.query.q) {
      // scoped per-employee link: q = "<YYYY-MM-DD>_<employeeId>"
      const [qd, empId] = String(req.query.q).split('_');
      if (/^\d{4}-\d{2}-\d{2}$/.test(qd)) date = qd;
      if (empId) {
        const s = (await q(`SELECT s.category_ids, s.trade_ids, e.name FROM report_subscriptions s JOIN employees e ON e.id=s.employee_id WHERE s.employee_id=$1`, [+empId])).rows[0];
        if (s) { scope = { categoryIds: s.category_ids, tradeIds: s.trade_ids }; subtitle = s.name; }
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) {
      date = req.query.date;
    }
    const { pdf } = await require('../lib/report').dailyReportPdf(date, scope, subtitle, { remark: !!scope });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="daily-report-${date}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error('report pdf', e); res.status(500).send('report error'); }
});

// ---- Cron: 6:30pm IST daily report — overall recipients + per-person subscribers ----
app.all('/api/cron/daily-report', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.key;
  if (secret && provided !== secret) return res.status(401).json({ error: 'unauthorized' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
    ? req.query.date : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  try {
    const r = await require('../lib/report').dispatchDailyReports(date);
    res.json({ ok: true, ...r });
  } catch (e) { console.error('cron daily-report', e); res.status(500).json({ error: 'dispatch failed' }); }
});

app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'Server error' });
});

module.exports = app;
