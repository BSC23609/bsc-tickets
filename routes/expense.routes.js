// Expense Reimbursement — module routes.
// Phase 1: Local Travel Conveyance (monthly draft → month-gated submit → 1-page
// PDF → OneDrive + HR email → portal approval). Outstation & Miscellaneous next.
const express = require('express');
const crypto = require('crypto');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const graph = require('../lib/graph');
const { background } = require('../lib/bg');
const { getPolicy, catOf } = require('../lib/expense_policy');
const { buildConveyancePDF } = require('../lib/expense_pdf');
const wati = require('../lib/wati');
const chain = require('../lib/chain');

const FORM_LABEL = { conveyance: 'Local Conveyance', outstation: 'Outstation Travel', misc: 'Miscellaneous' };
const STAGE_LABEL = { hr: 'HR review', final: 'final approval' };

async function empById(id) { if (!id) return null; return (await q('SELECT id,name,phone,emp_no,email FROM employees WHERE id=$1', [id])).rows[0] || null; }
async function isHrApprover(u) { if (u.is_admin) return true; const c = await chain.getChain(); return c.hr_approver_ids.includes(u.id); }
function chainSummary(full) { return { id: full.id, ref_no: full.ref_no, emp_name: full.emp_name, form_label: FORM_LABEL[full.form_type] || full.form_type, period_label: full.period ? monthLabel(full.period) : '\u2014', total_label: fmtMoney(full.total_amount) }; }
function chainPdfName(full) { const lbl = FORM_LABEL[full.form_type] || full.form_type; const per = full.period ? (' ' + monthLabel(full.period)) : ''; return `${full.emp_name} - ${lbl}${per} (${full.ref_no.replace(/\//g, '-')}).pdf`; }
async function pdfFor(full, status, approver, at) {
  if (full.form_type === 'conveyance') return conveyancePdf(full, status, approver, at);
  if (full.form_type === 'outstation') return outstationPdf(full, status, approver, at);
  return miscPdf(full, status, approver, at);
}
async function uploadChainPdf(full, status, approver, at) {
  const pdf = await pdfFor(full, status, approver, at);
  const url = await graph.uploadExpensePdf(chainPdfName(full), pdf);
  if (url && url !== true) await q(`UPDATE expense_submissions SET pdf_url=$2 WHERE id=$1`, [full.id, url]);
  return pdf;
}
// Move a submission to the HR stage and notify the configured HR approvers.
async function enterChain(rowId) {
  await q(`UPDATE expense_submissions SET status='pending_hr', submitted_at=now(),
    pdf_token=COALESCE(pdf_token,$2),
    hr_by_id=NULL, hr_by_name=NULL, hr_at=NULL, final_approver_id=NULL, final_by_name=NULL, final_at=NULL,
    return_reason=NULL, return_stage=NULL WHERE id=$1`, [rowId, crypto.randomBytes(12).toString('hex')]);
  background((async () => {
    const c = await chain.getChain();
    const full = await loadRow(rowId);
    await uploadChainPdf(full, 'pending');
    for (const hid of c.hr_approver_ids) { const hr = await empById(hid); if (hr && hr.phone) await wati.notify.expense.submitted(hr, chainSummary(full)); }
  })());
}
async function returnToEmployee(row, stage, reason, byName) {
  await q(`UPDATE expense_submissions SET status='returned', return_reason=$2, return_stage=$3, reviewed_by_name=$4, reviewed_at=now() WHERE id=$1`,
    [row.id, reason, stage, byName]);
  background((async () => {
    const full = await loadRow(row.id);
    const emp = await empById(full.employee_id);
    if (emp && emp.phone) await wati.notify.expense.returned(emp, { ...chainSummary(full), stage_label: STAGE_LABEL[stage] || stage, reason });
  })());
}

const router = express.Router();
router.use(auth.requireAuth);
function requireHR(req, res, next) { if (!req.user.is_admin) return res.status(403).json({ error: 'HR only' }); next(); }

