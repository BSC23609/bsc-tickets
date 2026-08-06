const express = require('express');
const crypto = require('crypto');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const wati = require('../lib/wati');
const graph = require('../lib/graph');
const { buildOtReportXlsx } = require('../lib/ot_report');
const { background } = require('../lib/bg');
const { computeOt } = require('../lib/ot');
const router = express.Router();

router.use(auth.requireAuth);

const OT_DEPTS = ['production', 'dispatch'];
const isEligible = (u) => u.is_admin || OT_DEPTS.includes(String(u.department || '').trim().toLowerCase());
const periodOf = (dateStr) => String(dateStr).slice(0, 7);
const APP_URL = process.env.PUBLIC_BASE_URL || 'https://tickets.bharatsteels.in';

// OT approvers are configured in Admin: Production → Kannan, Dispatch → Kumar N.
async function otApproverId(department) {
  const key = String(department || '').trim().toLowerCase() === 'dispatch' ? 'ot_approver_dispatch' : 'ot_approver_production';
  const r = (await q(`SELECT value FROM app_settings WHERE key=$1`, [key])).rows[0];
  return r && r.value ? +r.value : null;
}
async function allApproverIds() {
  const rows = (await q(`SELECT value FROM app_settings WHERE key IN ('ot_approver_production','ot_approver_dispatch')`)).rows;
  return rows.map(r => +r.value).filter(Boolean);
}
async function otHrId() {
  const r = (await q(`SELECT value FROM app_settings WHERE key='ot_hr_emp_id'`)).rows[0];
  return r && r.value ? +r.value : null;
}
async function otMgmtIds() {
  const r = (await q(`SELECT value FROM app_settings WHERE key='ot_mgmt_emp_ids'`)).rows[0];
  return r && r.value ? r.value.split(',').map(Number).filter(Boolean) : [];
}
// After management approval: build the report, email Accounts, and WhatsApp Accounts to check email.
async function sendBatchToAccounts(batchId, period) {
  const summary = (await q(
    `SELECT e.name AS employee_name, e.emp_no, o.department,
            count(*) AS days, COALESCE(sum(o.hours),0) AS hours, COALESCE(sum(o.amount),0) AS amount
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id
     WHERE o.batch_id=$1 GROUP BY e.name, e.emp_no, o.department ORDER BY e.name`, [batchId])).rows;
  const detail = (await q(
    `SELECT e.name AS employee_name, e.emp_no, to_char(o.ot_date,'YYYY-MM-DD') AS ot_date, o.end_time, o.hours, o.amount, o.is_late
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id WHERE o.batch_id=$1 ORDER BY e.name, o.ot_date`, [batchId])).rows;
  const rep = await buildOtReportXlsx(period, summary, detail);

  const cfg = Object.fromEntries((await q(`SELECT key,value FROM app_settings WHERE key IN ('ot_accounts_emp_id','ot_accounts_email')`)).rows.map(r => [r.key, r.value]));
  if (cfg.ot_accounts_email) {
    try {
      await graph.sendMail({
        to: cfg.ot_accounts_email,
        subject: `Approved OT report — ${rep.monthName}`,
        html: `<p>Please find attached the management-approved overtime report for <b>${rep.monthName}</b>.</p>
               <p>${rep.emp_count} employees · Total <b>Rs. ${rep.total.toLocaleString('en-IN')}</b>.</p>
               <p>Kindly process the payment.</p>`,
        attachments: [{
          name: `OT_${period}.xlsx`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contentBytes: rep.base64,
        }],
      });
    } catch (e) { console.error('[ot accounts email]', e.message); }
  }
  if (cfg.ot_accounts_emp_id) {
    const acc = (await q(`SELECT id,name,phone FROM employees WHERE id=$1`, [+cfg.ot_accounts_emp_id])).rows[0];
    if (acc && acc.phone) {
      try { await wati.notify.ot.accounts(acc, { period: rep.monthName, employees: rep.emp_count, total: rep.total }); }
      catch (e) { console.error('[ot accounts notify]', e.message); }
    }
  }
  await q(`UPDATE ot_batches SET status='sent_accounts', sent_accounts_at=now() WHERE id=$1`, [batchId]);
}
// Ping HR (Rajasekar) that approved OT is waiting for verification. Best-effort, one message.
async function pingHr() {
  const hrId = await otHrId();
  if (!hrId) return;
  const hr = (await q(`SELECT id,name,phone FROM employees WHERE id=$1`, [hrId])).rows[0];
  if (!hr || !hr.phone) return;
  const agg = (await q(`SELECT count(*) AS c, COALESCE(sum(amount),0) AS t FROM ot_entries WHERE status='approved'`)).rows[0];
  if (+agg.c === 0) return;
  try { await wati.notify.ot.hrVerify(hr, { count: agg.c, total: agg.t }); }
  catch (e) { console.error('[ot pingHr]', e.message); }
}

