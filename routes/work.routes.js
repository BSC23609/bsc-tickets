// Sunday "Approval for Work" module — a work/overtime approval request with a
// team list (employees picked from the directory + free-text labour) and a
// 3-stage sign-off chain: Approve -> Checked By -> Authorized Signatory.
// The three approver roles are configured in admin (app_settings). Any logged-in
// user can raise one. Digital approval only (no PDF).
const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');

const router = express.Router();
router.use(auth.requireAuth);

const PLACES = { BSC: 'Bharat (001)', G2: 'Salem G2 (1001)' };
const CFG_KEYS = { approve: 'work_approve_emp_id', check: 'work_check_emp_id', authorize: 'work_authorize_emp_id' };
const STAGE_OF = { pending_approve: 'approve', pending_check: 'check', pending_authorize: 'authorize' };
const NEXT_STATUS = { approve: 'pending_check', check: 'pending_authorize', authorize: 'approved' };

const clean = (s, max = 200) => String(s == null ? '' : s).trim().slice(0, max);
const adjustOf = (a) => (String(a) === 'payment' ? 'payment' : 'leave');

// Build the two team lists from a request body. Employees are resolved against the
// directory (server-trusted name); labour are free text.
async function buildTeams(body) {
  const team_emp = [];
  for (const it of (Array.isArray(body.team_emp) ? body.team_emp : [])) {
    const id = Number(it && it.emp_id);
    if (!id) continue;
    const e = (await q(`SELECT id, name, COALESCE(job_title,'') AS job_title FROM employees WHERE id=$1 AND active=TRUE`, [id])).rows[0];
    if (!e) continue;
    team_emp.push({ emp_id: e.id, name: e.name, designation: clean(it.designation, 120) || e.job_title, adjust: adjustOf(it.adjust) });
  }
  const team_labour = [];
  for (const it of (Array.isArray(body.team_labour) ? body.team_labour : [])) {
    const name = clean(it && it.name, 120);
    if (!name) continue;
    team_labour.push({ name, designation: clean(it && it.designation, 120), adjust: adjustOf(it && it.adjust) });
  }
  return { team_emp, team_labour };
}

// AFW/<place>/YYMMDD/NNN — daily serial per place.
async function nextRef(place) {
  const n = new Date();
  const dp = `${String(n.getFullYear()).slice(2)}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
  const prefix = `AFW/${place}/${dp}/`;
  const r = await q(
    `SELECT COALESCE(MAX(NULLIF(split_part(ref_no,'/',4),'')::int),0) AS mx FROM work_approvals WHERE ref_no LIKE $1`,
    [`${prefix}%`]);
  return prefix + String(r.rows[0].mx + 1).padStart(3, '0');
}

// The three configured approvers, each {id, name} or null.
async function getConfig() {
  const rows = (await q(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [Object.values(CFG_KEYS)])).rows;
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const [role, key] of Object.entries(CFG_KEYS)) {
    const id = Number(byKey[key]);
    out[role] = null;
    if (id) {
      const e = (await q(`SELECT id, name FROM employees WHERE id=$1`, [id])).rows[0];
      if (e) out[role] = { id: e.id, name: e.name };
    }
  }
  return out;
}

// May this user act on the given stage? The configured approver for that stage, or any admin.
const canAct = (user, stage, cfg) => Boolean(user.is_admin || (cfg[stage] && cfg[stage].id === user.id));

function decorate(row, cfg, user) {
  const stage = STAGE_OF[row.status] || null;
  return {
    ...row,
    place_label: PLACES[row.place] || row.place,
    stage,
    can_act: stage ? canAct(user, stage, cfg) : false,
  };
}

// ---- Directory for the employee dropdown (any logged-in user) ----
router.get('/employees', async (req, res) => {
  const rows = (await q(`SELECT id, name, emp_no, COALESCE(job_title,'') AS job_title FROM employees WHERE active=TRUE ORDER BY name`)).rows;
  res.json(rows);
});

// ---- Approver configuration (read by all; set by admin) ----
router.get('/config', async (req, res) => {
  res.json({ approvers: await getConfig(), is_admin: !!req.user.is_admin });
});

router.post('/config', async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  for (const [role, key] of Object.entries(CFG_KEYS)) {
    const id = Number(req.body[role + '_emp_id']);
    const val = id > 0 ? String(id) : '';
    await q(`INSERT INTO app_settings(key,value) VALUES($1,$2)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, val]);
  }
  res.json({ ok: true, approvers: await getConfig() });
});

