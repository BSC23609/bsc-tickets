// Management Final Approval for Payments — one inbox aggregating everything awaiting a
// management/final decision: expense claims (pending_final), staff OT monthly batches, and
// labour OT+shearing (grouped under a single "Labours" payee). Approvals reuse the existing
// per-module endpoints so all their side-effects (PDFs, accounts emails) stay intact.
const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const chain = require('../lib/chain');
const router = express.Router();
router.use(auth.requireAuth);

const FORM_LABEL = { conveyance: 'Local Conveyance', outstation: 'Outstation', misc: 'Miscellaneous' };
const LABOUR_CO = { BSC: 'Bharat Steel (Chennai)', G2: 'G2 Steel Services' };
const monthLabel = (p) => { if (!p) return ''; const [y, m] = String(p).split('-'); return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }); };
const money = (n) => '\u20b9' + Number(n || 0).toLocaleString('en-IN');

async function isMgmt(u) {
  if (u.is_admin) return true;
  const mgmt = ((await q(`SELECT value FROM app_settings WHERE key='ot_mgmt_emp_ids'`)).rows[0]?.value || '').split(',').map(Number);
  if (mgmt.includes(u.id)) return true;
  const c = await chain.getChain();
  return (c.final_approver_ids || []).includes(u.id);
}

router.get('/queue', async (req, res) => {
  if (!(await isMgmt(req.user))) return res.status(403).json({ error: 'Management / admin only.' });
  const items = [];

  // 1) Expense claims awaiting final approval — grouped under the real employee.
  const exp = (await q(
    `SELECT s.id, s.ref_no, s.form_type, s.period, s.total_amount, s.pdf_token, e.name AS emp_name, e.emp_no
     FROM expense_submissions s JOIN employees e ON e.id=s.employee_id
     WHERE s.status='pending_final' ORDER BY s.submitted_at`)).rows;
  exp.forEach(r => items.push({
    kind: 'expense', type_key: r.form_type, type_label: FORM_LABEL[r.form_type] || r.form_type,
    payee: r.emp_name, payee_key: 'emp:' + (r.emp_no || r.emp_name), emp_no: r.emp_no || '',
    sub: (r.period ? monthLabel(r.period) + ' \u00b7 ' : '') + r.ref_no,
    amount: Number(r.total_amount || 0), pdf_token: r.pdf_token || null,
    approve: { url: '/expense/' + r.id + '/final-approve' },
  }));

  // 2) Staff OT — monthly batches awaiting management (approved as a batch).
  const ot = (await q(`SELECT id, period, emp_count, entry_count, total_amount FROM ot_batches WHERE status='mgmt_pending' ORDER BY period`)).rows;
  ot.forEach(b => items.push({
    kind: 'ot', type_key: 'ot', type_label: 'Overtime', payee: 'Overtime', payee_key: 'overtime',
    sub: monthLabel(b.period) + ' \u00b7 ' + b.emp_count + ' staff \u00b7 ' + b.entry_count + ' days',
    amount: Number(b.total_amount || 0), approve: { url: '/ot/mgmt-batch/' + b.id + '/approve' },
  }));

  // 3) Labour OT + shearing — grouped under a single "Labours" payee, per company+month.
  const lab = (await q(`SELECT company, period, ot_total, shearing_total FROM labour_period WHERE status='pending_mgmt' ORDER BY period`)).rows;
  lab.forEach(p => items.push({
    kind: 'labour', type_key: 'labour', type_label: 'Labour (OT + Shearing)', payee: 'Labours', payee_key: 'labours',
    sub: (LABOUR_CO[p.company] || p.company) + ' \u00b7 ' + monthLabel(p.period) + ' \u00b7 OT ' + money(p.ot_total) + ' + Shearing ' + money(p.shearing_total),
    amount: Number(p.ot_total || 0) + Number(p.shearing_total || 0), company: p.company, period: p.period,
    approve: { url: '/labour/approve', body: { company: p.company, month: p.period } },
  }));

  const total = items.reduce((s, i) => s + i.amount, 0);
  res.json({ items, total, count: items.length });
});

module.exports = router;