// Late if logged more than 24h after the OT day's 19:00 IST shift-end.
function isLate(otDate) {
  const shiftEnd = new Date(`${otDate}T19:00:00+05:30`);
  return Date.now() > shiftEnd.getTime() + 24 * 3600 * 1000;
}

// Who this person is + their entries for a period.
router.get('/meta', async (req, res) => {
  const eligible = isEligible(req.user);
  const period = req.query.period || new Date().toISOString().slice(0, 7);
  let entries = [];
  if (eligible) {
    entries = (await q(
      `SELECT id, to_char(ot_date,'YYYY-MM-DD') AS ot_date, end_time, ot_minutes, hours, amount,
              status, is_late, reject_reason, approver_name
       FROM ot_entries WHERE employee_id=$1 AND period=$2 ORDER BY ot_date DESC`,
      [req.user.id, period])).rows;
  }
  const approverIds = await allApproverIds();
  const isApprover = approverIds.includes(req.user.id);
  let pendingForMe = 0;
  if (isApprover) {
    pendingForMe = +(await q(`SELECT count(*) FROM ot_entries WHERE approver_emp_id=$1 AND status='pending'`, [req.user.id])).rows[0].count;
  }
  res.json({
    eligible, department: req.user.department || null, period,
    name: req.user.name, rate_per_half: 50, shift_end: '19:00', entries,
    is_ot_approver: isApprover, pending_for_me: pendingForMe,
  });
});

// Preview the amount for an end time (client also computes, this is the source of truth).
router.get('/preview', (req, res) => {
  res.json(computeOt(req.query.end || ''));
});

// Log (or update) the OT entry for a day. One entry per person per day.
router.post('/entry', async (req, res) => {
  if (!isEligible(req.user)) return res.status(403).json({ error: 'OT logging is only for Production and Dispatch staff.' });
  const otDate = String((req.body && req.body.ot_date) || '').slice(0, 10);
  const endTime = String((req.body && req.body.end_time) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(otDate)) return res.status(400).json({ error: 'Pick a valid date' });
  if (otDate > new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Cannot log OT for a future date' });
  const calc = computeOt(endTime);
  if (!calc.valid) return res.status(400).json({ error: calc.error });

  // Block editing once it's been submitted/approved.
  const existing = (await q('SELECT id, status FROM ot_entries WHERE employee_id=$1 AND ot_date=$2', [req.user.id, otDate])).rows[0];
  if (existing && existing.status !== 'draft')
    return res.status(400).json({ error: `This day is already ${existing.status} and can't be edited.` });

  const period = periodOf(otDate);
  const late = isLate(otDate);
  const row = (await q(
    `INSERT INTO ot_entries (employee_id, department, period, ot_date, end_time, ot_minutes, hours, amount, is_late, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
     ON CONFLICT (employee_id, ot_date) DO UPDATE SET
       end_time=EXCLUDED.end_time, ot_minutes=EXCLUDED.ot_minutes, hours=EXCLUDED.hours,
       amount=EXCLUDED.amount, is_late=EXCLUDED.is_late, period=EXCLUDED.period, updated_at=now()
     RETURNING id`,
    [req.user.id, req.user.department, period, otDate, endTime, calc.ot_minutes, calc.hours, calc.amount, late]
  )).rows[0];
  res.json({ ok: true, id: row.id, amount: calc.amount, hours: calc.hours, is_late: late });
});

// Remove a still-draft entry.
// Revert an entry back to draft so the employee can fix and resubmit — allowed until HR verifies it
// (i.e. while pending / approved / rejected). Clears any approval/rejection so it starts fresh.
router.post('/entry/:id/revert', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const e = (await q('SELECT * FROM ot_entries WHERE id=$1', [req.params.id])).rows[0];
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.employee_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'You can only revert your own OT entries.' });
  if (!['pending', 'approved', 'rejected'].includes(e.status))
    return res.status(400).json({ error: `Can't revert once ${e.status} — HR has verified it or it's already in a monthly report.` });
  await q(`UPDATE ot_entries SET status='draft', approver_emp_id=NULL, approver_name=NULL, action_token=NULL,
       reviewed_at=NULL, reject_reason=NULL, batch_id=NULL, updated_at=now() WHERE id=$1`, [e.id]);
  res.json({ ok: true });
});

