// Management Final Approval for Payments — one inbox aggregating everything awaiting a
// management/final decision: expense claims (pending_final), staff OT monthly batches, and
// labour OT+shearing (grouped under a single "Labours" payee). Approvals reuse the existing
// per-module endpoints so all their side-effects (PDFs, accounts emails) stay intact.
const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const chain = require('../lib/chain');
const graph = require('../lib/graph');
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

// ===================== MONTHLY CONSOLIDATED PAYMENTS TO ACCOUNTS =====================
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const OT_DONE = "('mgmt_approved','paid')";  // final-approved stage (paid keeps mgmt_approved history via 'paid')

// Which run-month an item belongs to — keyed off the ACTUAL date, not the entry date.
//   Conveyance/Outstation: their period (already the 26th→25th cycle from trip dates).
//   Misc: its "Set month" period if forced, else its submission date (misc has no trip cycle).
//   OT: the OT date's calendar month (1st→last).
function expInMonth(s, p) {
  return `(
    (${s}.form_type <> 'misc' AND ${s}.period = ${p})
    OR (${s}.form_type = 'misc' AND COALESCE(${s}.period, to_char(${s}.submitted_at,'YYYY-MM'), to_char(${s}.created_at,'YYYY-MM'), to_char(${s}.final_at,'YYYY-MM')) = ${p})
  )`;
}
function otInMonth(o, p) {
  return `${o}.ot_date >= (${p}||'-01')::date AND ${o}.ot_date < ((${p}||'-01')::date + interval '1 month') AND ${o}.status IN ${OT_DONE}`;
}

// Build one employee's consolidated PDF: breakdown cover + each approved claim + OT summary.
async function buildEmployeeConsolidatedPdf(empId, month) {
  const emp = (await q(`SELECT id,name,emp_no FROM employees WHERE id=$1`, [empId])).rows[0];
  if (!emp) return null;
  const claims = (await q(
    `SELECT id, form_type, total_amount FROM expense_submissions s
     WHERE employee_id=$1 AND status='approved' AND ${expInMonth('s','$2')}
     ORDER BY array_position(ARRAY['conveyance','outstation','misc']::text[], form_type), final_at`, [empId, month])).rows;
  const ot = (await q(`SELECT COALESCE(SUM(hours),0) AS hours, COALESCE(SUM(amount),0) AS amount
     FROM ot_entries o WHERE employee_id=$1 AND ${otInMonth('o','$2')}`, [empId, month])).rows[0];
  const byType = { conveyance: 0, outstation: 0, misc: 0 };
  claims.forEach(c => { byType[c.form_type] = (byType[c.form_type] || 0) + Number(c.total_amount); });
  const otAmt = Number(ot.amount || 0);
  const breakdown = [
    { label: 'Local Conveyance', amount: byType.conveyance },
    { label: 'Outstation', amount: byType.outstation },
    { label: 'Miscellaneous', amount: byType.misc },
    { label: 'Overtime', amount: otAmt },
  ].filter(b => b.amount > 0);
  const total = breakdown.reduce((s, b) => s + b.amount, 0);
  if (total <= 0) return null;

  const { buildCoverPdf, mergePdfs } = require('../lib/consolidated');
  const cover = await buildCoverPdf({ empName: emp.name, empNo: emp.emp_no, monthLabel: monthLabel(month), breakdown, total });
  const parts = [cover];
  const expense = require('./expense.routes');
  for (const c of claims) { const pdf = await expense._internal.claimPdfById(c.id); if (pdf) parts.push(pdf); }
  if (otAmt > 0) {
    const { buildPaymentReportPDF } = require('../lib/payment_pdf');
    parts.push(await buildPaymentReportPDF({
      title: `Overtime — ${emp.name}`, subtitle: monthLabel(month), approved: true,
      sections: [{ name: 'Overtime', total: otAmt, cols: [{ label: 'Name', width: 0.6 }, { label: 'Total hours', width: 0.2, align: 'right' }, { label: 'Amount', width: 0.2, align: 'right' }],
        rows: [[emp.name, (+ot.hours).toFixed(2), money(otAmt)]] }],
      grandTotal: otAmt,
    }));
  }
  return { pdf: await mergePdfs(parts), total, emp, breakdown };
}

// Run the monthly consolidation for a given month: one email per company (by emp_no prefix)
// with one consolidated PDF attachment per employee.
async function recordSent(period, empId, total, acct, by) {
  await q(`INSERT INTO payment_run_sent(period,employee_id,total,accounts_email,sent_by)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (period,employee_id) DO UPDATE SET total=EXCLUDED.total, accounts_email=EXCLUDED.accounts_email, sent_at=now(), sent_by=EXCLUDED.sent_by`,
    [period, empId, Math.round(total), acct, by || null]);
}