const HR_EMAIL = process.env.EXPENSE_HR_EMAIL || 'hr@bharatsteels.in';
const catLabel = (c) => (c === 'CAT1' ? 'Category 1' : 'Category 2');
const monthLabel = (period) => { const [y, m] = period.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }); };
const fmtMoney = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDateTime = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// Submit unlocks on the 1st of the month AFTER the claim's period.
function canSubmit(period) { if (!period) return false; const [y, m] = period.split('-').map(Number); return new Date() >= new Date(y, m, 1); }
// Admins can lift the month-end submit lock per form (handy for testing).
async function submitAllowed(formType, period) {
  let g = {};
  try { const r = await q(`SELECT value FROM app_settings WHERE key='expense_gate'`); if (r.rows[0]) g = JSON.parse(r.rows[0].value); } catch {}
  if (formType === 'conveyance' && g.conveyance_anytime) return true;
  if (formType === 'outstation' && g.outstation_anytime) return true;
  return canSubmit(period);
}

async function refNo(prefix) {
  const now = new Date();
  const dp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const { rows } = await q(`SELECT COUNT(*)::int n FROM expense_submissions WHERE ref_no LIKE $1`, [`EXP/BSC/${prefix}/${dp}/%`]);
  return `EXP/BSC/${prefix}/${dp}/${String(rows[0].n + 1).padStart(3, '0')}`;
}

async function loadRow(id) {
  return (await q(`SELECT s.*, e.name AS emp_name, e.emp_no AS emp_code, e.job_title AS designation,
    e.expense_category, e.email AS emp_email FROM expense_submissions s
    JOIN employees e ON e.id = s.employee_id WHERE s.id = $1`, [id])).rows[0];
}
// An entry is "late" if it was first logged more than `hours` after its trip date (IST).
function entryIsLate(dateStr, loggedAt, hours) {
  if (!dateStr || !loggedAt || !hours) return false;
  const trip = new Date(dateStr + 'T00:00:00+05:30').getTime();
  return (new Date(loggedAt).getTime() - trip) > hours * 3600000;
}
async function conveyancePdf(row, status, approver, approvedAt) {
  const pol = await getPolicy();
  const cat = row.expense_category === 'CAT1' ? 'CAT1' : 'CAT2';
  const hours = pol.log_hours;
  const entries = ((row.payload && row.payload.entries) || []).map(e => ({ ...e, late: entryIsLate(e.date, e.logged_at, hours) }));
  return buildConveyancePDF({
    ref_no: row.ref_no, emp_name: row.emp_name, emp_code: row.emp_code, designation: row.designation || '',
    category: catLabel(cat), period_label: monthLabel(row.period), vehicle_rates: pol.rates,
    entries, total: Number(row.total_amount || 0), log_hours: hours,
    status, approver, approved_at: approvedAt,
  });
}
function emailHtml(title, row, count) {
  return `<div style="font-family:Arial,sans-serif;color:#112532">
    <h2 style="margin:0 0 4px">${title}</h2>
    <p style="color:#6b7c8c;margin:0 0 16px">A new claim has been submitted for your approval on the BSC portal.</p>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:4px 16px 4px 0;color:#6b7c8c">Employee</td><td><b>${row.emp_name}</b> (${row.emp_code})</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#6b7c8c">Reference</td><td>${row.ref_no}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#6b7c8c">Period</td><td>${row.period ? monthLabel(row.period) : '\u2014'}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#6b7c8c">Entries</td><td>${count}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#6b7c8c">Total</td><td><b>${fmtMoney(row.total_amount)}</b></td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#6b7c8c">The full claim PDF is attached. Approve or reject it on the portal.</p>
  </div>`;
}

// ---------------- meta ----------------
router.get('/meta', async (req, res) => {
  const pol = await getPolicy();
  const cat = catOf(req.user);
  const mgr = await resolveManager(req.user.id);
  const c = await chain.getChain();
  res.json({ rates: pol.rates, limits: pol.limits, category: cat, category_label: catLabel(cat),
    reporting_manager: mgr ? mgr.name : null, conveyance_log_hours: pol.log_hours,
    is_hr_approver: req.user.is_admin || c.hr_approver_ids.includes(req.user.id),
    is_final_approver: req.user.is_admin || c.final_approver_ids.includes(req.user.id),
    me: { emp_no: req.user.emp_no, name: req.user.name, designation: req.user.job_title || '' }, hr_email: HR_EMAIL });
});

