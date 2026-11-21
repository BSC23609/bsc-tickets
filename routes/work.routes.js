// Sunday "Approval for Work" module — a work/overtime approval request with a
// team list (employees picked from the directory + free-text labour) and a
// 3-stage sign-off chain: Approve -> Checked By -> Authorized Signatory.
// The three approver roles are configured in admin (app_settings). Any logged-in
// user can raise one. Digital approval only (no PDF).
const express = require('express');
const crypto = require('crypto');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const wati = require('../lib/wati');
const { background } = require('../lib/bg');

const router = express.Router();
router.use(auth.requireAuth);

const PLACES = { BSC: 'Bharat (001)', G2: 'Salem G2 (1001)' };
const CFG_KEYS = { approve: 'work_approve_emp_id', check: 'work_check_emp_id', authorize: 'work_authorize_emp_id' };
const STAGE_OF = { pending_approve: 'approve', pending_check: 'check' };
const NEXT_STATUS = { approve: 'pending_check', check: 'approved' };

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

// ---------- WhatsApp (WATI) notifications + one-tap token flow ----------
const newToken = () => crypto.randomBytes(18).toString('hex');
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return String(d).slice(0, 10); } };
const teamCount = (row) => ((row.team_emp || []).length + (row.team_labour || []).length);

// The active employee (with phone) configured for a stage, or null.
async function stageEmp(stage) {
  const s = (await q(`SELECT value FROM app_settings WHERE key=$1`, [CFG_KEYS[stage]])).rows[0];
  const id = Number(s && s.value);
  if (!id) return null;
  return (await q(`SELECT id, name, phone FROM employees WHERE id=$1 AND active=TRUE`, [id])).rows[0] || null;
}

// Fire the WhatsApp template for a row's CURRENT stage (fire-and-forget; never blocks the request).
function notifyStage(row, stage) {
  background((async () => {
    try {
      const to = await stageEmp(stage);
      if (!to || !to.phone) return;
      const base = {
        ref: row.ref_no, place: PLACES[row.place] || row.place,
        date: fmtDate(row.work_date) + (row.work_time ? (' · ' + row.work_time) : ''),
        nature: row.nature, token: row.action_token || '',
      };
      if (stage === 'approve') await wati.notify.work.approve(to, { ...base, team: teamCount(row), raiser: row.raised_by_name || '' });
      else if (stage === 'check') await wati.notify.work.hrVerify(to, { ...base, approver: row.approve_by_name || '' });
      else if (stage === 'authorize') await wati.notify.work.final(to, { ...base, checker: row.check_by_name || '' });
    } catch (e) { console.error('[work notify]', e.message); }
  })());
}

// Advance one stage: stamp the signer, rotate the token, move to next status, notify next (or finish).
async function applyApprove(row, stage, actor) {
  const next = NEXT_STATUS[stage];
  const token = next === 'approved' ? null : newToken();
  await q(
    `UPDATE work_approvals SET status=$2, ${stage}_by_id=$3, ${stage}_by_name=$4, ${stage}_at=now(), action_token=$5, updated_at=now() WHERE id=$1`,
    [row.id, next, actor.id || null, actor.name || '', token]);
  if (token) {
    const fresh = (await q(`SELECT * FROM work_approvals WHERE id=$1`, [row.id])).rows[0];
    notifyStage(fresh, STAGE_OF[next]);
  } else if (next === 'approved') {
    finalizeApproved(row.id);   // HR verification done → notify management (FYI) + send the slip to the requester
  }
  return next;
}