// ---- Create a request (any user) ----
router.post('/', async (req, res) => {
  const place = PLACES[req.body.place] ? req.body.place : null;
  const work_date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.work_date || '')) ? req.body.work_date : null;
  const work_time = clean(req.body.work_time, 60);
  const nature = clean(req.body.nature, 2000);
  if (!place || !work_date || !nature) return res.status(400).json({ error: 'Place, date and nature of work are required.' });

  const { team_emp, team_labour } = await buildTeams(req.body);
  if (!team_emp.length && !team_labour.length) return res.status(400).json({ error: 'Add at least one team member (employee or labour).' });

  const ref = await nextRef(place);
  const row = (await q(
    `INSERT INTO work_approvals(ref_no, place, work_date, work_time, nature, team_emp, team_labour, raised_by_id, raised_by_name)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING *`,
    [ref, place, work_date, work_time, nature, JSON.stringify(team_emp), JSON.stringify(team_labour), req.user.id, req.user.name])).rows[0];
  res.json({ ok: true, ref_no: ref, id: row.id });
});

// ---- Edit & resubmit (raiser or admin; only before anyone has acted) ----
router.post('/:id/edit', async (req, res) => {
  const row = (await q(`SELECT * FROM work_approvals WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!(req.user.is_admin || row.raised_by_id === req.user.id)) return res.status(403).json({ error: 'Only the person who raised it (or an admin) can edit.' });
  if (!['pending_approve', 'rejected'].includes(row.status)) return res.status(400).json({ error: 'This request has already been actioned and can no longer be edited.' });

  const place = PLACES[req.body.place] ? req.body.place : row.place;
  const work_date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.work_date || '')) ? req.body.work_date : null;
  const work_time = clean(req.body.work_time, 60);
  const nature = clean(req.body.nature, 2000);
  if (!work_date || !nature) return res.status(400).json({ error: 'Date and nature of work are required.' });
  const { team_emp, team_labour } = await buildTeams(req.body);
  if (!team_emp.length && !team_labour.length) return res.status(400).json({ error: 'Add at least one team member (employee or labour).' });

  await q(
    `UPDATE work_approvals SET place=$2, work_date=$3, work_time=$4, nature=$5, team_emp=$6::jsonb, team_labour=$7::jsonb,
       status='pending_approve', reject_reason=NULL, reject_stage=NULL,
       approve_by_id=NULL, approve_by_name=NULL, approve_at=NULL,
       check_by_id=NULL, check_by_name=NULL, check_at=NULL,
       authorize_by_id=NULL, authorize_by_name=NULL, authorize_at=NULL,
       updated_at=now() WHERE id=$1`,
    [row.id, place, work_date, work_time, nature, JSON.stringify(team_emp), JSON.stringify(team_labour)]);
  res.json({ ok: true, id: row.id, ref_no: row.ref_no });
});

// ---- My requests ----
router.get('/mine', async (req, res) => {
  const cfg = await getConfig();
  const rows = (await q(`SELECT * FROM work_approvals WHERE raised_by_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.id])).rows;
  res.json(rows.map((r) => decorate(r, cfg, req.user)));
});

// ---- Requests pending at MY stage (admins: all pending) ----
router.get('/pending', async (req, res) => {
  const cfg = await getConfig();
  const rows = (await q(
    `SELECT * FROM work_approvals WHERE status IN ('pending_approve','pending_check','pending_authorize')
     ORDER BY work_date DESC, created_at DESC LIMIT 200`)).rows;
  res.json(rows.map((r) => decorate(r, cfg, req.user)).filter((r) => r.can_act));
});

// ---- All (admin) ----
router.get('/all', async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  const cfg = await getConfig();
  const rows = (await q(`SELECT * FROM work_approvals ORDER BY created_at DESC LIMIT 300`)).rows;
  res.json(rows.map((r) => decorate(r, cfg, req.user)));
});

// ---- One request ----
router.get('/:id', async (req, res) => {
  const cfg = await getConfig();
  const row = (await q(`SELECT * FROM work_approvals WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(decorate(row, cfg, req.user));
});

// ---- Approve / reject at the current stage ----
router.post('/:id/action', async (req, res) => {
  const decision = req.body.decision === 'reject' ? 'reject' : 'approve';
  const reason = clean(req.body.reason, 500);
  const cfg = await getConfig();
  const row = (await q(`SELECT * FROM work_approvals WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  const stage = STAGE_OF[row.status];
  if (!stage) return res.status(400).json({ error: 'This request is already ' + row.status.replace('_', ' ') + '.' });
  if (!canAct(req.user, stage, cfg)) return res.status(403).json({ error: 'You are not the approver for this stage.' });

  if (decision === 'reject') {
    await q(`UPDATE work_approvals SET status='rejected', reject_reason=$2, reject_stage=$3, updated_at=now() WHERE id=$1`,
      [row.id, reason || 'No reason given', stage]);
    return res.json({ ok: true, status: 'rejected' });
  }
  const col = { approve: 'approve', check: 'check', authorize: 'authorize' }[stage];
  await q(
    `UPDATE work_approvals SET status=$2, ${col}_by_id=$3, ${col}_by_name=$4, ${col}_at=now(), updated_at=now() WHERE id=$1`,
    [row.id, NEXT_STATUS[stage], req.user.id, req.user.name]);
  res.json({ ok: true, status: NEXT_STATUS[stage] });
});

module.exports = router;
