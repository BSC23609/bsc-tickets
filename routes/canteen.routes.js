// Canteen register — restricted app 'canteen' (granted per employee in Admin → Employees → App access;
// admins always have it). Daily purchases are entered against an item list; the monthly print sheet,
// the category summary and the OneDrive "Canteen Log.xlsx" are all built from canteen_entries.
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { q, pool } = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { appAccessFor } = require('../lib/apps');
const { background } = require('../lib/bg');
const C = require('../lib/canteen');

router.use(requireAuth);
router.use((req, res, next) => {
  if (appAccessFor(req.user).canteen) return next();
  res.status(403).json({ error: 'You do not have access to the Canteen Register. Ask an admin to grant it.' });
});

const syncLog = () => background(require('../lib/canteen_excel').syncCanteenLog());
const toNum = (v) => { const n = Number(v); return isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : null; };

// Items, categories and the store name. `uses` (days used in the last 120 days) orders the daily list.
router.get('/bootstrap', async (req, res) => {
  const items = (await q(
    `SELECT i.id, i.name, i.category, i.rate, i.sort_order, i.hidden,
            (SELECT COUNT(*)::int FROM canteen_entries e WHERE e.item_id=i.id
               AND e.entry_date > CURRENT_DATE - 120) AS uses
       FROM canteen_items i ORDER BY i.sort_order, i.name`)).rows
    .map((r) => ({ ...r, rate: C.num(r.rate) }));
  const categories = (await q(`SELECT name FROM canteen_categories ORDER BY sort_order, name`)).rows.map((r) => r.name);
  const hasData = (await q(`SELECT EXISTS(SELECT 1 FROM canteen_entries) AS x`)).rows[0].x;
  res.json({ items, categories, store: await C.storeName(), is_admin: !!req.user.is_admin, has_data: hasData,
    onedrive: require('../lib/graph').configured() });
});

// Entries between two dates (inclusive, max ~2 months) -> { 'YYYY-MM-DD': { item_id: [qty, amount] } }
router.get('/entries', async (req, res) => {
  const { from, to } = req.query;
  if (!C.isDate(from) || !C.isDate(to) || to < from) return res.status(400).json({ error: 'Pick a valid date range' });
  const { rows } = await q(
    `SELECT to_char(entry_date,'YYYY-MM-DD') AS d, item_id, qty, amount FROM canteen_entries
      WHERE entry_date BETWEEN $1 AND $2 AND entry_date <= $1::date + 92`, [from, to]);
  const out = {};
  for (const r of rows) (out[r.d] = out[r.d] || {})[r.item_id] = [C.num(r.qty), C.num(r.amount)];
  res.json(out);
});