router.delete('/entry/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const r = await q(`DELETE FROM ot_entries WHERE id=$1 AND employee_id=$2 AND status='draft' RETURNING id`,
    [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(400).json({ error: 'Only your own not-yet-submitted entries can be deleted.' });
  res.json({ ok: true });
});

// Submit a day's OT for approval. Production → Kannan, Dispatch → Kumar N.
// If the submitter IS the dept's approver (Kumar logging his own OT), it auto-approves → straight to HR.
router.post('/submit', async (req, res) => {
  if (!isEligible(req.user)) return res.status(403).json({ error: 'OT is only for Production and Dispatch staff.' });
  const otDate = String((req.body && req.body.date) || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(otDate)) return res.status(400).json({ error: 'Pick a valid date' });
  const e = (await q(`SELECT * FROM ot_entries WHERE employee_id=$1 AND ot_date=$2`, [req.user.id, otDate])).rows[0];
  if (!e) return res.status(404).json({ error: 'No OT entry for that day' });
  if (e.status !== 'draft') return res.status(400).json({ error: `Already ${e.status}` });

  const approverId = await otApproverId(req.user.department);
  if (!approverId) return res.status(400).json({ error: `No OT approver set for ${req.user.department}. Ask admin to configure it.` });

  // Kumar (dispatch approver) logging his own OT → skip approval, go straight to HR verification.
  if (approverId === req.user.id) {
    await q(`UPDATE ot_entries SET status='approved', approver_emp_id=$2, approver_name=$3, reviewed_at=now(), updated_at=now() WHERE id=$1`,
      [e.id, req.user.id, req.user.name]);
    res.json({ ok: true, self_approved: true });
    background((async () => { await pingHr(); })());
    return;
  }

  const token = crypto.randomBytes(16).toString('hex');
  await q(`UPDATE ot_entries SET status='pending', approver_emp_id=$2, action_token=$3, updated_at=now() WHERE id=$1`,
    [e.id, approverId, token]);
  res.json({ ok: true, pending: true });

  background((async () => {
    const appr = (await q(`SELECT id,name,phone FROM employees WHERE id=$1`, [approverId])).rows[0];
    const pend = +(await q(`SELECT count(*) FROM ot_entries WHERE approver_emp_id=$1 AND status='pending'`, [approverId])).rows[0].count;
    if (appr && appr.phone) {
      try { await wati.notify.ot.approval(appr, { employee: req.user.name, date: otDate, hours: (+e.hours).toFixed(2), amount: e.amount, pending: pend }); }
      catch (err) { console.error('[ot submit notify]', err.message); }
    }
  })());
});

// ---- Approver side (Kannan / Kumar) ----
router.get('/approvals', async (req, res) => {
  const admin = !!req.user.is_admin;
  const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : null;
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const where = []; const params = [];
  if (admin) { where.push(`o.approver_emp_id IS NOT NULL`); }
  else { params.push(req.user.id); where.push(`o.approver_emp_id=$${params.length}`); }
  if (period) { params.push(period); where.push(`o.period=$${params.length}`); }
  if (status) { params.push(status); where.push(`o.status=$${params.length}`); }
  const rows = (await q(
    `SELECT o.id, o.employee_id, o.department, to_char(o.ot_date,'YYYY-MM-DD') AS ot_date, o.end_time,
            o.hours, o.amount, o.is_late, o.status, o.reject_reason, e.name AS employee_name, e.emp_no
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id
     WHERE ${where.join(' AND ')} ORDER BY e.name, o.ot_date DESC`, params)).rows;
  const pending = rows.filter(r => r.status === 'pending');
  res.json({
    entries: rows,
    count: pending.length, total: pending.reduce((s, r) => s + Number(r.amount), 0),
    employees: [...new Set(rows.map(r => r.employee_name))].sort(),
  });
});