// Resolve an employee's active reporting manager (or null).
async function resolveManager(empId) {
  return (await q(`SELECT rm.id, rm.name, rm.phone, rm.emp_no FROM employees e
    JOIN employees rm ON rm.id = e.reporting_manager_emp_id
    WHERE e.id = $1 AND rm.active = TRUE`, [empId])).rows[0] || null;
}
const tripDateLabel = (s) => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const tripRoute = (t) => [t.from_loc, t.to_loc].filter(Boolean).join(' \u2192 ') || (t.purpose || 'Trip');
function sendTripToManager(trip, mgr, requester) {
  background((async () => {
    if (!mgr || !mgr.phone) return;
    await wati.notify.conveyance.request(mgr, {
      requester, date_label: tripDateLabel(trip.trip_date), route: tripRoute(trip),
      amount_label: fmtMoney(trip.amount), action_token: trip.action_token });
  })());
}
const TRIP_COLS = `id, employee_id, to_char(trip_date,'YYYY-MM-DD') AS trip_date, from_loc, to_loc, purpose,
  vehicle, km, rate, amount, status, approver_name, reject_reason, reviewed_at, action_token, logged_at`;

// Get-or-create the month container + the month's trips.
router.get('/conveyance/:period', async (req, res) => {
  const period = req.params.period;
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Bad period' });
  let row = (await q(`SELECT * FROM expense_submissions WHERE employee_id=$1 AND form_type='conveyance' AND period=$2 ORDER BY id DESC LIMIT 1`, [req.user.id, period])).rows[0];
  if (!row) {
    const ref = await refNo('CNV');
    row = (await q(`INSERT INTO expense_submissions(ref_no,employee_id,form_type,period,payload,status)
      VALUES($1,$2,'conveyance',$3,$4,'draft') RETURNING *`, [ref, req.user.id, period, JSON.stringify({ entries: [] })])).rows[0];
  }
  const pol = await getPolicy();
  const trips = (await q(`SELECT ${TRIP_COLS} FROM conveyance_trips WHERE employee_id=$1 AND period=$2 ORDER BY trip_date, id`, [req.user.id, period])).rows
    .map(t => ({ ...t, late: entryIsLate(t.trip_date, t.logged_at, pol.log_hours) }));
  const mgr = await resolveManager(req.user.id);
  const allow = await submitAllowed('conveyance', period);
  res.json({
    period, period_label: monthLabel(period),
    can_submit: ['draft', 'returned'].includes(row.status) && allow,
    submission: { id: row.id, ref_no: row.ref_no, status: row.status, total_amount: row.total_amount,
      pdf_token: row.pdf_token, return_reason: row.return_reason, return_stage: row.return_stage },
    manager: mgr ? { name: mgr.name } : null,
    log_hours: pol.log_hours,
    pending_count: trips.filter(t => t.status === 'pending').length,
    trips,
  });
});

// Add one trip → send to the reporting manager immediately.
router.post('/conveyance/:period/trip', async (req, res) => {
  const period = req.params.period;
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Bad period' });
  const b = req.body || {};
  const km = parseFloat(b.km); const veh = b.vehicle === 'car' ? 'car' : 'bike';
  if (!b.date) return res.status(400).json({ error: 'Pick the trip date.' });
  if (!(km > 0)) return res.status(400).json({ error: 'Enter the distance in km.' });
  const mgr = await resolveManager(req.user.id);
  if (!mgr) return res.status(400).json({ error: 'No reporting manager assigned. Ask an admin to set yours in the employee directory.' });
  const pol = await getPolicy();
  const rate = pol.rates[veh]; const amount = +(km * rate).toFixed(2);
  const token = crypto.randomBytes(20).toString('hex');
  const trip = (await q(`INSERT INTO conveyance_trips
    (employee_id,period,trip_date,from_loc,to_loc,purpose,vehicle,km,rate,amount,status,approver_emp_id,approver_name,action_token)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13)
    RETURNING ${TRIP_COLS}`,
    [req.user.id, period, b.date, (b.from || '').trim(), (b.to || '').trim(), (b.purpose || '').trim(),
     veh, km, rate, amount, mgr.id, mgr.name, token])).rows[0];
  sendTripToManager(trip, mgr, req.user.name);
  res.json({ ok: true, trip, approver: mgr.name, notified: Boolean(mgr.phone) });
});