// One email per company (by emp_no prefix) with one consolidated PDF per employee.
// Employees already emailed for this month are skipped (no double-send).
async function runMonthlyAccounts(month, byName) {
  const chain = require('../lib/chain');
  const graph = require('../lib/graph');
  const cfg = await chain.getChain();
  const emps = (await q(
    `SELECT DISTINCT e.id, e.name, e.emp_no FROM employees e
     WHERE (EXISTS (SELECT 1 FROM expense_submissions s WHERE s.employee_id=e.id AND s.status='approved' AND ${expInMonth('s','$1')})
        OR EXISTS (SELECT 1 FROM ot_entries o WHERE o.employee_id=e.id AND ${otInMonth('o','$1')}))
       AND NOT EXISTS (SELECT 1 FROM payment_run_sent r WHERE r.period=$1 AND r.employee_id=e.id)
     ORDER BY e.emp_no`, [month])).rows;
  const byPrefix = {};
  for (const e of emps) { const pfx = String(e.emp_no || '').split('/')[0].toUpperCase() || 'BSC'; (byPrefix[pfx] = byPrefix[pfx] || []).push(e); }
  const sent = [];
  for (const pfx of Object.keys(byPrefix)) {
    const acct = chain.accountsEmailFor(cfg, pfx + '/x');
    if (!acct) continue;
    const attachments = []; const done = [];
    for (const e of byPrefix[pfx]) {
      const r = await buildEmployeeConsolidatedPdf(e.id, month);
      if (r) { attachments.push({ name: `${e.name.replace(/[^\w .-]/g, '')} - ${month}.pdf`, contentType: 'application/pdf', contentBytes: r.pdf.toString('base64') }); done.push({ id: e.id, total: r.total }); }
    }
    if (attachments.length) {
      await graph.sendMail({
        to: acct,
        subject: `Monthly payments — ${pfx} — ${monthLabel(month)} — ${attachments.length} employees`,
        html: `<p>Please find attached the consolidated monthly payment reports (one per employee) for <b>${pfx} — ${monthLabel(month)}</b>.</p><p>Kindly process the payments.</p>`,
        attachments,
      });
      for (const d of done) await recordSent(month, d.id, d.total, acct, byName || 'Monthly run');
      sent.push({ company: pfx, accounts: acct, employees: attachments.length });
    }
  }
  return { ok: true, month, sent };
}

router.post('/monthly-run', async (req, res) => {
  if (!(await isMgmt(req.user))) return res.status(403).json({ error: 'Management / admin only.' });
  const month = /^\d{4}-\d{2}$/.test(String(req.body.month || '')) ? req.body.month : prevMonth();
  try { res.json(await runMonthlyAccounts(month, req.user.name)); }
  catch (e) { console.error('[monthly-run]', e); res.status(500).json({ error: e.message }); }
});

// Late catch-up: send one employee's consolidated report on demand (after the 5th).
router.post('/send-employee', async (req, res) => {
  if (!(await isMgmt(req.user))) return res.status(403).json({ error: 'Management / admin only.' });
  const month = /^\d{4}-\d{2}$/.test(String(req.body.month || '')) ? req.body.month : prevMonth();
  const empId = +req.body.emp_id;
  const r = await buildEmployeeConsolidatedPdf(empId, month);
  if (!r) return res.status(400).json({ error: 'No approved payments for this employee in that month.' });
  const chain = require('../lib/chain');
const graph = require('../lib/graph'); const cfg = await chain.getChain();
  const acct = chain.accountsEmailFor(cfg, r.emp.emp_no);
  await graph.sendMail({
    to: acct,
    subject: `Payment report — ${r.emp.name} — ${monthLabel(month)} — ${money(r.total)}`,
    html: `<p>Consolidated payment report for <b>${r.emp.name} (${r.emp.emp_no})</b> — ${monthLabel(month)}. Kindly process.</p>`,
    attachments: [{ name: `${r.emp.name.replace(/[^\w .-]/g, '')} - ${month}.pdf`, contentType: 'application/pdf', contentBytes: r.pdf.toString('base64') }],
  });
  await recordSent(month, r.emp.id, r.total, acct, req.user.name);
  res.json({ ok: true, total: r.total, accounts: acct, emp: r.emp.name });
});

// Employees who have approved payments in a month (for the catch-up picker).
// Preview an employee's consolidated report (breakdown + each claim/OT) before it's emailed.
router.get('/employee-report/:empId/:month', async (req, res) => {
  if (!(await isMgmt(req.user))) return res.status(403).send('Not allowed');
  if (!/^\d{4}-\d{2}$/.test(req.params.month)) return res.status(400).send('Bad month');
  const r = await buildEmployeeConsolidatedPdf(+req.params.empId, req.params.month);
  if (!r) return res.status(404).send('No approved payments for this employee in that month.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${r.emp.name.replace(/[^\w .-]/g, '')} - ${req.params.month}.pdf"`);
  res.end(r.pdf);
});

router.get('/monthly-list', async (req, res) => {
  if (!(await isMgmt(req.user))) return res.status(403).json({ error: 'Management / admin only.' });
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : prevMonth();
  const rows = (await q(
    `SELECT e.id, e.name, e.emp_no,
       COALESCE((SELECT SUM(total_amount) FROM expense_submissions s WHERE s.employee_id=e.id AND s.status='approved' AND ${expInMonth('s','$1')}),0)
       + COALESCE((SELECT SUM(amount) FROM ot_entries o WHERE o.employee_id=e.id AND ${otInMonth('o','$1')}),0) AS total,
       (SELECT to_char(sent_at,'DD Mon HH24:MI') FROM payment_run_sent r WHERE r.period=$1 AND r.employee_id=e.id) AS sent_at
     FROM employees e
     WHERE EXISTS (SELECT 1 FROM expense_submissions s WHERE s.employee_id=e.id AND s.status='approved' AND ${expInMonth('s','$1')})
        OR EXISTS (SELECT 1 FROM ot_entries o WHERE o.employee_id=e.id AND ${otInMonth('o','$1')})
     ORDER BY (SELECT 1 FROM payment_run_sent r WHERE r.period=$1 AND r.employee_id=e.id) NULLS FIRST, e.emp_no`, [month])).rows;
  res.json({ month, employees: rows });
});

module.exports._internal = { runMonthlyAccounts, buildEmployeeConsolidatedPdf, prevMonth };
