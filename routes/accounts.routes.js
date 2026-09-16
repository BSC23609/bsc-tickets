// Accounts portal — the accounts team sees pending (approved, unpaid) payments and marks them
// paid after paying. Paid items drop out of the reports and the Send-to-Accounts queue.
const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const router = express.Router();
router.use(auth.requireAuth);

const { expInMonth, COMPANIES } = require('./final.routes')._internal;
const monthLabel = (m) => { const [y, mo] = String(m).split('-'); return new Date(y, mo - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }); };
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };

async function isAccounts(u) {
  return u.is_admin || /account/i.test(u.department || '');
}

// Pending payments for a month, grouped by company → type → person.
router.get('/pending', async (req, res) => {
  if (!(await isAccounts(req.user))) return res.status(403).json({ error: 'Accounts / admin only.' });
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : prevMonth();
  const out = [];
  for (const key of ['BSC', 'G2']) {
    const C = COMPANIES[key];
    // Expense: per employee (approved, unpaid)
    const exp = (await q(
      `SELECT e.id, e.name, e.emp_no, COALESCE(SUM(s.total_amount),0) AS total
       FROM employees e JOIN expense_submissions s ON s.employee_id=e.id
       WHERE e.emp_no LIKE $1 AND s.status='approved' AND s.paid_at IS NULL AND ${expInMonth('s', '$2')}
       GROUP BY e.id, e.name, e.emp_no ORDER BY e.name`, [C.staffPrefix + '/%', month])).rows;
    // Staff OT: per employee (mgmt_approved, unpaid)
    const otStaff = (await q(
      `SELECT e.id, e.name, e.emp_no, COALESCE(SUM(o.amount),0) AS total
       FROM employees e JOIN ot_entries o ON o.employee_id=e.id
       WHERE e.emp_no LIKE $1 AND o.status='mgmt_approved'
         AND o.ot_date >= ($2||'-01')::date AND o.ot_date < (($2||'-01')::date + interval '1 month')
       GROUP BY e.id, e.name, e.emp_no ORDER BY e.name`, [C.staffPrefix + '/%', month])).rows;
    // Labour OT: per labour (period approved, unpaid)
    const otLab = (await q(
      `SELECT lo.labour_name AS name, MAX(lo.labour_code) AS emp_no, COALESCE(SUM(lo.amount),0) AS total
       FROM labour_ot lo JOIN labour_period lp ON lp.company=lo.company AND lp.period=lo.period
       WHERE lo.company=$1 AND lo.period=$2 AND lp.ot_status='approved' AND lo.paid_at IS NULL
       GROUP BY lo.labour_name ORDER BY lo.labour_name`, [C.labourCo, month])).rows;
    // Shearing: per labour
    const sh = (await q(
      `SELECT ls.labour_name AS name, MAX(ls.labour_code) AS emp_no, COALESCE(SUM(ls.amount),0) AS total
       FROM labour_shearing ls JOIN labour_period lp ON lp.company=ls.company AND lp.period=ls.period
       WHERE ls.company=$1 AND ls.period=$2 AND lp.shearing_status='approved' AND ls.paid_at IS NULL
       GROUP BY ls.labour_name ORDER BY ls.labour_name`, [C.labourCo, month])).rows;

    const types = [];
    if (exp.length) types.push({ type: 'expense', label: 'Employee expenses', rows: exp.map(r => ({ key: String(r.id), name: r.name, code: r.emp_no, total: Number(r.total) })) });
    if (otStaff.length || otLab.length) types.push({ type: 'ot', label: 'Overtime', rows: [
      ...otStaff.map(r => ({ key: 'emp:' + r.id, name: r.name, code: r.emp_no, total: Number(r.total) })),
      ...otLab.map(r => ({ key: 'lab:' + r.name, name: r.name + ' (labour)', code: r.emp_no || '—', total: Number(r.total) })),
    ] });
    if (sh.length) types.push({ type: 'shearing', label: 'Shed-B Shearing', rows: sh.map(r => ({ key: 'lab:' + r.name, name: r.name, code: r.emp_no || '—', total: Number(r.total) })) });

    const total = types.reduce((s, t) => s + t.rows.reduce((a, r) => a + r.total, 0), 0);
    if (types.length) out.push({ company: key, label: C.label, types, total });
  }
  const grand = out.reduce((s, c) => s + c.total, 0);
  res.json({ month, companies: out, grand });
});