// Edit a rejected trip and re-send it (pending/approved trips are locked).
router.put('/conveyance/trip/:id', async (req, res) => {
  const t = (await q('SELECT * FROM conveyance_trips WHERE id=$1', [req.params.id])).rows[0];
  if (!t || t.employee_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (t.status !== 'rejected') return res.status(409).json({ error: 'Only rejected trips can be edited.' });
  const b = req.body || {};
  const km = parseFloat(b.km); const veh = b.vehicle === 'car' ? 'car' : 'bike';
  if (!b.date || !(km > 0)) return res.status(400).json({ error: 'Date and km are required.' });
  const mgr = await resolveManager(req.user.id);
  if (!mgr) return res.status(400).json({ error: 'No reporting manager assigned.' });
  const pol = await getPolicy();
  const rate = pol.rates[veh]; const amount = +(km * rate).toFixed(2);
  const token = crypto.randomBytes(20).toString('hex');
  const trip = (await q(`UPDATE conveyance_trips SET trip_date=$2,from_loc=$3,to_loc=$4,purpose=$5,vehicle=$6,
    km=$7,rate=$8,amount=$9,status='pending',approver_emp_id=$10,approver_name=$11,reviewed_at=NULL,
    reject_reason=NULL,action_token=$12,updated_at=now() WHERE id=$1 RETURNING ${TRIP_COLS}`,
    [t.id, b.date, (b.from || '').trim(), (b.to || '').trim(), (b.purpose || '').trim(), veh, km, rate, amount,
     mgr.id, mgr.name, token])).rows[0];
  sendTripToManager(trip, mgr, req.user.name);
  res.json({ ok: true, trip, notified: Boolean(mgr.phone) });
});

// Withdraw a trip (pending or rejected; approved trips can't be removed).
router.delete('/conveyance/trip/:id', async (req, res) => {
  const t = (await q('SELECT * FROM conveyance_trips WHERE id=$1', [req.params.id])).rows[0];
  if (!t || t.employee_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (t.status === 'approved') return res.status(409).json({ error: 'Approved trips cannot be withdrawn.' });
  await q('DELETE FROM conveyance_trips WHERE id=$1', [t.id]);
  res.json({ ok: true });
});

// Submit the month into the HR payment chain (snapshots ALL the month's trips).
router.post('/conveyance/:period/submit', async (req, res) => {
  const period = req.params.period;
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Bad period' });
  if (!(await submitAllowed('conveyance', period))) return res.status(400).json({ error: 'This month can be submitted from the 1st of next month.' });
  let row = (await q(`SELECT * FROM expense_submissions WHERE employee_id=$1 AND form_type='conveyance' AND period=$2 ORDER BY id DESC LIMIT 1`, [req.user.id, period])).rows[0];
  if (!row) return res.status(404).json({ error: 'Nothing to submit.' });
  if (!['draft', 'returned'].includes(row.status)) return res.status(409).json({ error: 'Already submitted.' });
  const trips = (await q(`SELECT ${TRIP_COLS} FROM conveyance_trips WHERE employee_id=$1 AND period=$2 ORDER BY trip_date, id`, [req.user.id, period])).rows;
  if (!trips.length) return res.status(400).json({ error: 'Add at least one trip before submitting.' });
  let total = 0;
  const entries = trips.map(t => {
    total += Number(t.amount || 0);
    return { date: t.trip_date, from: t.from_loc || '', to: t.to_loc || '', purpose: t.purpose || '',
      vehicle: t.vehicle, vehicle_label: t.vehicle === 'car' ? 'Car' : 'Bike', km: Number(t.km), rate: Number(t.rate),
      amount: Number(t.amount), logged_at: t.logged_at, mgr_status: t.status, mgr_reason: t.reject_reason || '',
      approver: t.approver_name || '' };
  });
  await q(`UPDATE expense_submissions SET payload=$2, total_amount=$3, updated_at=now() WHERE id=$1`,
    [row.id, JSON.stringify({ entries }), +total.toFixed(2)]);
  await enterChain(row.id);
  res.json({ ok: true, pending_count: trips.filter(t => t.status === 'pending').length });
});

// One-tap helpers (used by the public /cva /cvr endpoints) — operate on a single trip.
async function loadTripByToken(token) {
  return (await q(`SELECT t.*, to_char(t.trip_date,'YYYY-MM-DD') AS trip_date_s,
    e.name AS emp_name, e.phone AS emp_phone
    FROM conveyance_trips t JOIN employees e ON e.id = t.employee_id
    WHERE t.action_token = $1`, [token])).rows[0] || null;
}
async function applyTripApprove(t) {
  await q(`UPDATE conveyance_trips SET status='approved', reviewed_at=now(), action_token=NULL WHERE id=$1`, [t.id]);
  background((async () => {
    if (t.emp_phone) await wati.notify.conveyance.approved({ name: t.emp_name, phone: t.emp_phone },
      { date_label: tripDateLabel(t.trip_date_s), route: tripRoute(t), approver_name: t.approver_name || 'your manager' });
  })());
}
async function applyTripReject(t, reason) {
  await q(`UPDATE conveyance_trips SET status='rejected', reject_reason=$2, reviewed_at=now(), action_token=NULL WHERE id=$1`, [t.id, reason || null]);
  background((async () => {
    if (t.emp_phone) await wati.notify.conveyance.rejected({ name: t.emp_name, phone: t.emp_phone },
      { date_label: tripDateLabel(t.trip_date_s), route: tripRoute(t), approver_name: t.approver_name || 'your manager', reason: reason || '' });
  })());
}


// ---------------- my submissions (non-draft) ----------------
router.get('/', async (req, res) => {
  const rows = (await q(`SELECT id,ref_no,form_type,period,total_amount,status,submitted_at,created_at,pdf_token
    FROM expense_submissions WHERE employee_id=$1 AND status<>'draft'
    ORDER BY COALESCE(submitted_at,created_at) DESC LIMIT 100`, [req.user.id])).rows;
  res.json(rows.map(r => ({ ...r, period_label: r.period ? monthLabel(r.period) : '' })));
});

// ---------------- HR queue (stage 1) ----------------
router.get('/approvals', async (req, res) => {
  if (!(await isHrApprover(req.user))) return res.status(403).json({ error: 'HR only' });
  const rows = (await q(`SELECT s.id,s.ref_no,s.form_type,s.period,s.total_amount,s.status,s.submitted_at,
    e.name AS emp_name, e.emp_no AS emp_code FROM expense_submissions s
    JOIN employees e ON e.id=s.employee_id WHERE s.status='pending_hr' ORDER BY s.submitted_at DESC LIMIT 200`)).rows;
  res.json(rows.map(r => ({ ...r, period_label: r.period ? monthLabel(r.period) : '' })));
});
// ---------------- Final-approver queue (stage 2) ----------------
router.get('/final-approvals', async (req, res) => {
  const rows = (await q(`SELECT s.id,s.ref_no,s.form_type,s.period,s.total_amount,s.status,s.submitted_at,s.hr_by_name,
    e.name AS emp_name, e.emp_no AS emp_code FROM expense_submissions s
    JOIN employees e ON e.id=s.employee_id
    WHERE s.status='pending_final' AND ($1 OR s.final_approver_id=$2) ORDER BY s.submitted_at DESC LIMIT 200`,
    [req.user.is_admin, req.user.id])).rows;
  res.json(rows.map(r => ({ ...r, period_label: r.period ? monthLabel(r.period) : '' })));
});
// Final approvers HR can route to (for the approve dropdown).
router.get('/chain-approvers', async (req, res) => {
  if (!(await isHrApprover(req.user))) return res.status(403).json({ error: 'HR only' });
  const c = await chain.getChain();
  if (!c.final_approver_ids.length) return res.json([]);
  res.json((await q(`SELECT id,name,emp_no FROM employees WHERE id = ANY($1) AND active=TRUE ORDER BY name`, [c.final_approver_ids])).rows);
});

// ---------------- detail (owner / HR / final approver) ----------------
router.get('/:id', async (req, res) => {
  const row = await loadRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const owner = row.employee_id === req.user.id;
  const hr = await isHrApprover(req.user);
  if (!owner && !hr && row.final_approver_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  res.json({ ...row, period_label: row.period ? monthLabel(row.period) : '',
    category_label: catLabel(row.expense_category === 'CAT1' ? 'CAT1' : 'CAT2'),
    perms: {
      is_owner: owner,
      can_hr: row.status === 'pending_hr' && hr,
      can_final: row.status === 'pending_final' && (req.user.is_admin || row.final_approver_id === req.user.id),
      is_returned: row.status === 'returned' && owner,
    } });
});

// ---------------- chain actions ----------------
router.post('/:id/hr-approve', async (req, res) => {
  if (!(await isHrApprover(req.user))) return res.status(403).json({ error: 'HR only' });
  const finalId = Number((req.body && req.body.final_approver_id) || 0);
  const row = await loadRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'pending_hr') return res.status(409).json({ error: 'Not awaiting HR' });
  const c = await chain.getChain();
  if (!c.final_approver_ids.includes(finalId)) return res.status(400).json({ error: 'Pick a valid final approver' });
  await q(`UPDATE expense_submissions SET status='pending_final', hr_by_id=$2, hr_by_name=$3, hr_at=now(), final_approver_id=$4 WHERE id=$1`,
    [row.id, req.user.id, req.user.name, finalId]);
  res.json({ ok: true });
  background((async () => {
    const ap = await empById(finalId); const full = await loadRow(row.id);
    if (ap && ap.phone) await wati.notify.expense.finalReview(ap, chainSummary(full));
  })());
});
router.post('/:id/hr-return', async (req, res) => {
  if (!(await isHrApprover(req.user))) return res.status(403).json({ error: 'HR only' });
  const reason = ((req.body && req.body.reason) || '').trim();
  const row = await loadRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'pending_hr') return res.status(409).json({ error: 'Not awaiting HR' });
  if (!reason) return res.status(400).json({ error: 'Add a reason' });
  await returnToEmployee(row, 'hr', reason, req.user.name);
  res.json({ ok: true });
});
router.post('/:id/final-approve', async (req, res) => {
  const row = await loadRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'pending_final') return res.status(409).json({ error: 'Not awaiting final approval' });
  if (!(req.user.is_admin || row.final_approver_id === req.user.id)) return res.status(403).json({ error: 'Not the assigned approver' });
  await q(`UPDATE expense_submissions SET status='approved', final_by_name=$2, final_at=now() WHERE id=$1`, [row.id, req.user.name]);
  res.json({ ok: true });
  background((async () => {
    const c = await chain.getChain();
    const full = await loadRow(row.id);
    const pdf = await uploadChainPdf(full, 'approved', full.final_by_name || req.user.name, fmtDateTime(new Date()));
    if (c.accounts_email) await graph.sendMail({
      to: c.accounts_email,
      subject: `Approved expense — ${full.emp_name} — ${FORM_LABEL[full.form_type]} ${full.period ? monthLabel(full.period) : ''} — ${fmtMoney(full.total_amount)}`,
      html: emailHtml(`${FORM_LABEL[full.form_type]} — approved for payment`, full, ''),
      attachments: [{ name: chainPdfName(full), contentType: 'application/pdf', contentBytes: pdf.toString('base64') }],
    });
    if (c.accounts_notify_id) { const acc = await empById(c.accounts_notify_id); if (acc && acc.phone) await wati.notify.expense.paid(acc, chainSummary(full)); }
  })());
});
router.post('/:id/final-return', async (req, res) => {
  const reason = ((req.body && req.body.reason) || '').trim();
  const row = await loadRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'pending_final') return res.status(409).json({ error: 'Not awaiting final approval' });
  if (!(req.user.is_admin || row.final_approver_id === req.user.id)) return res.status(403).json({ error: 'Not the assigned approver' });
  if (!reason) return res.status(400).json({ error: 'Add a reason' });
  await returnToEmployee(row, 'final', reason, req.user.name);
  res.json({ ok: true });
});

