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
const ocr = require('../lib/canteen_ocr');

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

// ---- One saved entry: edit (qty / amount / date) or delete — used by the Entries tab ----
// Changing the date moves the entry; if that item is already entered on the new date the two
// are added together (two bills for the same item on one day), never silently overwritten.
router.put('/entry', async (req, res) => {
  const b = req.body || {};
  const id = Number(b.item_id), qty = toNum(b.qty), amount = toNum(b.amount);
  const newDate = b.new_date || b.date;
  if (!C.isDate(b.date) || !C.isDate(newDate)) return res.status(400).json({ error: 'Pick a valid date' });
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown item' });
  if (qty == null || amount == null) return res.status(400).json({ error: 'Quantity and amount must be numbers of 0 or more' });
  if (!qty && !amount) return res.status(400).json({ error: 'Quantity and amount are both 0. Use Delete to remove the entry.' });
  const client = await pool.connect();
  let merged = false;
  try {
    await client.query('BEGIN');
    const old = (await client.query(`DELETE FROM canteen_entries WHERE entry_date=$1 AND item_id=$2 RETURNING 1`, [b.date, id])).rowCount;
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'That entry no longer exists. Reload the list.' }); }
    const r = await client.query(
      `INSERT INTO canteen_entries (entry_date,item_id,qty,amount,updated_by,updated_by_name,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (entry_date,item_id) DO UPDATE SET qty=canteen_entries.qty+EXCLUDED.qty,
         amount=canteen_entries.amount+EXCLUDED.amount, updated_by=EXCLUDED.updated_by,
         updated_by_name=EXCLUDED.updated_by_name, updated_at=now()
       RETURNING (xmax <> 0) AS merged`, [newDate, id, qty, amount, req.user.id, req.user.name]);
    merged = r.rows[0].merged;
    if (qty > 0 && amount > 0) await client.query(`UPDATE canteen_items SET rate=$2 WHERE id=$1`, [id, Math.round(amount / qty * 100) / 100]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[canteen entry edit]', e.message);
    return res.status(500).json({ error: 'Could not save the change. Nothing was changed.' });
  } finally { client.release(); }
  syncLog();
  res.json({ ok: true, merged });
});