// Day + month running totals for the header chips.
router.get('/totals', async (req, res) => {
  const d = req.query.date;
  if (!C.isDate(d)) return res.status(400).json({ error: 'Bad date' });
  const [from, to] = C.monthBounds(d.slice(0, 7));
  const r = (await q(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE entry_date=$1),0) AS day,
            COALESCE(SUM(amount),0) AS month
       FROM canteen_entries WHERE entry_date BETWEEN $2 AND $3`, [d, from, to])).rows[0];
  res.json({ day: C.num(r.day), month: C.num(r.month) });
});

// The most recent earlier day (within 31 days) that has entries — for "Copy last day".
router.get('/last-day', async (req, res) => {
  const d = req.query.before;
  if (!C.isDate(d)) return res.status(400).json({ error: 'Bad date' });
  const r = (await q(
    `SELECT to_char(MAX(entry_date),'YYYY-MM-DD') AS d FROM canteen_entries
      WHERE entry_date < $1 AND entry_date >= $1::date - 31`, [d])).rows[0];
  if (!r.d) return res.json({ date: null, lines: {} });
  const lines = {};
  (await q(`SELECT item_id, qty, amount FROM canteen_entries WHERE entry_date=$1`, [r.d])).rows
    .forEach((x) => { lines[x.item_id] = [C.num(x.qty), C.num(x.amount)]; });
  res.json({ date: r.d, lines });
});

// Save lines to one or many dates. Each line replaces that item on those dates; qty and amount
// both 0 removes it. Body: { dates: ['YYYY-MM-DD', ...], lines: [{ item_id, qty, amount }] }
router.put('/entries', async (req, res) => {
  const b = req.body || {};
  const dates = [...new Set(Array.isArray(b.dates) ? b.dates : [])];
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!dates.length || dates.some((d) => !C.isDate(d))) return res.status(400).json({ error: 'Pick at least one valid date' });
  if (dates.length > 62) return res.status(400).json({ error: 'Save up to 62 days at a time' });
  if (!lines.length || lines.length > 300) return res.status(400).json({ error: 'Nothing to save' });
  const clean = [];
  for (const l of lines) {
    const id = Number(l.item_id), qty = toNum(l.qty), amount = toNum(l.amount);
    if (!Number.isInteger(id) || qty == null || amount == null) return res.status(400).json({ error: 'Quantity and amount must be numbers of 0 or more' });
    clean.push({ id, qty, amount });
  }
  const ids = clean.map((l) => l.id);
  const known = (await q(`SELECT id FROM canteen_items WHERE id = ANY($1::int[])`, [ids])).rows.map((r) => r.id);
  if (known.length !== new Set(ids).size) return res.status(400).json({ error: 'One of the items no longer exists. Reload the page.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const d of dates) {
      for (const l of clean) {
        if (!l.qty && !l.amount) {
          await client.query(`DELETE FROM canteen_entries WHERE entry_date=$1 AND item_id=$2`, [d, l.id]);
        } else {
          await client.query(
            `INSERT INTO canteen_entries (entry_date,item_id,qty,amount,updated_by,updated_by_name,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,now())
             ON CONFLICT (entry_date,item_id) DO UPDATE SET qty=EXCLUDED.qty, amount=EXCLUDED.amount,
               updated_by=EXCLUDED.updated_by, updated_by_name=EXCLUDED.updated_by_name, updated_at=now()`,
            [d, l.id, l.qty, l.amount, req.user.id, req.user.name]);
        }
      }
    }
    // Remember the latest unit price so the next entry pre-fills the amount.
    for (const l of clean) if (l.qty > 0 && l.amount > 0)
      await client.query(`UPDATE canteen_items SET rate=$2 WHERE id=$1`, [l.id, Math.round(l.amount / l.qty * 100) / 100]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[canteen save]', e.message);
    return res.status(500).json({ error: 'Could not save. Please try again.' });
  } finally { client.release(); }
  syncLog();
  res.json({ ok: true, saved: dates.length * clean.length });
});

// ---- Items ----
router.post('/items', async (req, res) => {
  const name = C.normName(req.body && req.body.name);
  const category = String((req.body && req.body.category) || 'OTHER').trim().toUpperCase();
  const rate = toNum(req.body && req.body.rate) || 0;
  if (!name) return res.status(400).json({ error: 'Type the item name' });
  if (name.length > 120) return res.status(400).json({ error: 'Item name is too long' });
  const cat = (await q(`SELECT 1 FROM canteen_categories WHERE name=$1`, [category])).rows[0];
  if (!cat) return res.status(400).json({ error: 'Pick a category from the list' });
  const dup = (await q(`SELECT id, hidden FROM canteen_items WHERE name=$1`, [name])).rows[0];
  if (dup) {
    if (dup.hidden) await q(`UPDATE canteen_items SET hidden=FALSE WHERE id=$1`, [dup.id]);
    return res.json({ id: dup.id, existed: true });
  }
  const so = (await q(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM canteen_items`)).rows[0].n;
  const { rows } = await q(`INSERT INTO canteen_items (name,category,rate,sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
    [name, category, rate, so]);
  syncLog();
  res.json({ id: rows[0].id });
});

router.put('/items/:id', async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [Number(req.params.id)];
  if (b.category !== undefined) {
    const category = String(b.category).trim().toUpperCase();
    if (!(await q(`SELECT 1 FROM canteen_categories WHERE name=$1`, [category])).rows[0]) return res.status(400).json({ error: 'Unknown category' });
    params.push(category); sets.push(`category=$${params.length}`);
  }
  if (b.rate !== undefined) { const r = toNum(b.rate); if (r == null) return res.status(400).json({ error: 'Rate must be a number' }); params.push(r); sets.push(`rate=$${params.length}`); }
  if (b.hidden !== undefined) { params.push(!!b.hidden); sets.push(`hidden=$${params.length}`); }
  if (b.name !== undefined) {
    const name = C.normName(b.name); if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    params.push(name); sets.push(`name=$${params.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  try { await q(`UPDATE canteen_items SET ${sets.join(', ')} WHERE id=$1`, params); }
  catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Another item already has that name' });
    console.error('[canteen item update]', e.message); return res.status(500).json({ error: 'Could not save the item' });
  }
  syncLog();
  res.json({ ok: true });
});