async function decide(req, res, approve) {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const e = (await q(`SELECT * FROM ot_entries WHERE id=$1`, [req.params.id])).rows[0];
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.approver_emp_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not your approval' });
  if (e.status !== 'pending') return res.status(400).json({ error: `Already ${e.status}` });
  if (approve) {
    await q(`UPDATE ot_entries SET status='approved', approver_name=$2, reviewed_at=now(), updated_at=now() WHERE id=$1`, [e.id, req.user.name]);
    background((async () => { await pingHr(); })());
  } else {
    const reason = ((req.body && req.body.reason) || '').trim() || 'Rejected';
    await q(`UPDATE ot_entries SET status='rejected', approver_name=$2, reject_reason=$3, reviewed_at=now(), updated_at=now() WHERE id=$1`, [e.id, req.user.name, reason]);
  }
  res.json({ ok: true });
}
router.post('/approvals/:id/approve', (req, res) => decide(req, res, true));
router.post('/approvals/:id/reject', (req, res) => decide(req, res, false));

// Approve every pending OT routed to me in one shot.
router.post('/approvals/approve-all', async (req, res) => {
  const admin = !!req.user.is_admin;
  const r = await q(
    `UPDATE ot_entries SET status='approved', approver_name=$1, reviewed_at=now(), updated_at=now()
     WHERE status='pending'` + (admin ? '' : ' AND approver_emp_id=$2') + ` RETURNING id`,
    admin ? [req.user.name] : [req.user.name, req.user.id]);
  res.json({ ok: true, approved: r.rows.length });
  if (r.rows.length) background((async () => { await pingHr(); })());
});

// ---- HR verification (Rajasekar) ----
async function requireOtHr(req, res, next) {
  const hrId = await otHrId();
  if (req.user.is_admin || (hrId && req.user.id === hrId)) return next();
  return res.status(403).json({ error: 'Only HR can verify OT.' });
}
router.get('/hr-queue', requireOtHr, async (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : null;
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const HR_STAGES = ['approved', 'hr_verified', 'mgmt_pending', 'mgmt_approved', 'paid'];
  const where = [`o.status = ANY($1)`]; const params = [HR_STAGES];
  if (period) { params.push(period); where.push(`o.period=$${params.length}`); }
  if (status) { params.push(status); where.push(`o.status=$${params.length}`); }
  const rows = (await q(
    `SELECT o.id, to_char(o.ot_date,'YYYY-MM-DD') AS ot_date, o.end_time, o.hours, o.amount, o.is_late,
            o.status, o.department, o.approver_name, e.name AS employee_name, e.emp_no
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id
     WHERE ${where.join(' AND ')} ORDER BY e.name, o.ot_date DESC`, params)).rows;
  const toVerify = rows.filter(r => r.status === 'approved');
  res.json({
    entries: rows,
    count: toVerify.length, total: toVerify.reduce((s, r) => s + Number(r.amount), 0),
    employees: [...new Set(rows.map(r => r.employee_name))].sort(),
  });
});
router.post('/hr-verify/:id', requireOtHr, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const r = await q(`UPDATE ot_entries SET status='hr_verified', updated_at=now() WHERE id=$1 AND status='approved' RETURNING id`, [req.params.id]);
  if (!r.rows.length) return res.status(400).json({ error: 'Not in an approved state' });
  res.json({ ok: true });
});
router.post('/hr-verify-all', requireOtHr, async (req, res) => {
  const r = await q(`UPDATE ot_entries SET status='hr_verified', updated_at=now() WHERE status='approved' RETURNING id`);
  res.json({ ok: true, verified: r.rows.length });
});
router.post('/hr-reject/:id', requireOtHr, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const reason = ((req.body && req.body.reason) || '').trim() || 'Rejected by HR';
  const r = await q(`UPDATE ot_entries SET status='rejected', reject_reason=$2, updated_at=now() WHERE id=$1 AND status='approved' RETURNING id`, [req.params.id, reason]);
  if (!r.rows.length) return res.status(400).json({ error: 'Not in an approved state' });
  res.json({ ok: true });
});