router.delete('/entry', async (req, res) => {
  const d = req.query.date, id = Number(req.query.item_id);
  if (!C.isDate(d) || !Number.isInteger(id)) return res.status(400).json({ error: 'Bad entry' });
  const n = (await q(`DELETE FROM canteen_entries WHERE entry_date=$1 AND item_id=$2`, [d, id])).rowCount;
  if (!n) return res.status(404).json({ error: 'That entry no longer exists. Reload the list.' });
  console.log(`[canteen entry delete] ${req.user.name}: item ${id} on ${d}`);
  syncLog();
  res.json({ ok: true });
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

// ======================= Bill-photo upload → OCR → entries =======================
// A photo of a canteen bill (plain item-name + qty + amount, no QR) is read by Claude vision
// into lines, each matched to an item in the master. Nothing is saved until the user reviews
// the lines and hits Save (which reuses PUT /entries). A photo can also be parked for later.

// Match each OCR'd line to a master item by normalised name; unknown -> status 'new'.
async function matchLines(lines) {
  const items = (await q(`SELECT id, name FROM canteen_items WHERE hidden=FALSE`)).rows;
  const byName = new Map(items.map((i) => [i.name, i.id]));          // names stored already normalised
  return (lines || []).map((l) => {
    const norm = C.normName(l.name) || String(l.name || '').trim();
    let item_id = byName.get(norm) || null;
    if (!item_id && norm.length >= 3) {                              // loose contains match as a fallback
      const hit = items.find((i) => i.name.includes(norm) || norm.includes(i.name));
      if (hit) item_id = hit.id;
    }
    return { name: norm, qty: l.qty, amount: l.amount, item_id, status: item_id ? 'matched' : 'new' };
  });
}

// Best-effort OneDrive audit copy of the photo, in the background (never blocks the response).
function storePhoto(dataUrl, ref) {
  background((async () => {
    try {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(dataUrl || ''); if (!m) return;
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      await require('../lib/graph').uploadCanteenPhoto(`${ref}.${ext}`, Buffer.from(m[2], 'base64'), m[1]);
    } catch (e) { console.error('[canteen photo store]', e.message); }
  })());
}

// Read a bill photo NOW — return the parsed, item-matched lines for review. Saves nothing.
router.post('/ocr-photo', async (req, res) => {
  const image = (req.body && req.body.image) || '';
  if (!/^data:image\//.test(image)) return res.status(400).json({ error: 'Please choose a photo to read.' });
  if (image.length > 1500000) return res.status(413).json({ error: 'That photo is too large — please retake it.' });
  let result;
  try { result = await ocr.readBill(image); }
  catch (e) { return res.status(502).json({ error: e.message }); }
  if (!result.lines.length) return res.status(422).json({ error: 'No item lines could be read. Please try a clearer, straight-on photo.' });
  storePhoto(image, 'bill-' + Date.now());
  res.json({ date: result.date, lines: await matchLines(result.lines) });
});

// Park a bill photo for LATER — stored pending, no entries yet; read & posted from Pending bills.
router.post('/photo-later', async (req, res) => {
  const image = (req.body && req.body.image) || '';
  const note = String((req.body && req.body.note) || '').slice(0, 300);
  if (!/^data:image\//.test(image)) return res.status(400).json({ error: 'Please choose a photo.' });
  if (image.length > 1500000) return res.status(413).json({ error: 'That photo is too large — please retake it.' });
  const { rows } = await q(
    `INSERT INTO canteen_uploads (status, note, image_b64, uploaded_by, uploaded_by_name)
     VALUES ('pending',$1,$2,$3,$4) RETURNING id`,
    [note || null, image, req.user.id, req.user.name]);
  storePhoto(image, 'bill-' + rows[0].id);
  res.json({ ok: true, id: rows[0].id });
});

// Bills waiting to be read/posted (newest first).
router.get('/uploads', async (req, res) => {
  const { rows } = await q(
    `SELECT id, status, note, drive_url, uploaded_by_name,
            to_char(created_at AT TIME ZONE 'Asia/Kolkata','DD Mon, HH12:MI AM') AS when
       FROM canteen_uploads WHERE status IN ('pending','parsed') ORDER BY created_at DESC LIMIT 100`);
  res.json({ uploads: rows });
});

// Read a parked bill now — OCR its stored photo, return matched lines for review.
router.post('/uploads/:id/ocr', async (req, res) => {
  const id = Number(req.params.id);
  const row = (await q(`SELECT image_b64 FROM canteen_uploads WHERE id=$1`, [id])).rows[0];
  if (!row || !row.image_b64) return res.status(404).json({ error: 'That upload is no longer available.' });
  let result;
  try { result = await ocr.readBill(row.image_b64); }
  catch (e) { return res.status(502).json({ error: e.message }); }
  await q(`UPDATE canteen_uploads SET status='parsed', parsed_json=$2, updated_at=now() WHERE id=$1`,
    [id, JSON.stringify({ date: result.date, lines: result.lines })]);
  res.json({ date: result.date, lines: await matchLines(result.lines) });
});

// Mark a parked bill done once its entries are saved (frees the stored photo).
router.post('/uploads/:id/done', async (req, res) => {
  const id = Number(req.params.id);
  const d = req.body && req.body.date;
  await q(`UPDATE canteen_uploads SET status='posted', image_b64=NULL, posted_date=$2, updated_at=now() WHERE id=$1`,
    [id, C.isDate(d) ? d : null]);
  res.json({ ok: true });
});

// Discard a parked bill without posting.
router.delete('/uploads/:id', async (req, res) => {
  await q(`DELETE FROM canteen_uploads WHERE id=$1 AND status<>'posted'`, [Number(req.params.id)]);
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
  // Three bulk statements (not ~1,200 single inserts): on Vercel every query is a network round
  // trip to Neon, and row-by-row inserts ran past the function time limit.
  const t0 = Date.now();
  const client = await pool.connect();
  let items = 0, entries = 0, cook = 0;
  try {
    await client.query('BEGIN');
    const I = seed.items;
    items = (await client.query(
      `INSERT INTO canteen_items (name, category, rate, sort_order)
       SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::int[])
       ON CONFLICT (name) DO NOTHING`,
      [I.map((i) => i.name), I.map((i) => i.category), I.map((i) => i.rate || 0), I.map((i) => i.sort_order || 0)])).rowCount;
    const E = seed.entries;
    entries = (await client.query(
      `INSERT INTO canteen_entries (entry_date, item_id, qty, amount, updated_by_name)
       SELECT s.d::date, i.id, s.q, s.a, 'Imported from Canteen_MIS.xlsx'
         FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[]) AS s(d, n, q, a)
         JOIN canteen_items i ON i.name = s.n
       ON CONFLICT (entry_date, item_id) DO NOTHING`,
      [E.map((e) => e[0]), E.map((e) => e[1]), E.map((e) => e[2]), E.map((e) => e[3])])).rowCount;
    const K = Object.entries(seed.cook || {});
    if (K.length) cook = (await client.query(
      `INSERT INTO canteen_cook_salary (month, amount)
       SELECT * FROM unnest($1::text[], $2::numeric[]) ON CONFLICT (month) DO NOTHING`,
      [K.map((k) => k[0]), K.map((k) => k[1])])).rowCount;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[canteen import]', e);
    return res.status(500).json({ error: 'Import failed: ' + e.message });
  } finally { client.release(); }
  console.log(`[canteen import] items ${items}, entries ${entries}, cook ${cook} in ${Date.now() - t0} ms`);
  syncLog();
  res.json({ ok: true, items, entries, cook_months: cook });
});

module.exports = router;
