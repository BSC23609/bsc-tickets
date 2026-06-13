const express = require('express');
const { q, pool } = require('../lib/db');
const auth = require('../lib/auth');
const graph = require('../lib/graph');
const wati = require('../lib/wati');
const excel = require('../lib/excel');
const { background } = require('../lib/bg');
const { nextRefNo, downtimeMins } = require('../lib/util');
const router = express.Router();

router.use(auth.requireAuth);

// ---- form metadata (categories, trades, locations, priorities) ----
router.get('/meta', async (req, res) => {
  const cats = (await q(
    `SELECT id,name,has_trades,wait_l1_l2_mins,wait_l2_l3_mins FROM categories
     WHERE active=TRUE ORDER BY sort_order,name`)).rows;
  const trades = (await q(
    `SELECT id,category_id,name FROM trades WHERE active=TRUE ORDER BY sort_order,name`)).rows;
  const locs = (await q('SELECT id,name FROM locations WHERE active=TRUE ORDER BY sort_order,name')).rows;
  res.json({ categories: cats, trades, locations: locs, priorities: ['Low','Medium','High','Critical'] });
});

// Resolve initial routing for a category by its pattern.
//  direct: straight to the single L1.   assign: to L2, who later assigns an L1.
async function resolveRoute(category_id) {
  const { rows } = await q('SELECT * FROM categories WHERE id=$1', [category_id]);
  const c = rows[0];
  if (!c) throw new Error('Unknown category');
  const direct = c.pattern === 'direct';
  return {
    pattern: direct ? 'direct' : 'assign',
    l1: direct ? c.l1_emp_id : null,   // assign starts unassigned until L2 picks
    l2: direct ? null : c.l2_emp_id,
    l3: direct ? null : c.l3_emp_id,
    category_name: c.name,
  };
}

async function empById(id) {
  if (!id) return null;
  const { rows } = await q('SELECT id,name,email,phone FROM employees WHERE id=$1', [id]);
  return rows[0] || null;
}