// ===================== OUTSTATION & MISC shared =====================
const { buildOutstationSummary, buildMiscSummary, mergeBills } = require('../lib/expense_pdf');
const CAT_LABEL = { accommodation: 'Accommodation', food: 'Food', conveyance: 'Conveyance', others: 'Others' };
const guessMime = (name) => { const e = (name || '').toLowerCase().split('.').pop();
  return e === 'png' ? 'image/png' : e === 'pdf' ? 'application/pdf' : (e === 'jpg' || e === 'jpeg') ? 'image/jpeg' : 'application/octet-stream'; };
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
function flagsHtml(flags) {
  if (!flags || !flags.length) return '';
  return `<div style="margin-top:14px"><b style="color:#b45309">Flagged (over daily limit):</b><ul style="margin:6px 0;color:#92400e;font-size:13px">${flags.map(f => `<li>${f}</li>`).join('')}</ul></div>`;
}

// Compute totals + per-day food/accom over-limit flags for an outstation claim.
function computeOutstation(body, limits) {
  let total = 0; const flags = [];
  const trips = (body.trips || []).map(trip => {
    const items = (trip.items || []).map(it => {
      const amount = Math.max(0, parseFloat(it.amount) || 0); total += amount;
      const category = ['accommodation', 'food', 'conveyance', 'others'].includes(it.category) ? it.category : 'others';
      return { category, date: it.date || '', desc: (it.desc || '').trim(), amount,
        bill: it.bill || null, bill_name: (it.bill && it.bill.name) || null, flag: false };
    });
    for (const key of ['food', 'accommodation']) {
      const lim = key === 'food' ? limits.food : limits.accom;
      const byDate = {};
      items.forEach(it => { if (it.category === key) (byDate[it.date] = byDate[it.date] || []).push(it); });
      for (const [date, arr] of Object.entries(byDate)) {
        const sum = arr.reduce((s, x) => s + x.amount, 0);
        if (sum > lim) { arr.forEach(x => x.flag = true);
          flags.push(`${key === 'food' ? 'Food' : 'Accommodation'} ${date || '(no date)'} ${inr(sum)} exceeds ${key === 'food' ? 'food' : 'stay'} limit ${inr(lim)}${trip.place ? ' · ' + trip.place : ''}`); }
      }
    }
    return { place: (trip.place || '').trim(), from_date: trip.from_date || '', to_date: trip.to_date || '',
      reason: (trip.reason || '').trim(), items };
  });
  return { trips, total: +total.toFixed(2), flags };
}

