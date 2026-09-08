// Labour Payments module — HR posts OT + Shed-B shearing for daily-wage labour, per company
// (BSC / G2). Monthly cycle: draft -> pending_mgmt -> approved. On approval the report is
// emailed to that company's accounts inbox. Editable until final approval.
const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const wati = require('../lib/wati');
const graph = require('../lib/graph');
const { background } = require('../lib/bg');
const router = express.Router();
router.use(auth.requireAuth);

const LABOUR_CO = {
  BSC: { label: 'Bharat Steel (Chennai)', accounts: process.env.LABOUR_ACCT_BSC || 'accounts@bharatsteels.in' },
  G2:  { label: 'G2 Steel Services',       accounts: process.env.LABOUR_ACCT_G2  || 'g2@bharatsteels.in' },
};
const COMP = (c) => (LABOUR_CO[String(c || '').toUpperCase()] ? String(c || '').toUpperCase() : null);
const otAmount = (h) => Math.floor((parseFloat(h) || 0) * 2) * 50;   // Rs.50 / completed half hour
const shAmount = (d) => Math.round((parseFloat(d) || 0) * 50);       // Rs.50 / day
const monthName = (p) => { const [y, m] = String(p).split('-'); return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }); };
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const isValidMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));

async function isLabourHr(u) {
  if (u.is_admin) return true;
  const r = (await q(`SELECT 1 FROM app_settings WHERE key='ot_hr_emp_id' AND value=$1`, [String(u.id)])).rows[0];
  return !!r;
}
async function isLabourMgmt(u) {
  if (u.is_admin) return true;
  const ids = ((await q(`SELECT value FROM app_settings WHERE key='ot_mgmt_emp_ids'`)).rows[0]?.value || '').split(',').map(Number);
  return ids.includes(u.id);
}
async function mgmtRecipients() {
  const ids = ((await q(`SELECT value FROM app_settings WHERE key='ot_mgmt_emp_ids'`)).rows[0]?.value || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return [];
  return (await q(`SELECT id,name,phone FROM employees WHERE id = ANY($1) AND active=TRUE`, [ids])).rows;
}

async function periodRow(company, period) {
  await q(`INSERT INTO labour_period(company,period) VALUES($1,$2) ON CONFLICT (company,period) DO NOTHING`, [company, period]);
  return (await q(`SELECT * FROM labour_period WHERE company=$1 AND period=$2`, [company, period])).rows[0];
}
async function refreshTotals(company, period) {
  const ot = +(await q(`SELECT COALESCE(SUM(amount),0) t FROM labour_ot WHERE company=$1 AND period=$2`, [company, period])).rows[0].t;
  const sh = +(await q(`SELECT COALESCE(SUM(amount),0) t FROM labour_shearing WHERE company=$1 AND period=$2`, [company, period])).rows[0].t;
  await q(`UPDATE labour_period SET ot_total=$3, shearing_total=$4, updated_at=now() WHERE company=$1 AND period=$2`, [company, period, ot, sh]);
  return { ot, sh };
}
// Entries can be added/edited/removed only while the month is not yet management-approved.
async function assertEditable(company, period, res) {
  const p = await periodRow(company, period);
  if (p.status === 'approved') { res.status(409).json({ error: 'This month is already management-approved and locked. Ask management to return it if changes are needed.' }); return false; }
  return true;
}

// ---------- overview ----------
router.get('/overview', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const company = COMP(req.query.company); if (!company) return res.status(400).json({ error: 'Bad company' });
  const month = isValidMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  const p = await periodRow(company, month);
  const ot = (await q(`SELECT id,labour_name,to_char(ot_date,'YYYY-MM-DD') AS ot_date,hours,amount FROM labour_ot WHERE company=$1 AND period=$2 ORDER BY labour_name,ot_date`, [company, month])).rows;
  const shearing = (await q(`SELECT id,labour_name,days,amount FROM labour_shearing WHERE company=$1 AND period=$2 ORDER BY labour_name`, [company, month])).rows;
  const otNames = (await q(`SELECT DISTINCT labour_name FROM labour_ot WHERE company=$1 ORDER BY labour_name`, [company])).rows.map(r => r.labour_name);
  const shNames = (await q(`SELECT DISTINCT labour_name FROM labour_shearing WHERE company=$1 ORDER BY labour_name`, [company])).rows.map(r => r.labour_name);
  const ot_total = ot.reduce((s, r) => s + r.amount, 0), shearing_total = shearing.reduce((s, r) => s + r.amount, 0);
  res.json({
    company, company_label: LABOUR_CO[company].label, month, status: p.status,
    submitted_by: p.submitted_by_name, mgmt_by: p.mgmt_by_name, accounts_sent_at: p.accounts_sent_at,
    accounts_email: LABOUR_CO[company].accounts,
    locked: p.status === 'approved', can_approve: await isLabourMgmt(req.user),
    ot, shearing, ot_total, shearing_total, grand_total: ot_total + shearing_total, ot_names: otNames, sh_names: shNames,
  });
});