// ---- Print ----
router.get('/months', async (req, res) => {
  const { rows } = await q(`SELECT DISTINCT to_char(entry_date,'YYYY-MM') AS m FROM canteen_entries ORDER BY 1 DESC`);
  res.json(rows.map((r) => r.m));
});
router.get('/print', async (req, res) => {
  if (!C.isMonth(req.query.month)) return res.status(400).json({ error: 'Pick a month' });
  res.json(await C.printModel(req.query.month));
});
router.get('/print.pdf', async (req, res) => {
  if (!C.isMonth(req.query.month)) return res.status(400).send('Pick a month');
  const model = await C.printModel(req.query.month);
  const pdf = await require('../lib/canteen_pdf').buildCanteenPdf(model);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Canteen ${model.label}.pdf"`);
  res.send(pdf);
});

// ---- Summary + cook salary ----
router.get('/summary', async (req, res) => {
  const y = /^\d{4}$/.test(req.query.year || '') ? req.query.year : new Date().getFullYear();
  const years = (await q(`SELECT DISTINCT to_char(entry_date,'YYYY') AS y FROM canteen_entries
                          UNION SELECT substr(month,1,4) FROM canteen_cook_salary ORDER BY 1 DESC`)).rows.map((r) => r.y);
  res.json({ ...(await C.yearSummary(y)), years });
});
router.put('/cook/:month', async (req, res) => {
  if (!C.isMonth(req.params.month)) return res.status(400).json({ error: 'Bad month' });
  const amt = toNum(req.body && req.body.amount);
  if (amt == null) return res.status(400).json({ error: 'Amount must be a number' });
  await q(`INSERT INTO canteen_cook_salary(month,amount) VALUES($1,$2) ON CONFLICT(month) DO UPDATE SET amount=EXCLUDED.amount`,
    [req.params.month, amt]);
  syncLog();
  res.json({ ok: true });
});

// ---- Excel ----
router.get('/log.xlsx', async (req, res) => {
  const buf = await require('../lib/canteen_excel').buildCanteenWorkbook();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Canteen Log.xlsx"');
  res.send(buf);
});
router.post('/sync', requireAdmin, async (req, res) => {
  const ok = await require('../lib/canteen_excel').syncCanteenLog();
  res.json({ ok: !!ok, onedrive: require('../lib/graph').configured() });
});

// ---- One-time import of the Jan–Sep 2026 history from the old Canteen_MIS.xlsx (admin only) ----
// Reads db/canteen_seed.json. Safe to run twice: existing items/entries are left untouched.
router.post('/import-seed', requireAdmin, async (req, res) => {
  const file = path.join(__dirname, '..', 'db', 'canteen_seed.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No seed file in this deployment' });
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = await pool.connect();
  let items = 0, entries = 0, cook = 0;
  try {
    await client.query('BEGIN');
    for (const it of seed.items) {
      const r = await client.query(
        `INSERT INTO canteen_items (name,category,rate,sort_order,hidden) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (name) DO NOTHING RETURNING id`, [it.name, it.category, it.rate || 0, it.sort_order || 0, !!it.hidden]);
      items += r.rowCount;
    }
    const idOf = {};
    (await client.query(`SELECT id, name FROM canteen_items`)).rows.forEach((r) => { idOf[r.name] = r.id; });
    for (const [d, name, qty, amount] of seed.entries) {
      if (!idOf[name]) continue;
      const r = await client.query(
        `INSERT INTO canteen_entries (entry_date,item_id,qty,amount,updated_by_name)
         VALUES ($1,$2,$3,$4,'Imported from Canteen_MIS.xlsx') ON CONFLICT (entry_date,item_id) DO NOTHING`,
        [d, idOf[name], qty, amount]);
      entries += r.rowCount;
    }
    for (const [m, amt] of Object.entries(seed.cook || {})) {
      const r = await client.query(`INSERT INTO canteen_cook_salary(month,amount) VALUES($1,$2) ON CONFLICT(month) DO NOTHING`, [m, amt]);
      cook += r.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[canteen import]', e);
    return res.status(500).json({ error: 'Import failed: ' + e.message });
  } finally { client.release(); }
  syncLog();
  res.json({ ok: true, items, entries, cook_months: cook });
});

module.exports = router;