async function outstationPdf(row, status, approver, approvedAt) {
  const pol = await getPolicy();
  const cat = row.expense_category === 'CAT1' ? 'CAT1' : 'CAT2';
  const trips = (row.payload && row.payload.trips) || [];
  const summary = await buildOutstationSummary({
    ref_no: row.ref_no, emp_name: row.emp_name, emp_code: row.emp_code, designation: row.designation || '',
    category: catLabel(cat), period_label: monthLabel(row.period), limits: pol.limits[cat],
    trips, total: Number(row.total_amount || 0), flags: row.flags || [], status, approver, approved_at: approvedAt });
  const bills = [];
  for (const t of trips) for (const it of (t.items || [])) {
    if (it.bill && it.bill.drive_item_id) {
      const bytes = await graph.fetchDriveItemContent(it.bill.drive_item_id);
      if (bytes) bills.push({ bytes, mime: it.bill.mime || guessMime(it.bill.name), caption: `Bill: ${it.desc || ''} — ${CAT_LABEL[it.category] || it.category}` });
    }
  }
  return bills.length ? await mergeBills(summary, bills) : summary;
}
async function miscPdf(row, status, approver, approvedAt) {
  const items = (row.payload && row.payload.items) || [];
  const summary = await buildMiscSummary({
    ref_no: row.ref_no, emp_name: row.emp_name, emp_code: row.emp_code, designation: row.designation || '',
    category: catLabel(row.expense_category === 'CAT1' ? 'CAT1' : 'CAT2'),
    items, total: Number(row.total_amount || 0), generated_at: fmtDateTime(new Date()),
    status, approver, approved_at: approvedAt });
  const bills = [];
  for (const it of items) if (it.bill && it.bill.drive_item_id) {
    const bytes = await graph.fetchDriveItemContent(it.bill.drive_item_id);
    if (bytes) bills.push({ bytes, mime: it.bill.mime || guessMime(it.bill.name), caption: `Bill: ${it.desc || ''}` });
  }
  return bills.length ? await mergeBills(summary, bills) : summary;
}

