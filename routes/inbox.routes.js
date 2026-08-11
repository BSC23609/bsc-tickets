// Unified "Waiting for me" inbox — aggregates everything pending the logged-in user's action
// across tickets, outpass, expense and OT. Read-only; each item deep-links to the right screen.
const express = require('express');
const router = express.Router();
const { q } = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const chain = require('../lib/chain');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const uid = req.user.id;
  const admin = !!req.user.is_admin;
  const groups = [];

  // --- Tickets assigned to me, still open ---
  const tickets = (await q(
    `SELECT id, ref_no, subject, status FROM tickets
     WHERE $1 IN (l1_emp_id,l2_emp_id,l3_emp_id) AND status IN ('open','in_progress','reopened')
     ORDER BY raised_at DESC LIMIT 50`, [uid])).rows
    .map(t => ({ title: `${t.ref_no} · ${t.subject}`, subtitle: t.status.replace('_', ' '), url: `/app.html?t=${t.id}` }));
  if (tickets.length) groups.push({ key: 'tickets', label: 'Tickets', page: '/app.html', items: tickets });

  // --- Outpass / gatepass awaiting my approval ---
  const outpass = (await q(
    `SELECT id, ref_no, type, purpose FROM outpass_requests
     WHERE approver_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 50`, [uid])).rows
    .map(o => ({ title: `${o.ref_no} · ${o.type}`, subtitle: o.purpose || '', url: `/outpass.html?id=${o.id}` }));
  if (outpass.length) groups.push({ key: 'outpass', label: 'Gate / Outpass', page: '/outpass.html', items: outpass });

  // --- Expense claims awaiting my HR or final approval ---
  const c = await chain.getChain();
  const isHr = admin || (c.hr_approver_ids || []).includes(uid);
  const expense = [];
  if (isHr) {
    for (const e of (await q(`SELECT id, ref_no, form_type, total_amount FROM expense_submissions WHERE status='pending_hr' ORDER BY submitted_at DESC LIMIT 50`)).rows)
      expense.push({ title: `${e.ref_no} · ${e.form_type}`, subtitle: `With HR · ₹${e.total_amount || 0}`, url: `/expense.html?claim=${e.id}` });
  }
  for (const e of (await q(`SELECT id, ref_no, form_type, total_amount, final_approver_id FROM expense_submissions WHERE status='pending_final' ORDER BY submitted_at DESC LIMIT 50`)).rows)
    if (admin || e.final_approver_id === uid)
      expense.push({ title: `${e.ref_no} · ${e.form_type}`, subtitle: `Final approval · ₹${e.total_amount || 0}`, url: `/expense.html?claim=${e.id}` });
  if (expense.length) groups.push({ key: 'expense', label: 'Expense', page: '/expense.html', items: expense });

  // --- Overtime awaiting my approval (approver) or verification (HR) ---
  const s = Object.fromEntries((await q(
    `SELECT key,value FROM app_settings WHERE key IN ('ot_approver_production','ot_approver_dispatch','ot_hr_emp_id')`)).rows.map(r => [r.key, r.value]));
  const otApprover = admin || [s.ot_approver_production, s.ot_approver_dispatch].filter(Boolean).map(Number).includes(uid);
  const otHr = admin || (s.ot_hr_emp_id && Number(s.ot_hr_emp_id) === uid);
  const ot = [];
  if (otApprover) {
    const rows = (await q(
      `SELECT o.id, to_char(o.ot_date,'YYYY-MM-DD') AS d, o.amount, e.name FROM ot_entries o JOIN employees e ON e.id=o.employee_id
       WHERE o.status='pending' ${admin ? '' : 'AND o.approver_emp_id=$1'} ORDER BY o.ot_date DESC LIMIT 50`, admin ? [] : [uid])).rows;
    for (const r of rows) ot.push({ title: `OT approval · ${r.name}`, subtitle: `${r.d} · ₹${r.amount}`, url: `/ot.html` });
  }
  if (otHr) {
    const rows = (await q(
      `SELECT o.id, to_char(o.ot_date,'YYYY-MM-DD') AS d, o.amount, e.name FROM ot_entries o JOIN employees e ON e.id=o.employee_id
       WHERE o.status='approved' ORDER BY o.ot_date DESC LIMIT 50`)).rows;
    for (const r of rows) ot.push({ title: `OT verify · ${r.name}`, subtitle: `${r.d} · ₹${r.amount}`, url: `/ot.html` });
  }
  if (ot.length) groups.push({ key: 'ot', label: 'Overtime', page: '/ot.html', items: ot });

  res.json({ groups, total: groups.reduce((n, g) => n + g.items.length, 0) });
});

module.exports = router;