// ---------- OT entries ----------
router.post('/ot/bulk', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const company = COMP(req.body.company); if (!company) return res.status(400).json({ error: 'Bad company' });
  const month = isValidMonth(req.body.month) ? req.body.month : new Date().toISOString().slice(0, 7);
  if (!(await assertEditable(company, month, res))) return;
  const clean = [];
  for (const e of (req.body.entries || [])) {
    const name = String(e.labour_name || '').trim(), hours = parseFloat(e.hours);
    if (!name) continue;
    if (!(hours > 0)) return res.status(400).json({ error: `Enter hours for ${name}` });
    clean.push({ name, hours: +hours.toFixed(2), amount: otAmount(hours) });
  }
  if (!clean.length) return res.status(400).json({ error: 'Add at least one row with name and hours.' });
  const otDate = month + '-01';   // date isn't tracked per row; month is the unit
  let total = 0;
  for (const c of clean) {
    total += c.amount;
    await q(`INSERT INTO labour_ot(company,labour_name,ot_date,period,hours,amount,entered_by_id,entered_by_name)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [company, c.name, otDate, month, c.hours, c.amount, req.user.id, req.user.name]);
  }
  await refreshTotals(company, month);
  res.json({ ok: true, count: clean.length, total });
});
router.put('/ot/:id', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const row = (await q(`SELECT * FROM labour_ot WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.labour_name || '').trim(), hours = parseFloat(req.body.hours);
  if (!name || !(hours > 0)) return res.status(400).json({ error: 'Name and hours are required.' });
  if (!(await assertEditable(row.company, row.period, res))) return;
  await q(`UPDATE labour_ot SET labour_name=$2,hours=$3,amount=$4,updated_at=now() WHERE id=$1`,
    [row.id, name, +hours.toFixed(2), otAmount(hours)]);
  await refreshTotals(row.company, row.period);
  res.json({ ok: true });
});
router.delete('/ot/:id', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const row = (await q(`SELECT * FROM labour_ot WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!(await assertEditable(row.company, row.period, res))) return;
  await q(`DELETE FROM labour_ot WHERE id=$1`, [req.params.id]);
  await refreshTotals(row.company, row.period);
  res.json({ ok: true });
});

// ---------- Shearing entries (one row per labour per month) ----------
router.post('/shearing/bulk', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const company = COMP(req.body.company); if (!company) return res.status(400).json({ error: 'Bad company' });
  const month = isValidMonth(req.body.month) ? req.body.month : new Date().toISOString().slice(0, 7);
  if (!(await assertEditable(company, month, res))) return;
  const clean = [];
  for (const e of (req.body.entries || [])) {
    const name = String(e.labour_name || '').trim(), days = parseFloat(e.days);
    if (!name) continue;
    if (!(days > 0)) return res.status(400).json({ error: `Enter days for ${name}` });
    clean.push({ name, days: +days.toFixed(1), amount: shAmount(days) });
  }
  if (!clean.length) return res.status(400).json({ error: 'Add at least one row with name and days.' });
  let total = 0;
  for (const c of clean) {
    total += c.amount;
    await q(`INSERT INTO labour_shearing(company,labour_name,days,amount,period,entered_by_id,entered_by_name)
             VALUES($1,$2,$3,$4,$5,$6,$7)`, [company, c.name, c.days, c.amount, month, req.user.id, req.user.name]);
  }
  await refreshTotals(company, month);
  res.json({ ok: true, count: clean.length, total });
});
router.put('/shearing/:id', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const row = (await q(`SELECT * FROM labour_shearing WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.labour_name || '').trim(), days = parseFloat(req.body.days);
  if (!name || !(days > 0)) return res.status(400).json({ error: 'Name and days are required.' });
  if (!(await assertEditable(row.company, row.period, res))) return;
  await q(`UPDATE labour_shearing SET labour_name=$2,days=$3,amount=$4,updated_at=now() WHERE id=$1`, [row.id, name, +days.toFixed(1), shAmount(days)]);
  await refreshTotals(row.company, row.period);
  res.json({ ok: true });
});
router.delete('/shearing/:id', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const row = (await q(`SELECT * FROM labour_shearing WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!(await assertEditable(row.company, row.period, res))) return;
  await q(`DELETE FROM labour_shearing WHERE id=$1`, [req.params.id]);
  await refreshTotals(row.company, row.period);
  res.json({ ok: true });
});

// ---------- submit for final approval ----------
router.post('/submit', async (req, res) => {
  if (!(await isLabourHr(req.user))) return res.status(403).json({ error: 'HR / admin only.' });
  const company = COMP(req.body.company); if (!company) return res.status(400).json({ error: 'Bad company' });
  const month = isValidMonth(req.body.month) ? req.body.month : new Date().toISOString().slice(0, 7);
  const p = await periodRow(company, month);
  if (p.status === 'approved') return res.status(409).json({ error: 'Already approved.' });
  const { ot, sh } = await refreshTotals(company, month);
  if (ot + sh <= 0) return res.status(400).json({ error: 'Nothing to submit — add some entries first.' });
  await q(`UPDATE labour_period SET status='pending_mgmt', submitted_at=now(), submitted_by_name=$3, updated_at=now() WHERE company=$1 AND period=$2`, [company, month, req.user.name]);
  res.json({ ok: true, status: 'pending_mgmt', ot_total: ot, shearing_total: sh, grand_total: ot + sh });
  // Management sees it in their in-app "Pending approvals" list. (A WhatsApp/email nudge can be
  // added later once a template is registered.)
});

// ---------- management: pending list + approve + return ----------
router.get('/pending', async (req, res) => {
  if (!(await isLabourMgmt(req.user))) return res.status(403).json({ error: 'Management / admin only.' });
  const rows = (await q(`SELECT company,period,ot_total,shearing_total,submitted_at,submitted_by_name FROM labour_period WHERE status='pending_mgmt' ORDER BY submitted_at`)).rows;
  res.json(rows.map(r => ({ ...r, company_label: LABOUR_CO[r.company]?.label || r.company, month_label: monthName(r.period), grand_total: r.ot_total + r.shearing_total })));
});
router.post('/approve', async (req, res) => {
  if (!(await isLabourMgmt(req.user))) return res.status(403).json({ error: 'Management / admin only.' });
  const company = COMP(req.body.company); if (!company) return res.status(400).json({ error: 'Bad company' });
  const month = isValidMonth(req.body.month) ? req.body.month : '';
  const p = (await q(`SELECT * FROM labour_period WHERE company=$1 AND period=$2`, [company, month])).rows[0];
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status !== 'pending_mgmt') return res.status(409).json({ error: `Can't approve — it is ${p.status}.` });
  const { ot, sh } = await refreshTotals(company, month);
  await q(`UPDATE labour_period SET status='approved', mgmt_at=now(), mgmt_by_name=$3, updated_at=now() WHERE company=$1 AND period=$2`, [company, month, req.user.name]);
  res.json({ ok: true, status: 'approved' });
  background((async () => {
    try {
      const html = await buildReportHtml(company, month);
      const acct = LABOUR_CO[company].accounts;
      const ok = await graph.sendMail({
        to: acct,
        subject: `Labour payments — ${LABOUR_CO[company].label} — ${monthName(month)} — ${money(ot + sh)}`,
        html,
      });
      if (ok) await q(`UPDATE labour_period SET accounts_sent_at=now() WHERE company=$1 AND period=$2`, [company, month]);
    } catch (e) { console.error('[labour accounts email]', e.message); }
  })());
});
router.post('/return', async (req, res) => {
  if (!(await isLabourMgmt(req.user))) return res.status(403).json({ error: 'Management / admin only.' });
  const company = COMP(req.body.company); if (!company) return res.status(400).json({ error: 'Bad company' });
  const month = isValidMonth(req.body.month) ? req.body.month : '';
  const p = (await q(`SELECT status FROM labour_period WHERE company=$1 AND period=$2`, [company, month])).rows[0];
  if (!p || p.status !== 'pending_mgmt') return res.status(409).json({ error: 'Only a pending month can be returned.' });
  await q(`UPDATE labour_period SET status='draft', submitted_at=NULL, submitted_by_name=NULL, updated_at=now() WHERE company=$1 AND period=$2`, [company, month]);
  res.json({ ok: true, status: 'draft' });
});

// ---------- report (HTML, used for the accounts email + on-screen/print) ----------
async function buildReportHtml(company, month) {
  const co = LABOUR_CO[company];
  const ot = (await q(`SELECT labour_name,hours,amount FROM labour_ot WHERE company=$1 AND period=$2 ORDER BY labour_name`, [company, month])).rows;
  const sh = (await q(`SELECT labour_name,days,amount FROM labour_shearing WHERE company=$1 AND period=$2 ORDER BY labour_name`, [company, month])).rows;
  const otT = ot.reduce((s, r) => s + r.amount, 0), shT = sh.reduce((s, r) => s + r.amount, 0);
  const th = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #0A4566;font-size:12px;text-transform:uppercase;color:#0A4566"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px"';
  const otRows = ot.map(r => `<tr><td ${td}>${r.labour_name}</td><td ${td}>${(+r.hours).toFixed(2)}</td><td ${td} align="right">${money(r.amount)}</td></tr>`).join('') || `<tr><td ${td} colspan="3">No OT entries.</td></tr>`;
  const shRows = sh.map(r => `<tr><td ${td}>${r.labour_name}</td><td ${td}>${(+r.days).toFixed(1)}</td><td ${td} align="right">${money(r.amount)}</td></tr>`).join('') || `<tr><td ${td} colspan="3">No shearing entries.</td></tr>`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#111;max-width:640px">
    <h2 style="color:#0A4566;margin:0 0 2px">Labour Payments — ${co.label}</h2>
    <div style="color:#555;margin-bottom:16px">${monthName(month)} · management-approved</div>
    <h3 style="margin:14px 0 4px">Overtime <span style="color:#0A4566">(${money(otT)})</span></h3>
    <table style="border-collapse:collapse;width:100%"><tr><th ${th}>Name</th><th ${th}>Hours</th><th ${th} align="right">Amount</th></tr>${otRows}</table>
    <h3 style="margin:18px 0 4px">Shed B — Shearing <span style="color:#0A4566">(${money(shT)})</span></h3>
    <table style="border-collapse:collapse;width:100%"><tr><th ${th}>Name</th><th ${th}>Days</th><th ${th} align="right">Amount</th></tr>${shRows}</table>
    <div style="margin-top:18px;padding:12px;background:#f1f5f9;border-radius:8px;font-size:16px"><b>Grand total: ${money(otT + shT)}</b></div>
    <p style="color:#94a3b8;font-size:11px;margin-top:16px">Overtime is paid at ₹50 per half hour; Shed-B shearing at ₹50 per day. Generated by the Bharat Steel Group portal.</p>
  </div>`;
}
router.get('/report/:company/:month', async (req, res) => {
  if (!(await isLabourHr(req.user) || await isLabourMgmt(req.user))) return res.status(403).send('Not allowed');
  const company = COMP(req.params.company); if (!company || !isValidMonth(req.params.month)) return res.status(400).send('Bad request');
  res.send(await buildReportHtml(company, req.params.month));
});

module.exports = router;