// Mark one person's payment (of one type) as paid.
router.post('/mark-paid', async (req, res) => {
  if (!(await isAccounts(req.user))) return res.status(403).json({ error: 'Accounts / admin only.' });
  const type = req.body.type, company = COMPANIES[req.body.company] ? req.body.company : null;
  const month = /^\d{4}-\d{2}$/.test(String(req.body.month || '')) ? req.body.month : null;
  const key = String(req.body.key || '');
  if (!company || !month || !key) return res.status(400).json({ error: 'Bad request' });
  const C = COMPANIES[company];
  let changed = 0;
  if (type === 'expense') {
    const empId = +key;
    const r = await q(`UPDATE expense_submissions SET paid_at=now(), paid_by_name=$3 WHERE employee_id=$1 AND status='approved' AND paid_at IS NULL AND ${expInMonth('expense_submissions', '$2')} RETURNING id`, [empId, month, req.user.name]);
    changed = r.rows.length;
  } else if (type === 'ot') {
    if (key.startsWith('emp:')) {
      const r = await q(`UPDATE ot_entries SET status='paid', updated_at=now() WHERE employee_id=$1 AND status='mgmt_approved' AND ot_date >= ($2||'-01')::date AND ot_date < (($2||'-01')::date + interval '1 month') RETURNING id`, [+key.slice(4), month]);
      changed = r.rows.length;
    } else if (key.startsWith('lab:')) {
      const r = await q(`UPDATE labour_ot SET paid_at=now() WHERE company=$1 AND period=$2 AND labour_name=$3 AND paid_at IS NULL RETURNING id`, [C.labourCo, month, key.slice(4)]);
      changed = r.rows.length;
    }
  } else if (type === 'shearing') {
    const r = await q(`UPDATE labour_shearing SET paid_at=now() WHERE company=$1 AND period=$2 AND labour_name=$3 AND paid_at IS NULL RETURNING id`, [C.labourCo, month, key.replace(/^lab:/, '')]);
    changed = r.rows.length;
  } else return res.status(400).json({ error: 'Bad type' });
  res.json({ ok: true, changed });
});

// Mark a whole type for a company as paid (bulk).
router.post('/mark-type-paid', async (req, res) => {
  if (!(await isAccounts(req.user))) return res.status(403).json({ error: 'Accounts / admin only.' });
  const type = req.body.type, company = COMPANIES[req.body.company] ? req.body.company : null;
  const month = /^\d{4}-\d{2}$/.test(String(req.body.month || '')) ? req.body.month : null;
  if (!company || !month) return res.status(400).json({ error: 'Bad request' });
  const C = COMPANIES[company];
  let changed = 0;
  if (type === 'expense') {
    const r = await q(`UPDATE expense_submissions s SET paid_at=now(), paid_by_name=$3 FROM employees e WHERE s.employee_id=e.id AND e.emp_no LIKE $1 AND s.status='approved' AND s.paid_at IS NULL AND ${expInMonth('s', '$2')} RETURNING s.id`, [C.staffPrefix + '/%', month, req.user.name]);
    changed = r.rows.length;
  } else if (type === 'ot') {
    const a = await q(`UPDATE ot_entries o SET status='paid', updated_at=now() FROM employees e WHERE o.employee_id=e.id AND e.emp_no LIKE $1 AND o.status='mgmt_approved' AND o.ot_date >= ($2||'-01')::date AND o.ot_date < (($2||'-01')::date + interval '1 month') RETURNING o.id`, [C.staffPrefix + '/%', month]);
    const b = await q(`UPDATE labour_ot lo SET paid_at=now() FROM labour_period lp WHERE lp.company=lo.company AND lp.period=lo.period AND lo.company=$1 AND lo.period=$2 AND lp.ot_status='approved' AND lo.paid_at IS NULL RETURNING lo.id`, [C.labourCo, month]);
    changed = a.rows.length + b.rows.length;
  } else if (type === 'shearing') {
    const r = await q(`UPDATE labour_shearing ls SET paid_at=now() FROM labour_period lp WHERE lp.company=ls.company AND lp.period=ls.period AND ls.company=$1 AND ls.period=$2 AND lp.shearing_status='approved' AND ls.paid_at IS NULL RETURNING ls.id`, [C.labourCo, month]);
    changed = r.rows.length;
  } else return res.status(400).json({ error: 'Bad type' });
  res.json({ ok: true, changed });
});

module.exports = router;
