const express = require('express');
const crypto = require('crypto');
const { q, pool } = require('../lib/db');
const auth = require('../lib/auth');
const graph = require('../lib/graph');
const wati = require('../lib/wati');
const excel = require('../lib/excel');
const { background } = require('../lib/bg');
const { nextRefNo, downtimeMins, businessMinutesBetween } = require('../lib/util');
const router = express.Router();

router.use(auth.requireAuth);

// ---- form metadata (categories, trades, locations, priorities) ----
router.get('/meta', async (req, res) => {
  const cats = (await q(
    `SELECT id,name,has_trades,wait_l1_l2_mins,wait_l2_l3_mins FROM categories
     WHERE active=TRUE ORDER BY sort_order,name`)).rows;
  const trades = (await q(
    `SELECT id,category_id,name,location_based FROM trades WHERE active=TRUE ORDER BY sort_order,name`)).rows;
  const locs = (await q('SELECT id,name FROM locations WHERE active=TRUE ORDER BY sort_order,name')).rows;
  const people = (await q('SELECT id,name,emp_no FROM employees WHERE active=TRUE ORDER BY name')).rows;
  const rg = (await q(`SELECT value FROM app_settings WHERE key='requester_groups'`)).rows[0];
  const requester_groups = ((rg && rg.value) || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  res.json({ categories: cats, trades, locations: locs, people, requester_groups, priorities: ['Low','Medium','High','Critical'] });
});

// Routing: every ticket lands directly on its L1 (the trade's L1 when the category
// uses trades, else the category L1). For location-based trades the L1 is looked up
// per location (trade L1 is the fallback). L2/L3 ride along as reminder recipients.
async function resolveRoute(category_id, trade_id, location_id) {
  const { rows } = await q('SELECT * FROM categories WHERE id=$1', [category_id]);
  const c = rows[0];
  if (!c) throw new Error('Unknown category');
  let l1 = c.l1_emp_id || null;
  let locationRequired = false;
  if (c.has_trades && trade_id) {
    const tr = (await q('SELECT l1_emp_id, location_based FROM trades WHERE id=$1 AND category_id=$2', [trade_id, category_id])).rows[0];
    if (tr) {
      if (tr.l1_emp_id) l1 = tr.l1_emp_id;
      if (tr.location_based) {
        locationRequired = true;
        if (location_id) {
          const m = (await q('SELECT l1_emp_id FROM trade_location_l1 WHERE trade_id=$1 AND location_id=$2', [trade_id, location_id])).rows[0];
          if (m && m.l1_emp_id) l1 = m.l1_emp_id;
        }
      }
    }
  }
  return { l1, l2: c.l2_emp_id || null, l3: c.l3_emp_id || null, category_name: c.name, has_trades: c.has_trades, location_required: locationRequired };
}

async function empById(id) {
  if (!id) return null;
  const { rows } = await q('SELECT id,name,email,phone FROM employees WHERE id=$1', [id]);
  return rows[0] || null;
}

// If the resolver attached document(s), send each recipient a WhatsApp with a download button.
async function sendResolutionDocs(t, recipients) {
  const docs = (await q(`SELECT id FROM ticket_photos WHERE ticket_id=$1 AND kind='resolution'`, [t.id])).rows;
  if (!docs.length) return;
  for (const p of recipients) {
    if (p && p.phone) await wati.notify.document(p, t);
  }
}

// ---- create ticket ----
router.post('/', async (req, res) => {
  const { category_id, trade_id, priority, subject, description, location_id } = req.body || {};
  if (!category_id || !subject) return res.status(400).json({ error: 'Category and subject are required' });
  const pri = ['Low','Medium','High','Critical'].includes(priority) ? priority : 'Medium';
  const isSelf = !!(req.body && req.body.self);
  if (isSelf && req.user.can_self_raise !== true)
    return res.status(403).json({ error: 'Self-tickets are not enabled for your account.' });
  const requestedById = (req.body && +req.body.requested_by_id) || null;
  const requestedByLabel = isSelf && !requestedById
    ? (String((req.body && req.body.requested_by_label) || '').trim().slice(0, 120) || null) : null;

  let route;
  try { route = await resolveRoute(category_id, trade_id, location_id); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!isSelf && route.has_trades && !trade_id)
    return res.status(400).json({ error: 'Please pick the sub-type (trade) for this category.' });
  if (!isSelf && route.location_required && !location_id)
    return res.status(400).json({ error: 'Location is required for this trade — please select where the issue is.' });

  // Self-ticket: the raiser is the handler (self-assigned); the category L2/L3 stay on as oversight.
  if (isSelf) {
    const cat = (await q('SELECT l2_emp_id,l3_emp_id FROM categories WHERE id=$1', [category_id])).rows[0] || {};
    route = { ...route, l1: req.user.id, l2: cat.l2_emp_id || null, l3: cat.l3_emp_id || null };
  }

  let locText = null;
  if (location_id) {
    const { rows } = await q('SELECT name FROM locations WHERE id=$1', [location_id]);
    locText = rows[0] ? rows[0].name : null;
  }

  // L1 receives it straight away, so stamp the assignment on creation.
  const autoAssign = !!route.l1;

  const ref = await nextRefNo();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO tickets
        (ref_no,requester_id,category_id,trade_id,priority,subject,description,location_id,location_text,
         status,l1_emp_id,l2_emp_id,l3_emp_id,is_self,requested_by_id,requested_by_label,assigned_at,assigned_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [ref, req.user.id, category_id, trade_id || null, pri, subject, description || null,
       location_id || null, locText, route.l1, route.l2, route.l3,
       isSelf, isSelf ? requestedById : null, requestedByLabel,
       (isSelf || autoAssign) ? new Date() : null, isSelf ? req.user.id : null]
    );
    const t = ins.rows[0];
    await client.query(
      `INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'raised',$2,$3)`,
      [t.id, req.user.id, subject]);
    if (isSelf)
      await client.query(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'assigned',$2,'Self-assigned')`,
        [t.id, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, id: t.id, ref_no: ref });

    background((async () => {
      const enriched = { ...t, category_name: route.category_name, requester_name: req.user.name };
      if (isSelf) {
        // Notify category L2 (oversight), the delegator (CMD/CEO), and the raiser — deduped.
        const seen = new Set();
        for (const id of [route.l2, requestedById, req.user.id]) {
          if (!id || seen.has(id)) continue; seen.add(id);
          const p = await empById(id);
          if (p && p.phone) await wati.notify.raised(p, enriched);
        }
      } else {
        // Goes straight to L1.
        const rec = await empById(route.l1);
        if (rec) await wati.notify.raised(rec, enriched);
      }
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

// ---- personal dashboard: my raised, my assigned, daily activity (IST) with date range ----
router.get('/my-dashboard', async (req, res) => {
  const me = req.user.id;
  const TZ = 'Asia/Kolkata';
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const valid = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = valid(req.query.from) ? req.query.from : (valid(req.query.to) ? req.query.to : todayIST);
  const to   = valid(req.query.to)   ? req.query.to   : from;

  // Tickets I raised within the range (by raised date, IST)
  const raised = (await q(
    `SELECT t.id, t.ref_no, t.subject, t.status, t.priority, t.is_self, t.raised_at,
            c.name AS category_name
     FROM tickets t JOIN categories c ON c.id=t.category_id
     WHERE t.requester_id=$1 AND (t.raised_at AT TIME ZONE $2)::date BETWEEN $3 AND $4
     ORDER BY t.raised_at DESC`, [me, TZ, from, to])).rows;

  // Tickets currently on my plate (assigned to me as any level, still open)
  const assigned = (await q(
    `SELECT t.id, t.ref_no, t.subject, t.status, t.priority, t.escalation_level, t.raised_at, t.assigned_at,
            c.name AS category_name, r.name AS requester_name,
            CASE WHEN t.l1_emp_id=$1 THEN 'L1' WHEN t.l2_emp_id=$1 THEN 'L2' WHEN t.l3_emp_id=$1 THEN 'L3' END AS my_role
     FROM tickets t JOIN categories c ON c.id=t.category_id JOIN employees r ON r.id=t.requester_id
     WHERE $1 IN (t.l1_emp_id,t.l2_emp_id,t.l3_emp_id) AND t.status IN ('open','in_progress','reopened')
     ORDER BY t.raised_at DESC`, [me])).rows;

  // My activity (timeline events I performed) within range, grouped by IST date in the UI
  const activity = (await q(
    `SELECT e.event, e.note, e.at,
            to_char(e.at AT TIME ZONE $2,'YYYY-MM-DD') AS d,
            to_char(e.at AT TIME ZONE $2,'HH12:MI am') AS tlabel,
            t.id AS ticket_id, t.ref_no, t.subject
     FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id
     WHERE e.by_emp_id=$1 AND (e.at AT TIME ZONE $2)::date BETWEEN $3 AND $4
     ORDER BY e.at DESC`, [me, TZ, from, to])).rows;

  // Range totals from my own actions
  const ev = (name) => activity.filter((a) => a.event === name).length;

  // Timesheet: tickets I completed in range, with time taken (working minutes) + total.
  const holidaySet = new Set((await q(`SELECT to_char(d,'YYYY-MM-DD') AS d FROM holidays`)).rows.map((r) => r.d));
  const tsRows = (await q(
    `SELECT t.ref_no, t.subject, t.raised_at, e.at AS completed_at,
            r.name AS raised_by, me.name AS completed_by,
            to_char(e.at AT TIME ZONE $2,'DD/MM/YYYY') AS date_label
     FROM ticket_events e
     JOIN tickets t ON t.id=e.ticket_id
     JOIN employees r ON r.id=t.requester_id
     JOIN employees me ON me.id=e.by_emp_id
     WHERE e.event='resolved' AND e.by_emp_id=$1
       AND (e.at AT TIME ZONE $2)::date BETWEEN $3 AND $4
     ORDER BY e.at`, [me, TZ, from, to])).rows;
  let timesheetTotal = 0;
  const timesheet = tsRows.map((r) => {
    const mins = Math.max(0, businessMinutesBetween(r.raised_at, r.completed_at, holidaySet));
    timesheetTotal += mins;
    return { ref_no: r.ref_no, date: r.date_label, task: r.subject, raised_by: r.raised_by, completed_by: r.completed_by, mins };
  });

  res.json({
    me_name: req.user.name,
    range: { from, to },
    totals: {
      raised: raised.length,
      resolved: ev('resolved'),
      forwarded: ev('forwarded'),
      assigned_open: assigned.length,
    },
    raised, assigned, activity, timesheet, timesheet_total_mins: timesheetTotal,
  });
});

// ---- detail ----
router.get('/:id', async (req, res) => {
  const { rows } = await q(
    `SELECT t.*, c.name AS category_name, c.pattern,
            tr.name AS trade_name, r.name AS requester_name, r.department AS requester_dept, r.phone AS requester_phone,
            l1.name AS l1_name, l2.name AS l2_name, l3.name AS l3_name, ab.name AS assigned_by_name,
            COALESCE(rb.name, t.requested_by_label) AS requested_by_name
     FROM tickets t
     JOIN categories c ON c.id=t.category_id
     LEFT JOIN trades tr ON tr.id=t.trade_id
     JOIN employees r ON r.id=t.requester_id
     LEFT JOIN employees l1 ON l1.id=t.l1_emp_id
     LEFT JOIN employees l2 ON l2.id=t.l2_emp_id
     LEFT JOIN employees l3 ON l3.id=t.l3_emp_id
     LEFT JOIN employees ab ON ab.id=t.assigned_by_id
     LEFT JOIN employees rb ON rb.id=t.requested_by_id
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
  const isL1 = t.l1_emp_id === req.user.id;
  const isOpen = ['open', 'reopened', 'in_progress'].includes(t.status);
  const canAssign = false;   // L2-assign step removed — tickets land on L1 directly
  const canForward = (isHandler || req.user.is_admin) && isOpen;
  const canEscalateL3 = (isL1 || isL2 || req.user.is_admin) && isOpen && !!t.l3_emp_id && t.escalation_level < 3;
  let pool = [];
  if (canAssign) {
    pool = (await q(
      `SELECT e.id, e.name FROM category_l1_pool p JOIN employees e ON e.id=p.emp_id
       WHERE p.category_id=$1 AND e.active=TRUE ORDER BY e.name`, [t.category_id])).rows;
  }

  res.json({ ...t, downtime_mins: downtimeMins(t), photos, events, pool,
    perms: { isRequester, isHandler, isAdmin: req.user.is_admin, isL1: isL1 || req.user.is_admin, isL2, canAssign, canForward, canEscalateL3 } });
});

// ---- photos: mint upload session (browser uploads straight to OneDrive) ----
router.post('/:id/photo-session', async (req, res) => {
  const { rows } = await q('SELECT ref_no,requester_id,l1_emp_id,l2_emp_id,l3_emp_id FROM tickets WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const t = rows[0];
  const kind = req.body.kind || 'issue';
  const isHandler = [t.l1_emp_id, t.l2_emp_id, t.l3_emp_id].includes(req.user.id) || req.user.is_admin;
  // Resolution attachments are uploaded by the handler resolving the ticket; issue photos by the requester.
  const allowed = kind === 'resolution' ? isHandler : (t.requester_id === req.user.id || req.user.is_admin);
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  const count = (await q('SELECT COUNT(*)::int n FROM ticket_photos WHERE ticket_id=$1 AND kind=$2',
    [req.params.id, kind])).rows[0].n;
  if (count >= 5) return res.status(400).json({ error: 'Maximum 5 files' });
  const fileName = (req.body.file_name || `file_${Date.now()}`).replace(/[^\w.\- ]/g, '_');
  const sess = await graph.createUploadSession(t.ref_no, fileName);
  if (!sess) return res.status(503).json({ error: 'File storage not configured yet', skipped: true });
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
// Only the assigned L1 (the actual fixer) — or an admin — can start work / resolve.
// L2 routes/assigns but does not work the ticket.
const isL1Of = (t, u) => t.l1_emp_id === u.id || u.is_admin;

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
  if (!isL1Of(t, req.user)) return res.status(403).json({ error: 'Only the assigned L1 can start work' });
  if (!['open', 'reopened'].includes(t.status)) return res.status(400).json({ error: 'Not in an open state' });
  await q(`UPDATE tickets SET status='in_progress', in_progress_at=COALESCE(in_progress_at,now()) WHERE id=$1`, [t.id]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id) VALUES($1,'in_progress',$2)`, [t.id, req.user.id]);
  background(excel.syncLogToOneDrive());
  res.json({ ok: true });
});

// ---- handler resolves -> notify requester to confirm (or auto-close + notify oversight for self-tickets) ----
router.post('/:id/resolve', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!isL1Of(t, req.user)) return res.status(403).json({ error: 'Only the assigned L1 can resolve' });
  if (!['open', 'in_progress', 'reopened'].includes(t.status))
    return res.status(400).json({ error: 'Cannot resolve from current state' });
  const note = (req.body && req.body.note) || null;

  if (t.is_self) {
    // Raiser is the doer — close it straight away and notify the L2 + the delegator (CMD/CEO).
    const selfToken = crypto.randomBytes(20).toString('hex');
    await q(`UPDATE tickets SET status='closed', resolved_at=now(), closed_at=now(), resolution_note=$2, confirm_token=$3 WHERE id=$1`, [t.id, note, selfToken]);
    await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'resolved',$2,$3)`, [t.id, req.user.id, note]);
    await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'confirmed_closed',$2,'Self-closed')`, [t.id, req.user.id]);
    t.confirm_token = selfToken;
    res.json({ ok: true, self: true });
    background((async () => {
      const seen = new Set([req.user.id]);
      const recipients = [];
      for (const id of [t.l2_emp_id, t.requested_by_id]) {
        if (!id || seen.has(id)) continue; seen.add(id);
        const p = await empById(id);
        if (p && p.phone) { await wati.notify.resolved(p, t, req.user.name, note); recipients.push(p); }
      }
      await sendResolutionDocs(t, recipients);
      await excel.syncLogToOneDrive();
    })());
    return;
  }

  const confirmToken = crypto.randomBytes(20).toString('hex');
  await q(`UPDATE tickets SET status='resolved', resolved_at=now(), resolution_note=$2, confirm_token=$3 WHERE id=$1`, [t.id, note, confirmToken]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'resolved',$2,$3)`,
    [t.id, req.user.id, note]);
  t.confirm_token = confirmToken;
  background((async () => {
    const seen = new Set();
    const targets = [{ id: t.requester_id, name: t.requester_name, phone: t.requester_phone }];
    if (t.l2_emp_id) { const l2 = await empById(t.l2_emp_id); if (l2) targets.push(l2); }
    const recipients = [];
    for (const p of targets) {
      if (!p || !p.phone || seen.has(p.id)) continue; seen.add(p.id);
      await wati.notify.resolved(p, t, req.user.name, note);
      recipients.push(p);
    }
    await sendResolutionDocs(t, recipients);
    await excel.syncLogToOneDrive();
  })());
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

// ---- L1/L2/L3 forwards "not my area" to another category (re-routes the chain) ----
router.post('/:id/forward', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const onTicket = [t.l1_emp_id, t.l2_emp_id, t.l3_emp_id].includes(req.user.id);
  if (!onTicket && !req.user.is_admin) return res.status(403).json({ error: 'Only a handler on this ticket can forward it' });
  if (['resolved', 'closed'].includes(t.status)) return res.status(400).json({ error: 'Cannot forward a resolved/closed ticket' });
  const newCat = +(req.body && req.body.category_id) || null;
  const newTrade = +(req.body && req.body.trade_id) || null;
  const note = ((req.body && req.body.note) || '').trim() || null;
  if (!newCat) return res.status(400).json({ error: 'Pick the category to forward to' });
  if (newCat === t.category_id && (newTrade || null) === (t.trade_id || null))
    return res.status(400).json({ error: "That's the same category it's already in" });

  let route;
  try { route = await resolveRoute(newCat, newTrade, t.location_id); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const oldL1 = t.l1_emp_id, oldL2 = t.l2_emp_id, oldCatName = t.category_name;
  await q(`UPDATE tickets SET category_id=$2, trade_id=$3, l1_emp_id=$4, l2_emp_id=$5, l3_emp_id=$6,
       status='open', escalation_level=0, assigned_at=NULL, assigned_by_id=NULL, last_reminder_at=NULL,
       in_progress_at=NULL, escalated_l2_at=NULL, escalated_l3_at=NULL WHERE id=$1`,
    [t.id, newCat, newTrade, route.l1, route.l2, route.l3]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'forwarded',$2,$3)`,
    [t.id, req.user.id, `${oldCatName} → ${route.category_name}${note ? ' · ' + note : ''}`]);
  res.json({ ok: true, to: route.category_name });

  background((async () => {
    const enriched = { ...t, category_id: newCat, trade_id: newTrade, category_name: route.category_name };
    const newRec = await empById(route.l1);
    if (newRec) await wati.notify.raised(newRec, enriched);
    const seen = new Set([newRec && newRec.id]);
    const fyi = [];
    for (const id of [oldL1, oldL2]) { if (id && !seen.has(id)) { seen.add(id); const p = await empById(id); if (p) fyi.push(p); } }
    fyi.push({ id: t.requester_id, name: t.requester_name, phone: t.requester_phone });
    for (const p of fyi) if (p && p.phone) await wati.notify.forwarded(p, t, oldCatName, route.category_name);
    await excel.syncLogToOneDrive();
  })());
});

// ---- manual escalate to L3 (works alongside the time-based engine) ----
router.post('/:id/escalate-l3', async (req, res) => {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!req.user.is_admin && ![t.l1_emp_id, t.l2_emp_id].includes(req.user.id))
    return res.status(403).json({ error: 'Only L1/L2 on this ticket can escalate' });
  if (!t.l3_emp_id) return res.status(400).json({ error: 'This category has no L3 set' });
  if (['resolved', 'closed'].includes(t.status)) return res.status(400).json({ error: 'Ticket is already resolved/closed' });
  if (t.escalation_level >= 3) return res.status(400).json({ error: 'Already escalated to L3' });
  await q(`UPDATE tickets SET escalation_level=3, escalated_l3_at=COALESCE(escalated_l3_at,now()), last_reminder_at=NULL WHERE id=$1`, [t.id]);
  await q(`INSERT INTO ticket_events(ticket_id,event,by_emp_id,note) VALUES($1,'escalated_l3',$2,$3)`,
    [t.id, req.user.id, (req.body && req.body.note) || 'Manual escalation to L3']);
  res.json({ ok: true });
  background((async () => {
    const l3 = await empById(t.l3_emp_id);
    if (l3) await wati.notify.raised(l3, { ...t });
    await excel.syncLogToOneDrive();
  })());
});

module.exports = router;
