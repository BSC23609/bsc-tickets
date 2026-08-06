const express = require('express');
const crypto = require('crypto');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const wati = require('../lib/wati');
const { background } = require('../lib/bg');
const { computeOt } = require('../lib/ot');
const router = express.Router();

router.use(auth.requireAuth);

const OT_DEPTS = ['production', 'dispatch'];
const isEligible = (u) => OT_DEPTS.includes(String(u.department || '').trim().toLowerCase());
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
    return res.json({ ok: true, self_approved: true });
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
  const rows = (await q(
    `SELECT o.id, o.employee_id, o.department, to_char(o.ot_date,'YYYY-MM-DD') AS ot_date, o.end_time,
            o.hours, o.amount, o.is_late, e.name AS employee_name, e.emp_no
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id
     WHERE o.approver_emp_id=$1 AND o.status='pending'
     ORDER BY o.ot_date DESC, e.name`, [req.user.id])).rows;
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  res.json({ count: rows.length, total, entries: rows });
});

async function decide(req, res, approve) {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const e = (await q(`SELECT * FROM ot_entries WHERE id=$1`, [req.params.id])).rows[0];
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.approver_emp_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not your approval' });
  if (e.status !== 'pending') return res.status(400).json({ error: `Already ${e.status}` });
  if (approve) {
    await q(`UPDATE ot_entries SET status='approved', approver_name=$2, reviewed_at=now(), updated_at=now() WHERE id=$1`, [e.id, req.user.name]);
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
  const r = await q(`UPDATE ot_entries SET status='approved', approver_name=$2, reviewed_at=now(), updated_at=now()
     WHERE approver_emp_id=$1 AND status='pending' RETURNING id`, [req.user.id, req.user.name]);
  res.json({ ok: true, approved: r.rows.length });
});

module.exports = router;