// Mint an upload session for a bill (browser uploads it straight to OneDrive).
router.post('/bill-session', async (req, res) => {
  const { ref, name } = req.body || {};
  if (!ref || !name) return res.status(400).json({ error: 'ref and name required' });
  const own = (await q('SELECT id FROM expense_submissions WHERE ref_no=$1 AND employee_id=$2', [ref, req.user.id])).rows[0];
  if (!own) return res.status(403).json({ error: 'Not your claim' });
  const safe = String(name).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const sess = await graph.createExpenseBillSession(ref, safe);
  if (!sess) return res.status(503).json({ error: 'Bill storage is not set up yet.' });
  res.json({ uploadUrl: sess.uploadUrl, file_name: safe });
});

// ---------------- OUTSTATION ----------------
router.get('/outstation/:period', async (req, res) => {
  const period = req.params.period;
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Bad period' });
  let row = (await q(`SELECT * FROM expense_submissions WHERE employee_id=$1 AND form_type='outstation' AND period=$2 ORDER BY id DESC LIMIT 1`, [req.user.id, period])).rows[0];
  if (!row) {
    const ref = await refNo('OUT');
    row = (await q(`INSERT INTO expense_submissions(ref_no,employee_id,form_type,period,payload,status)
      VALUES($1,$2,'outstation',$3,$4,'draft') RETURNING *`, [ref, req.user.id, period, JSON.stringify({ trips: [] })])).rows[0];
  }
  const allow = await submitAllowed('outstation', period);
  res.json({ ...row, can_submit: ['draft', 'returned'].includes(row.status) && allow, period_label: monthLabel(period) });
});
router.put('/outstation/:id', async (req, res) => {
  const row = (await q('SELECT * FROM expense_submissions WHERE id=$1', [req.params.id])).rows[0];
  if (!row || row.employee_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (!['draft', 'returned'].includes(row.status)) return res.status(409).json({ error: 'Already submitted' });
  const pol = await getPolicy();
  const cat = req.user.expense_category === 'CAT1' ? 'CAT1' : 'CAT2';
  const { trips, total, flags } = computeOutstation(req.body || {}, pol.limits[cat]);
  await q(`UPDATE expense_submissions SET payload=$2, total_amount=$3, flags=$4, updated_at=now() WHERE id=$1`,
    [row.id, JSON.stringify({ trips }), total, JSON.stringify(flags)]);
  res.json({ ok: true, total, flags });
});
router.post('/outstation/:id/submit', async (req, res) => {
  const row = (await q('SELECT * FROM expense_submissions WHERE id=$1', [req.params.id])).rows[0];
  if (!row || row.employee_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (!['draft', 'returned'].includes(row.status)) return res.status(409).json({ error: 'Already submitted' });
  if (!(await submitAllowed('outstation', row.period))) return res.status(400).json({ error: 'This month can be submitted from the 1st of next month.' });
  const trips = (row.payload && row.payload.trips) || [];
  const itemCount = trips.reduce((s, t) => s + ((t.items || []).length), 0);
  if (!itemCount) return res.status(400).json({ error: 'Add at least one expense line before submitting.' });
  await enterChain(row.id);
  res.json({ ok: true });
});

// ---------------- MISCELLANEOUS (self-service, no HR) ----------------
router.get('/misc/new', async (req, res) => {
  const ref = await refNo('MSC');
  const row = (await q(`INSERT INTO expense_submissions(ref_no,employee_id,form_type,payload,status)
    VALUES($1,$2,'misc',$3,'draft') RETURNING *`, [ref, req.user.id, JSON.stringify({ items: [] })])).rows[0];
  res.json(row);
});
router.put('/misc/:id', async (req, res) => {
  const row = (await q('SELECT * FROM expense_submissions WHERE id=$1', [req.params.id])).rows[0];
  if (!row || row.employee_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (!['draft', 'generated', 'returned'].includes(row.status)) return res.status(409).json({ error: 'Locked' });
  let total = 0;
  const items = (req.body.items || []).map(it => {
    const amount = Math.max(0, parseFloat(it.amount) || 0); total += amount;
    return { date: it.date || '', desc: (it.desc || '').trim(), amount, bill: it.bill || null, bill_name: (it.bill && it.bill.name) || null };
  });
  await q(`UPDATE expense_submissions SET payload=$2, total_amount=$3, updated_at=now() WHERE id=$1`,
    [row.id, JSON.stringify({ items }), +total.toFixed(2)]);
  res.json({ ok: true, total: +total.toFixed(2) });
});
router.post('/misc/:id/submit', async (req, res) => {
  const row = (await q('SELECT * FROM expense_submissions WHERE id=$1', [req.params.id])).rows[0];
  if (!row || row.employee_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (!['draft', 'generated', 'returned'].includes(row.status)) return res.status(409).json({ error: 'Locked' });
  const items = (row.payload && row.payload.items) || [];
  if (!items.length) return res.status(400).json({ error: 'Add at least one item.' });
  if (!row.pdf_token) await q(`UPDATE expense_submissions SET pdf_token=$2 WHERE id=$1`, [row.id, crypto.randomBytes(12).toString('hex')]);
  await enterChain(row.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports._internal = { conveyancePdf, outstationPdf, miscPdf, loadRow, loadTripByToken, applyTripApprove, applyTripReject };