// ---- create ticket ----
router.post('/', async (req, res) => {
  const { category_id, trade_id, priority, subject, description, location_id } = req.body || {};
  if (!category_id || !subject) return res.status(400).json({ error: 'Category and subject are required' });
  const pri = ['Low','Medium','High','Critical'].includes(priority) ? priority : 'Medium';

  let route;
  try { route = await resolveRoute(category_id); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let locText = null;
  if (location_id) {
    const { rows } = await q('SELECT name FROM locations WHERE id=$1', [location_id]);
    locText = rows[0] ? rows[0].name : null;
  }

  const ref = await nextRefNo();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO tickets
        (ref_no,requester_id,category_id,trade_id,priority,subject,description,location_id,location_text,
         status,l1_emp_id,l2_emp_id,l3_emp_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11,$12) RETURNING *`,
      [ref, req.user.id, category_id, trade_id || null, pri, subject, description || null,
       location_id || null, locText, route.l1, route.l2, route.l3]
    );
    const t = ins.rows[0];
    await client.query(
      `INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'raised',$2,$3)`,
      [t.id, req.user.id, subject]);
    await client.query('COMMIT');
    res.json({ ok: true, id: t.id, ref_no: ref });

    // After responding: notify the initial recipient (L1 for direct, L2 for assign).
    background((async () => {
      const rec = await empById(route.pattern === 'direct' ? route.l1 : route.l2);
      const enriched = { ...t, category_name: route.category_name, requester_name: req.user.name };
      if (rec) await wati.notify.raised(rec, enriched);
      await excel.syncLogToOneDrive();
    })());
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('create ticket', e);
    res.status(500).json({ error: 'Could not create ticket' });
  } finally { client.release(); }
});

// ---- list (mine | assigned | all-for-admin) ----
router.get('/', async (req, res) => {
  const scope = req.query.scope || 'mine';
  const params = [];
  let where = '';
  if (scope === 'mine') { where = 'WHERE t.requester_id=$1'; params.push(req.user.id); }
  else if (scope === 'assigned') {
    where = 'WHERE $1 IN (t.l1_emp_id,t.l2_emp_id,t.l3_emp_id)'; params.push(req.user.id);
  } else if (scope === 'all') {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  }
  const { rows } = await q(
    `SELECT t.*, c.name AS category_name, tr.name AS trade_name,
            r.name AS requester_name, r.department AS requester_dept,
            l1.name AS l1_name
     FROM tickets t
     JOIN categories c ON c.id=t.category_id
     LEFT JOIN trades tr ON tr.id=t.trade_id
     JOIN employees r ON r.id=t.requester_id
     LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
     ${where}
     ORDER BY t.raised_at DESC LIMIT 500`, params);
  res.json(rows.map((t) => ({ ...t, downtime_mins: downtimeMins(t) })));
});

// ---- detail ----
router.get('/:id', async (req, res) => {
  const { rows } = await q(
    `SELECT t.*, c.name AS category_name, c.pattern,
            tr.name AS trade_name, r.name AS requester_name, r.department AS requester_dept, r.phone AS requester_phone,
            l1.name AS l1_name, l2.name AS l2_name, l3.name AS l3_name, ab.name AS assigned_by_name
     FROM tickets t
     JOIN categories c ON c.id=t.category_id
     LEFT JOIN trades tr ON tr.id=t.trade_id
     JOIN employees r ON r.id=t.requester_id
     LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
     LEFT JOIN employees l2 ON l2.id=t.l2_emp_id
     LEFT JOIN employees l3 ON l3.id=t.l3_emp_id
     LEFT JOIN employees ab ON ab.id=t.assigned_by_id
     WHERE t.id=$1`, [req.params.id]);
  const t = rows[0];
  if (!t) return res.status(404).json({ error: 'Not found' });

  const isRequester = t.requester_id === req.user.id;
  const isHandler = [t.l1_emp_id, t.l2_emp_id, t.l3_emp_id].includes(req.user.id);
  if (!isRequester && !isHandler && !req.user.is_admin)
    return res.status(403).json({ error: 'Not allowed' });

  const photos = (await q('SELECT id,kind,file_name,web_url FROM ticket_photos WHERE ticket_id=$1 ORDER BY id', [t.id])).rows;
  const events = (await q(
    `SELECT e.event,e.note,e.at,emp.name AS by_name FROM ticket_events e
     LEFT JOIN employees emp ON emp.id=e.by_emp_id WHERE e.ticket_id=$1 ORDER BY e.at`, [t.id])).rows;

  const isL2 = t.l2_emp_id === req.user.id;
  const isOpen = ['open', 'reopened', 'in_progress'].includes(t.status);
  const canAssign = (isL2 || req.user.is_admin) && t.pattern === 'assign' && isOpen;
  let pool = [];
  if (canAssign) {
    pool = (await q(
      `SELECT e.id, e.name FROM category_l1_pool p JOIN employees e ON e.id=p.emp_id
       WHERE p.category_id=$1 AND e.active=TRUE ORDER BY e.name`, [t.category_id])).rows;
  }

  res.json({ ...t, downtime_mins: downtimeMins(t), photos, events, pool,
    perms: { isRequester, isHandler, isAdmin: req.user.is_admin, isL2, canAssign } });
});

// ---- photos: mint upload session (browser uploads straight to OneDrive) ----
router.post('/:id/photo-session', async (req, res) => {
  const { rows } = await q('SELECT ref_no,requester_id FROM tickets WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  if (rows[0].requester_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'Not allowed' });
  const count = (await q('SELECT COUNT(*)::int n FROM ticket_photos WHERE ticket_id=$1 AND kind=$2',
    [req.params.id, req.body.kind || 'issue'])).rows[0].n;
  if (count >= 5) return res.status(400).json({ error: 'Maximum 5 photos' });
  const fileName = (req.body.file_name || `photo_${Date.now()}.jpg`).replace(/[^\w.\- ]/g, '_');
  const sess = await graph.createUploadSession(rows[0].ref_no, fileName);
  if (!sess) return res.status(503).json({ error: 'Photo storage not configured yet', skipped: true });
  res.json({ uploadUrl: sess.uploadUrl, file_name: fileName });
});

// ---- photos: record the uploaded file's metadata after client PUT completes ----
router.post('/:id/photo', async (req, res) => {
  const { kind, file_name, web_url, drive_item_id } = req.body || {};
  await q(`INSERT INTO ticket_photos(ticket_id,kind,file_name,web_url,drive_item_id)
           VALUES($1,$2,$3,$4,$5)`,
    [req.params.id, kind || 'issue', file_name, web_url, drive_item_id]);
  res.json({ ok: true });
});

// ---- helper to load a ticket + check handler/requester ----
async function loadTicket(id) {
  const { rows } = await q(
    `SELECT t.*, c.name AS category_name, r.name AS requester_name, r.email AS requester_email, r.phone AS requester_phone
     FROM tickets t JOIN categories c ON c.id=t.category_id JOIN employees r ON r.id=t.requester_id
     WHERE t.id=$1`, [id]);
  return rows[0] || null;
}
const isHandlerOf = (t, u) => [t.l1_emp_id, t.l2_emp_id, t.l3_emp_id].includes(u.id) || u.is_admin;

// ---- L2 assigns the ticket to an L1 from the category pool ----
router.post('/:id/assign', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.l2_emp_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'Only the L2 for this category can assign' });
  if (!['open', 'reopened', 'in_progress'].includes(t.status))
    return res.status(400).json({ error: 'Cannot assign in the current state' });
  const l1_emp_id = +(req.body && req.body.l1_emp_id) || null;
  if (!l1_emp_id) return res.status(400).json({ error: 'Pick an L1 handler' });
  const inPool = (await q('SELECT 1 FROM category_l1_pool WHERE category_id=$1 AND emp_id=$2',
    [t.category_id, l1_emp_id])).rows.length;
  if (!inPool && !req.user.is_admin) return res.status(400).json({ error: "That handler isn't in this category's L1 pool" });

  await q(`UPDATE tickets SET l1_emp_id=$2, assigned_at=now(), assigned_by_id=$3, last_reminder_at=NULL WHERE id=$1`,
    [t.id, l1_emp_id, req.user.id]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id) VALUES($1,'assigned',$2)`, [t.id, req.user.id]);
  res.json({ ok: true });
  background((async () => {
    const l1 = await empById(l1_emp_id);
    if (l1) await wati.notify.assigned(l1, { ...t, requester_name: t.requester_name });
    await excel.syncLogToOneDrive();
  })());
});