// HR consolidates a month's verified OT into a batch and pushes it to Management.
router.post('/hr-generate', requireOtHr, async (req, res) => {
  const period = String((req.body && req.body.period) || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Pick a valid month (YYYY-MM)' });
  const mgmtIds = await otMgmtIds();
  if (!mgmtIds.length) return res.status(400).json({ error: 'No management approver set. Ask admin to configure OT management approvers.' });

  const verified = (await q(`SELECT id, employee_id, amount FROM ot_entries WHERE period=$1 AND status='hr_verified' AND batch_id IS NULL`, [period])).rows;
  if (!verified.length) return res.status(400).json({ error: 'No HR-verified OT for that month to push.' });
  const empCount = new Set(verified.map(v => v.employee_id)).size;
  const total = verified.reduce((s, v) => s + Number(v.amount), 0);

  const token = crypto.randomBytes(16).toString('hex');
  const batch = (await q(
    `INSERT INTO ot_batches (period, status, entry_count, emp_count, total_amount, generated_by, action_token)
     VALUES ($1,'mgmt_pending',$2,$3,$4,$5,$6) RETURNING id`,
    [period, verified.length, empCount, total, req.user.id, token])).rows[0];
  await q(`UPDATE ot_entries SET status='mgmt_pending', batch_id=$2, updated_at=now() WHERE period=$1 AND status='hr_verified' AND batch_id IS NULL`,
    [period, batch.id]);
  res.json({ ok: true, batch_id: batch.id, entries: verified.length, employees: empCount, total });

  background((async () => {
    for (const mid of mgmtIds) {
      const m = (await q(`SELECT id,name,phone FROM employees WHERE id=$1`, [mid])).rows[0];
      if (m && m.phone) { try { await wati.notify.ot.mgmt(m, { period, employees: empCount, total }); } catch (e) { console.error('[ot mgmt notify]', e.message); } }
    }
  })());
});

// ---- Management (Goverdhan / Gourav / Shivam) ----
async function requireOtMgmt(req, res, next) {
  const ids = await otMgmtIds();
  if (req.user.is_admin || ids.includes(req.user.id)) return next();
  return res.status(403).json({ error: 'Only management can approve OT batches.' });
}
router.get('/mgmt-batches', requireOtMgmt, async (req, res) => {
  const rows = (await q(
    `SELECT b.id, b.period, b.entry_count, b.emp_count, b.total_amount, to_char(b.generated_at,'DD Mon YYYY') AS generated_at,
            g.name AS generated_by_name
     FROM ot_batches b LEFT JOIN employees g ON g.id=b.generated_by
     WHERE b.status='mgmt_pending' ORDER BY b.period DESC`)).rows;
  res.json(rows);
});
// Per-employee consolidated breakdown for a batch.
router.get('/mgmt-batch/:id', requireOtMgmt, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const b = (await q(`SELECT * FROM ot_batches WHERE id=$1`, [req.params.id])).rows[0];
  if (!b) return res.status(404).json({ error: 'Not found' });
  const lines = (await q(
    `SELECT e.name AS employee_name, e.emp_no, o.department,
            count(*) AS days, COALESCE(sum(o.hours),0) AS hours, COALESCE(sum(o.amount),0) AS amount,
            COALESCE(sum(CASE WHEN o.is_late THEN 1 ELSE 0 END),0) AS late_days
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id
     WHERE o.batch_id=$1 GROUP BY e.name, e.emp_no, o.department ORDER BY e.name`, [req.params.id])).rows;
  res.json({ batch: { id: b.id, period: b.period, entry_count: b.entry_count, emp_count: b.emp_count, total_amount: b.total_amount, status: b.status }, lines });
});
router.post('/mgmt-batch/:id/approve', requireOtMgmt, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const b = (await q(`SELECT * FROM ot_batches WHERE id=$1`, [req.params.id])).rows[0];
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status !== 'mgmt_pending') return res.status(400).json({ error: `Batch already ${b.status}` });
  await q(`UPDATE ot_batches SET status='approved', mgmt_emp_id=$2, mgmt_name=$3, reviewed_at=now() WHERE id=$1`, [b.id, req.user.id, req.user.name]);
  await q(`UPDATE ot_entries SET status='mgmt_approved', updated_at=now() WHERE batch_id=$1`, [b.id]);
  res.json({ ok: true });
  background((async () => { await sendBatchToAccounts(b.id, b.period); })());
});
router.post('/mgmt-batch/:id/reject', requireOtMgmt, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const reason = ((req.body && req.body.reason) || '').trim() || 'Rejected by management';
  const b = (await q(`SELECT * FROM ot_batches WHERE id=$1 AND status='mgmt_pending'`, [req.params.id])).rows[0];
  if (!b) return res.status(400).json({ error: 'Not pending' });
  // Send the entries back to HR-verified so HR can fix and re-push.
  await q(`UPDATE ot_batches SET status='rejected', mgmt_emp_id=$2, mgmt_name=$3, reject_reason=$4, reviewed_at=now() WHERE id=$1`, [b.id, req.user.id, req.user.name, reason]);
  await q(`UPDATE ot_entries SET status='hr_verified', batch_id=NULL, updated_at=now() WHERE batch_id=$1`, [b.id]);
  res.json({ ok: true });
});

module.exports = router;
