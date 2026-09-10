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
    amount: Number(b.total_amount || 0), report_url: '/api/final/ot-report/' + b.id,
    approve: { url: '/ot/mgmt-batch/' + b.id + '/approve' },
  }));

  // 3) Labour OT + shearing — grouped under "Labours", submitted/approved per part.
  const lab = (await q(`SELECT company, period, ot_total, shearing_total, ot_status, shearing_status FROM labour_period WHERE ot_status='pending_mgmt' OR shearing_status='pending_mgmt' ORDER BY period`)).rows;
  lab.forEach(p => {
    if (p.ot_status === 'pending_mgmt') items.push({
      kind: 'labour', type_key: 'labour', type_label: 'Labour (OT + Shearing)', payee: 'Labours', payee_key: 'labours',
      sub: (LABOUR_CO[p.company] || p.company) + ' \u00b7 ' + monthLabel(p.period) + ' \u00b7 Overtime',
      amount: Number(p.ot_total || 0), company: p.company, period: p.period,
      report_url: `/api/labour/report-pdf/${p.company}/${p.period}/ot`,
      approve: { url: '/labour/approve', body: { company: p.company, month: p.period, part: 'ot' } },
    });
    if (p.shearing_status === 'pending_mgmt') items.push({
      kind: 'labour', type_key: 'labour', type_label: 'Labour (OT + Shearing)', payee: 'Labours', payee_key: 'labours',
      sub: (LABOUR_CO[p.company] || p.company) + ' \u00b7 ' + monthLabel(p.period) + ' \u00b7 Shearing',
      amount: Number(p.shearing_total || 0), company: p.company, period: p.period,
      report_url: `/api/labour/report-pdf/${p.company}/${p.period}/shearing`,
      approve: { url: '/labour/approve', body: { company: p.company, month: p.period, part: 'shearing' } },
    });
  });

  const total = items.reduce((s, i) => s + i.amount, 0);
  res.json({ items, total, count: items.length });
});

// Consolidated Overtime report (Employees + Labour) for a pending OT batch — shown as the PDF
// preview on the Overtime item. Includes labour OT for the same month so management sees all OT.
router.get('/ot-report/:batchId', async (req, res) => {
  if (!(await isMgmt(req.user))) return res.status(403).send('Not allowed');
  const b = (await q(`SELECT period FROM ot_batches WHERE id=$1`, [req.params.batchId])).rows[0];
  if (!b) return res.status(404).send('Not found');
  const period = b.period;
  const emp = (await q(`SELECT e.name, COALESCE(SUM(o.hours),0) AS hours, COALESCE(SUM(o.amount),0) AS amount
                        FROM ot_entries o JOIN employees e ON e.id=o.employee_id WHERE o.batch_id=$1 GROUP BY e.name ORDER BY e.name`, [req.params.batchId])).rows;
  const lab = (await q(`SELECT labour_name AS name, COALESCE(SUM(hours),0) AS hours, COALESCE(SUM(amount),0) AS amount
                        FROM labour_ot WHERE period=$1 GROUP BY labour_name ORDER BY labour_name`, [period])).rows;
  const empT = emp.reduce((s, r) => s + Number(r.amount), 0), labT = lab.reduce((s, r) => s + Number(r.amount), 0);
  const { buildPaymentReportPDF } = require('../lib/payment_pdf');
  const col = [{ label: 'Name', width: 0.6 }, { label: 'Total hours', width: 0.2, align: 'right' }, { label: 'Amount', width: 0.2, align: 'right' }];
  const pdf = await buildPaymentReportPDF({
    title: 'Overtime — consolidated', subtitle: `${monthLabel(period)} · Employees + Labour`, approved: false,
    sections: [
      { name: 'Employees', total: empT, cols: col, rows: emp.map(r => [r.name, (+r.hours).toFixed(2), money(r.amount)]) },
      { name: 'Labour (daily wage)', total: labT, cols: col, rows: lab.map(r => [r.name, (+r.hours).toFixed(2), money(r.amount)]) },
    ],
    grandTotal: empT + labT,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="OT_consolidated_${period}.pdf"`);
  res.end(pdf);
});

module.exports = router;