// After the final (HR) verification: FYI WhatsApp to management, and the work slip to the requester.
function finalizeApproved(id) {
  background((async () => {
    try {
      const row = (await q(`SELECT * FROM work_approvals WHERE id=$1`, [id])).rows[0];
      if (!row) return;
      let pdfToken = row.pdf_token;
      if (!pdfToken) { pdfToken = newToken(); await q(`UPDATE work_approvals SET pdf_token=$2 WHERE id=$1`, [id, pdfToken]); }
      const base = {
        ref: row.ref_no, place: PLACES[row.place] || row.place,
        date: fmtDate(row.work_date) + (row.work_time ? (' · ' + row.work_time) : ''),
        nature: row.nature,
      };
      // FYI to management (the role formerly called "authorize" is now just notified).
      const fyi = await stageEmp('authorize');
      if (fyi && fyi.phone) await wati.notify.work.fyi(fyi, base);
      // Slip (with both approvals) to the requester, via a download-link WhatsApp.
      const raiser = row.raised_by_id
        ? (await q(`SELECT name, phone FROM employees WHERE id=$1`, [row.raised_by_id])).rows[0] : null;
      if (raiser && raiser.phone) await wati.notify.work.slip({ name: raiser.name, phone: raiser.phone }, { ...base, token: pdfToken });
    } catch (e) { console.error('[work finalize]', e.message); }
  })());
}
async function applyReject(row, stage, reason) {
  await q(`UPDATE work_approvals SET status='rejected', reject_reason=$2, reject_stage=$3, action_token=NULL, updated_at=now() WHERE id=$1`,
    [row.id, reason || 'No reason given', stage]);
  return 'rejected';
}
async function loadByToken(token) {
  if (!token || !/^[a-f0-9]{12,}$/i.test(String(token))) return null;
  return (await q(`SELECT * FROM work_approvals WHERE action_token=$1`, [token])).rows[0] || null;
}
// Build the approved work slip PDF (both approvals) for a row loaded by its stable pdf_token.
async function buildSlipByToken(token) {
  if (!token || !/^[a-f0-9]{12,}$/i.test(String(token))) return null;
  const row = (await q(`SELECT * FROM work_approvals WHERE pdf_token=$1`, [token])).rows[0];
  if (!row || row.status !== 'approved') return null;
  const buildWorkSlipPDF = require('../lib/work_pdf');
  const pdf = await buildWorkSlipPDF({
    ref_no: row.ref_no, place_label: PLACES[row.place] || row.place,
    date: fmtDate(row.work_date), time: row.work_time || '',
    nature: row.nature, team_emp: row.team_emp || [], team_labour: row.team_labour || [],
    raised_by: row.raised_by_name || '',
    approve_by: row.approve_by_name || '', approve_at: row.approve_at,
    check_by: row.check_by_name || '', check_at: row.check_at,
  });
  return { pdf, ref: row.ref_no };
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
  const token = newToken();
  const row = (await q(
    `INSERT INTO work_approvals(ref_no, place, work_date, work_time, nature, team_emp, team_labour, raised_by_id, raised_by_name, action_token)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) RETURNING *`,
    [ref, place, work_date, work_time, nature, JSON.stringify(team_emp), JSON.stringify(team_labour), req.user.id, req.user.name, token])).rows[0];
  notifyStage(row, 'approve');   // WhatsApp to the stage-1 approver (Kannan)
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

  const token = newToken();
  const updated = (await q(
    `UPDATE work_approvals SET place=$2, work_date=$3, work_time=$4, nature=$5, team_emp=$6::jsonb, team_labour=$7::jsonb,
       status='pending_approve', reject_reason=NULL, reject_stage=NULL, action_token=$8,
       approve_by_id=NULL, approve_by_name=NULL, approve_at=NULL,
       check_by_id=NULL, check_by_name=NULL, check_at=NULL,
       authorize_by_id=NULL, authorize_by_name=NULL, authorize_at=NULL,
       updated_at=now() WHERE id=$1 RETURNING *`,
    [row.id, place, work_date, work_time, nature, JSON.stringify(team_emp), JSON.stringify(team_labour), token])).rows[0];
  notifyStage(updated, 'approve');   // re-notify the stage-1 approver after an edit/resubmit
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
    `SELECT * FROM work_approvals WHERE status IN ('pending_approve','pending_check')
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

  if (decision === 'reject') { await applyReject(row, stage, reason); return res.json({ ok: true, status: 'rejected' }); }
  const status = await applyApprove(row, stage, { id: req.user.id, name: req.user.name });
  res.json({ ok: true, status });
});

// Admin: (re)send the approved work slip to the requester via WhatsApp.
router.post('/:id/resend-slip', async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  const row = (await q(`SELECT * FROM work_approvals WHERE id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved requests have a slip.' });
  let pdfToken = row.pdf_token;
  if (!pdfToken) { pdfToken = newToken(); await q(`UPDATE work_approvals SET pdf_token=$2 WHERE id=$1`, [row.id, pdfToken]); }
  const raiser = row.raised_by_id
    ? (await q(`SELECT name, phone FROM employees WHERE id=$1`, [row.raised_by_id])).rows[0] : null;
  if (!raiser || !raiser.phone) return res.json({ ok: true, sent: false, reason: 'no_phone' });
  const base = {
    ref: row.ref_no, place: PLACES[row.place] || row.place,
    date: fmtDate(row.work_date) + (row.work_time ? (' · ' + row.work_time) : ''), nature: row.nature,
  };
  let ok = false;
  try { ok = await wati.notify.work.slip({ name: raiser.name, phone: raiser.phone }, { ...base, token: pdfToken }); }
  catch (e) { console.error('[work resend-slip]', e.message); }
  res.json({ ok: true, sent: !!ok, to: raiser.name });
});

module.exports = router;
// One-tap WhatsApp flow (no login) — used by the public /w/:token page in api/index.js.
async function tokenAct(token, decision, reason) {
  const row = await loadByToken(token);
  if (!row) return { error: 'This link is no longer valid — the request may already have been actioned.' };
  const stage = STAGE_OF[row.status];
  if (!stage) return { error: 'This request is already ' + row.status.replace('_', ' ') + '.' };
  if (decision === 'reject') { await applyReject(row, stage, clean(reason, 500)); return { ok: true, status: 'rejected', stage, ref: row.ref_no }; }
  const actor = (await stageEmp(stage)) || { id: null, name: 'Approver' };
  const status = await applyApprove(row, stage, actor);
  return { ok: true, status, stage, ref: row.ref_no };
}
module.exports._internal = { loadByToken, buildSlipByToken, tokenAct, STAGE_OF, PLACES, fmtDate, teamCount };
