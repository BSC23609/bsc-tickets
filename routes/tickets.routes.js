const express = require('express');
const { q, pool } = require('../lib/db');
const auth = require('../lib/auth');
const graph = require('../lib/graph');
const wati = require('../lib/wati');
const { nextRefNo, escalationState, downtimeMins } = require('../lib/util');
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

// Resolve the L1/L2/L3 assignment for a category (+trade).
async function resolveRoute(category_id, trade_id) {
  const { rows } = await q('SELECT * FROM categories WHERE id=$1', [category_id]);
  const c = rows[0];
  if (!c) throw new Error('Unknown category');
  let l1 = c.l1_emp_id;
  if (c.has_trades) {
    const { rows: tr } = await q('SELECT * FROM trades WHERE id=$1 AND category_id=$2', [trade_id, category_id]);
    if (!tr.length) throw new Error('Trade required for this category');
    l1 = tr[0].l1_emp_id;
  }
  return {
    l1, l2: c.l2_emp_id, l3: c.l3_emp_id,
    waits: { wait_l1_l2_mins: c.wait_l1_l2_mins, wait_l2_l3_mins: c.wait_l2_l3_mins },
    category_name: c.name, has_trades: c.has_trades,
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
  try { route = await resolveRoute(category_id, trade_id || null); }
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

    // Fire-and-forget notifications + log (never block the response).
    const l1 = await empById(route.l1);
    const enriched = { ...t, category_name: route.category_name, requester_name: req.user.name };
    if (l1) wati.notify.raised(l1, enriched).catch(() => {});
    graph.appendLogRow([
      ref, new Date(t.raised_at).toLocaleString('en-IN'), req.user.name, req.user.department,
      route.category_name, '', pri, locText || '', subject, 'open', '0',
      l1 ? l1.name : '', '', '', '', '', '', '',
    ]).catch(() => {});

    res.json({ ok: true, id: t.id, ref_no: ref });
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
    `SELECT t.*, c.name AS category_name, c.has_trades, c.wait_l1_l2_mins, c.wait_l2_l3_mins,
            tr.name AS trade_name, r.name AS requester_name, r.department AS requester_dept, r.phone AS requester_phone,
            l1.name AS l1_name, l2.name AS l2_name, l3.name AS l3_name
     FROM tickets t
     JOIN categories c ON c.id=t.category_id
     LEFT JOIN trades tr ON tr.id=t.trade_id
     JOIN employees r ON r.id=t.requester_id
     LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
     LEFT JOIN employees l2 ON l2.id=t.l2_emp_id
     LEFT JOIN employees l3 ON l3.id=t.l3_emp_id
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
  const esc = escalationState(t, { wait_l1_l2_mins: t.wait_l1_l2_mins, wait_l2_l3_mins: t.wait_l2_l3_mins });

  res.json({ ...t, downtime_mins: downtimeMins(t), photos, events,
    perms: { isRequester, isHandler, isAdmin: req.user.is_admin }, escalation: esc });
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

// ---- L1 marks In Progress ----
router.post('/:id/in-progress', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!isHandlerOf(t, req.user)) return res.status(403).json({ error: 'Handlers only' });
  if (!['open', 'reopened'].includes(t.status)) return res.status(400).json({ error: 'Not in an open state' });
  await q(`UPDATE tickets SET status='in_progress', in_progress_at=COALESCE(in_progress_at,now()) WHERE id=$1`, [t.id]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id) VALUES($1,'in_progress',$2)`, [t.id, req.user.id]);
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
  wati.notify.resolved({ name: t.requester_name, phone: t.requester_phone }, t, req.user.name).catch(() => {});
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
  if (l1) wati.notify.reopened(l1, { ...t, requester_name: t.requester_name }).catch(() => {});
  res.json({ ok: true });
});

// ---- requester escalates (L2 or L3) after cooling time ----
router.post('/:id/escalate', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.requester_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'Requester only' });
  const cat = (await q('SELECT wait_l1_l2_mins,wait_l2_l3_mins FROM categories WHERE id=$1', [t.category_id])).rows[0];
  const esc = escalationState(t, cat);

  if (esc.canEscalateL2 && t.l2_emp_id) {
    await q(`UPDATE tickets SET escalation_level=2, escalated_l2_at=now() WHERE id=$1`, [t.id]);
    await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id) VALUES($1,'escalated_l2',$2)`, [t.id, req.user.id]);
    const l2 = await empById(t.l2_emp_id);
    if (l2) wati.notify.escalatedL2(l2, t).catch(() => {});
    return res.json({ ok: true, level: 2 });
  }
  if (esc.canEscalateL3 && t.l3_emp_id) {
    await q(`UPDATE tickets SET escalation_level=3, escalated_l3_at=now() WHERE id=$1`, [t.id]);
    await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id) VALUES($1,'escalated_l3',$2)`, [t.id, req.user.id]);
    const l3 = await empById(t.l3_emp_id);
    if (l3) wati.notify.escalatedL3(l3, t).catch(() => {});
    return res.json({ ok: true, level: 3 });
  }
  return res.status(400).json({ error: 'Escalation not available yet' });
});

module.exports = router;
