const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const { downtimeMins } = require('../lib/util');
const excel = require('../lib/excel');
const router = express.Router();

router.use(auth.requireAuth, auth.requireAdmin);

// ===================== EMPLOYEES =====================
router.get('/employees', async (req, res) => {
  const { rows } = await q(
    `SELECT id,emp_no,name,email,phone,department,job_title,app_role,is_admin,active,must_reset
     FROM employees ORDER BY emp_no`);
  res.json(rows);
});

router.post('/employees', async (req, res) => {
  const { emp_no, name, email, phone, department, job_title, is_admin } = req.body || {};
  if (!emp_no || !name) return res.status(400).json({ error: 'Employee number and name required' });
  const hash = await auth.hashPw(process.env.DEFAULT_PASSWORD || 'Bsc@123');
  try {
    const { rows } = await q(
      `INSERT INTO employees(emp_no,name,email,phone,department,job_title,is_admin,password_hash,must_reset)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING id`,
      [String(emp_no).trim(), name, email || null, normPhone(phone), department || null,
       job_title || null, !!is_admin, hash]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Employee number already exists' });
    throw e;
  }
});

router.put('/employees/:id', async (req, res) => {
  const { name, email, phone, department, job_title, is_admin, active } = req.body || {};
  await q(
    `UPDATE employees SET name=COALESCE($2,name), email=$3, phone=$4,
       department=$5, job_title=$6, is_admin=COALESCE($7,is_admin), active=COALESCE($8,active)
     WHERE id=$1`,
    [req.params.id, name, email || null, normPhone(phone), department || null,
     job_title || null, is_admin, active]);
  res.json({ ok: true });
});

// Deactivate (soft) — preserves ticket history.
router.post('/employees/:id/deactivate', async (req, res) => {
  await q('UPDATE employees SET active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
router.post('/employees/:id/activate', async (req, res) => {
  await q('UPDATE employees SET active=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Admin password reset -> back to default + force change on next login.
router.post('/employees/:id/reset-password', async (req, res) => {
  const hash = await auth.hashPw(process.env.DEFAULT_PASSWORD || 'Bsc@123');
  await q('UPDATE employees SET password_hash=$1, must_reset=TRUE WHERE id=$2', [hash, req.params.id]);
  res.json({ ok: true, default_password: process.env.DEFAULT_PASSWORD || 'Bsc@123' });
});

function normPhone(p) {
  if (!p) return null;
  let d = String(p).replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  return d || null;
}

// ===================== LOCATIONS =====================
router.get('/locations', async (req, res) =>
  res.json((await q('SELECT * FROM locations ORDER BY sort_order,name')).rows));
router.post('/locations', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { rows } = await q('SELECT COALESCE(MAX(sort_order),0)+1 s FROM locations');
  await q('INSERT INTO locations(name,sort_order) VALUES($1,$2)', [name, rows[0].s]);
  res.json({ ok: true });
});
router.put('/locations/:id', async (req, res) => {
  const { name, active } = req.body || {};
  await q('UPDATE locations SET name=COALESCE($2,name), active=COALESCE($3,active) WHERE id=$1',
    [req.params.id, name, active]);
  res.json({ ok: true });
});

// ===================== CATEGORIES + TRADES + ROUTING =====================
router.get('/categories', async (req, res) => {
  const cats = (await q(`SELECT * FROM categories ORDER BY sort_order,name`)).rows;
  const trades = (await q(`SELECT * FROM trades ORDER BY sort_order,name`)).rows;
  res.json(cats.map((c) => ({ ...c, trades: trades.filter((t) => t.category_id === c.id) })));
});

router.post('/categories', async (req, res) => {
  const { name, has_trades, l1_emp_id, l2_emp_id, l3_emp_id, wait_l1_l2_mins, wait_l2_l3_mins } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { rows } = await q('SELECT COALESCE(MAX(sort_order),0)+1 s FROM categories');
  const r = await q(
    `INSERT INTO categories(name,has_trades,l1_emp_id,l2_emp_id,l3_emp_id,wait_l1_l2_mins,wait_l2_l3_mins,sort_order)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, !!has_trades, l1_emp_id || null, l2_emp_id || null, l3_emp_id || null,
     wait_l1_l2_mins || 120, wait_l2_l3_mins || 120, rows[0].s]);
  res.json({ ok: true, id: r.rows[0].id });
});

// Update routing + waits + activation for a category.
router.put('/categories/:id', async (req, res) => {
  const { name, has_trades, l1_emp_id, l2_emp_id, l3_emp_id, wait_l1_l2_mins, wait_l2_l3_mins, active } = req.body || {};
  await q(
    `UPDATE categories SET name=COALESCE($2,name), has_trades=COALESCE($3,has_trades),
       l1_emp_id=$4, l2_emp_id=$5, l3_emp_id=$6,
       wait_l1_l2_mins=COALESCE($7,wait_l1_l2_mins), wait_l2_l3_mins=COALESCE($8,wait_l2_l3_mins),
       active=COALESCE($9,active) WHERE id=$1`,
    [req.params.id, name, has_trades, l1_emp_id || null, l2_emp_id || null, l3_emp_id || null,
     wait_l1_l2_mins, wait_l2_l3_mins, active]);
  res.json({ ok: true });
});

router.post('/trades', async (req, res) => {
  const { category_id, name, l1_emp_id } = req.body || {};
  if (!category_id || !name) return res.status(400).json({ error: 'Category and name required' });
  const { rows } = await q('SELECT COALESCE(MAX(sort_order),0)+1 s FROM trades WHERE category_id=$1', [category_id]);
  await q('INSERT INTO trades(category_id,name,l1_emp_id,sort_order) VALUES($1,$2,$3,$4)',
    [category_id, name, l1_emp_id || null, rows[0].s]);
  res.json({ ok: true });
});
router.put('/trades/:id', async (req, res) => {
  const { name, l1_emp_id, active } = req.body || {};
  await q('UPDATE trades SET name=COALESCE($2,name), l1_emp_id=$3, active=COALESCE($4,active) WHERE id=$1',
    [req.params.id, name, l1_emp_id || null, active]);
  res.json({ ok: true });
});

// ===================== DASHBOARD =====================
router.get('/dashboard', async (req, res) => {
  const from = req.query.from || '2000-01-01';
  const to = req.query.to || '2999-01-01';
  const range = [from, to + ' 23:59:59'];

  const totals = (await q(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('open','in_progress','reopened'))::int AS open,
       COUNT(*) FILTER (WHERE status='resolved')::int AS resolved,
       COUNT(*) FILTER (WHERE status='closed')::int AS closed,
       COUNT(*) FILTER (WHERE escalation_level>0)::int AS escalated
     FROM tickets WHERE raised_at BETWEEN $1 AND $2`, range)).rows[0];

  const byCategory = (await q(
    `SELECT c.name AS category, COUNT(*)::int AS count,
            ROUND(AVG(EXTRACT(EPOCH FROM (t.closed_at - t.raised_at))/60)
                  FILTER (WHERE t.closed_at IS NOT NULL))::int AS avg_downtime_mins
     FROM tickets t JOIN categories c ON c.id=t.category_id
     WHERE t.raised_at BETWEEN $1 AND $2
     GROUP BY c.name ORDER BY count DESC`, range)).rows;

  const byPriority = (await q(
    `SELECT priority, COUNT(*)::int AS count FROM tickets
     WHERE raised_at BETWEEN $1 AND $2 GROUP BY priority`, range)).rows;

  const avgAll = (await q(
    `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (closed_at - raised_at))/60))::int AS m
     FROM tickets WHERE closed_at IS NOT NULL AND raised_at BETWEEN $1 AND $2`, range)).rows[0].m;

  const recent = (await q(
    `SELECT t.id,t.ref_no,t.subject,t.status,t.priority,t.escalation_level,t.raised_at,t.closed_at,
            c.name AS category_name, r.name AS requester_name, l1.name AS l1_name
     FROM tickets t JOIN categories c ON c.id=t.category_id JOIN employees r ON r.id=t.requester_id
     LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
     WHERE t.raised_at BETWEEN $1 AND $2 ORDER BY t.raised_at DESC LIMIT 200`, range)).rows;

  res.json({
    totals, byCategory, byPriority, avg_downtime_mins: avgAll,
    recent: recent.map((t) => ({ ...t, downtime_mins: downtimeMins(t) })),
  });
});

// ===================== EXCEL EXPORT (on demand) =====================
router.get('/export.xlsx', async (req, res) => {
  try {
    const buf = await excel.buildWorkbookBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Ticket Log.xlsx"');
    res.send(buf);
  } catch (e) { console.error('export', e); res.status(500).json({ error: 'Export failed' }); }
});

module.exports = router;