// ---- L1 marks In Progress ----
router.post('/:id/in-progress', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!isHandlerOf(t, req.user)) return res.status(403).json({ error: 'Handlers only' });
  if (!['open', 'reopened'].includes(t.status)) return res.status(400).json({ error: 'Not in an open state' });
  await q(`UPDATE tickets SET status='in_progress', in_progress_at=COALESCE(in_progress_at,now()) WHERE id=$1`, [t.id]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id) VALUES($1,'in_progress',$2)`, [t.id, req.user.id]);
  background(excel.syncLogToOneDrive());
  res.json({ ok: true });
});

// ---- handler resolves -> notify requester to confirm ----
router.post('/:id/resolve', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!isHandlerOf(t, req.user)) return res.status(403).json({ error: 'Handlers only' });
  if (!['open', 'in_progress', 'reopened'].includes(t.status))
    return res.status(400).json({ error: 'Cannot resolve from current state' });
  const note = (req.body && req.body.note) || null;
  await q(`UPDATE tickets SET status='resolved', resolved_at=now(), resolution_note=$2 WHERE id=$1`, [t.id, note]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'resolved',$2,$3)`,
    [t.id, req.user.id, note]);
  background(wati.notify.resolved({ name: t.requester_name, phone: t.requester_phone }, t, req.user.name));
  background(excel.syncLogToOneDrive());
  res.json({ ok: true });
});

// ---- requester confirms closure ----
router.post('/:id/confirm', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.requester_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'Requester only' });
  if (t.status !== 'resolved') return res.status(400).json({ error: 'Ticket is not awaiting confirmation' });
  await q(`UPDATE tickets SET status='closed', closed_at=now() WHERE id=$1`, [t.id]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id) VALUES($1,'confirmed_closed',$2)`, [t.id, req.user.id]);
  background(excel.syncLogToOneDrive());
  res.json({ ok: true });
});

// ---- requester reopens (not resolved) -> back to in_progress, notify L1 ----
router.post('/:id/reopen', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.requester_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'Requester only' });
  if (t.status !== 'resolved') return res.status(400).json({ error: 'Only a resolved ticket can be reopened' });
  const reason = (req.body && req.body.reason) || null;
  await q(`UPDATE tickets SET status='reopened', resolved_at=NULL WHERE id=$1`, [t.id]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'reopened',$2,$3)`,
    [t.id, req.user.id, reason]);
  const l1 = await empById(t.l1_emp_id);
  if (l1) background(wati.notify.reopened(l1, { ...t, requester_name: t.requester_name }));
  background(excel.syncLogToOneDrive());
  res.json({ ok: true });
});

module.exports = router;
