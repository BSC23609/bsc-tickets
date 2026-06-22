const express = require('express');
const router = express.Router();
const { q } = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { appAccessFor } = require('../lib/apps');

const OIL = ['OK', 'Low', 'Topped up'];

router.use(requireAuth);
// Module gate — needs the 'genset' app grant (admins always allowed).
router.use((req, res, next) => {
  if (appAccessFor(req.user).genset) return next();
  res.status(403).json({ error: 'You do not have access to the Genset Log.' });
});

// List gensets. Active only by default; admins can pass ?all=1 to manage.
// Includes each genset's last Stop reading so the form can pre-fill the next Start.
router.get('/gensets', async (req, res) => {
  const showAll = req.query.all === '1' && req.user.is_admin;
  const { rows } = await q(
    `SELECT g.id, g.name, g.kva, g.active,
            (SELECT gl.stop_hrs FROM genset_logs gl WHERE gl.genset_id=g.id
              ORDER BY gl.log_date DESC, gl.id DESC LIMIT 1) AS last_stop
       FROM gensets g
      ${showAll ? '' : 'WHERE g.active=TRUE'}
      ORDER BY g.sort_order, g.name`);
  res.json(rows);
});

// History (filter by genset + date range), newest first.
router.get('/logs', async (req, res) => {
  const params = []; const where = [];
  if (req.query.genset_id) { params.push(+req.query.genset_id); where.push(`gl.genset_id=$${params.length}`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { params.push(req.query.from); where.push(`gl.log_date>=$${params.length}`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { params.push(req.query.to); where.push(`gl.log_date<=$${params.length}`); }
  const { rows } = await q(
    `SELECT gl.*, g.name AS genset_name, g.kva
       FROM genset_logs gl JOIN gensets g ON g.id=gl.genset_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY gl.log_date DESC, gl.id DESC
      LIMIT 300`, params);
  res.json(rows);
});

// Record one genset session. Running time is computed; Sign = the logged-in person.
router.post('/logs', async (req, res) => {
  const b = req.body || {};
  const gid = +b.genset_id;
  const start = parseFloat(b.start_hrs), stop = parseFloat(b.stop_hrs);
  if (!gid) return res.status(400).json({ error: 'Pick a genset' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.log_date || '')) return res.status(400).json({ error: 'Pick a date' });
  if (!isFinite(start) || !isFinite(stop)) return res.status(400).json({ error: 'Enter the start and stop hour-meter readings' });
  if (stop < start) return res.status(400).json({ error: 'Stop reading cannot be less than the start reading' });
  const g = (await q('SELECT id FROM gensets WHERE id=$1 AND active=TRUE', [gid])).rows[0];
  if (!g) return res.status(400).json({ error: 'Unknown or inactive genset' });
  const eOil = OIL.includes(b.e_oil) ? b.e_oil : null;
  const cOil = OIL.includes(b.c_oil) ? b.c_oil : null;
  const fuel = (b.fuel_added === '' || b.fuel_added == null) ? null : parseFloat(b.fuel_added);
  const load = (b.load_pct === '' || b.load_pct == null) ? null : parseFloat(b.load_pct);
  const running = Math.round((stop - start) * 10) / 10;
  await q(
    `INSERT INTO genset_logs
       (genset_id, log_date, start_hrs, stop_hrs, running_hrs, fuel_added, load_pct, e_oil, c_oil, remarks, recorded_by, recorded_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [gid, b.log_date, start, stop, running,
     (fuel != null && isFinite(fuel)) ? fuel : null,
     (load != null && isFinite(load)) ? load : null,
     eOil, cOil, (b.remarks || '').trim() || null, req.user.id, req.user.name]);
  res.json({ ok: true, running_hrs: running });
});

// ---- Admin: manage the genset list (add / rename / kVA / activate-deactivate) ----
router.post('/gensets', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const kva = (req.body.kva || '').trim() || null;
  const so = (await q('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM gensets')).rows[0].n;
  const { rows } = await q('INSERT INTO gensets (name, kva, sort_order) VALUES ($1,$2,$3) RETURNING id', [name, kva, so]);
  res.json({ id: rows[0].id });
});
router.put('/gensets/:id', requireAdmin, async (req, res) => {
  const name = req.body.name !== undefined ? (String(req.body.name).trim() || null) : null;
  const kva = req.body.kva !== undefined ? (String(req.body.kva).trim() || null) : null;
  const active = req.body.active === undefined ? null : !!req.body.active;
  await q('UPDATE gensets SET name=COALESCE($2,name), kva=COALESCE($3,kva), active=COALESCE($4,active) WHERE id=$1',
    [req.params.id, name, kva, active]);
  res.json({ ok: true });
});

module.exports = router;
