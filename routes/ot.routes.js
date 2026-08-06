const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const { computeOt } = require('../lib/ot');
const router = express.Router();

router.use(auth.requireAuth);

const OT_DEPTS = ['production', 'dispatch'];
const isEligible = (u) => OT_DEPTS.includes(String(u.department || '').trim().toLowerCase());
const periodOf = (dateStr) => String(dateStr).slice(0, 7);

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
  res.json({
    eligible, department: req.user.department || null, period,
    name: req.user.name, rate_per_half: 50, shift_end: '19:00', entries,
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

module.exports = router;
