// Outpass / Gatepass module — submit → approver WhatsApp → portal approval →
// PDF + OneDrive archive + Excel log + requester WhatsApp (approve), or reason
// WhatsApp + Excel log (reject). One approver finalises (Option 1 routing).
const express = require('express');
const crypto = require('crypto');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const wati = require('../lib/wati');
const graph = require('../lib/graph');
const oexcel = require('../lib/outpass_excel');
const { background } = require('../lib/bg');
const { nextOutpassRefNo } = require('../lib/util');
const { buildOutpassPDF } = require('../lib/outpass_pdf');

const router = express.Router();
router.use(auth.requireAuth);

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const typeLabel = (t) => (t === 'gatepass' ? 'Gatepass' : 'Outpass');
const decorate = (o) => ({ ...o, type_label: typeLabel(o.type) });

// PDF field set from a full request row.
function pdfData(o) {
  return {
    type: o.type, on_duty: o.on_duty, date: fmtDate(o.req_date),
    emp_code: o.req_code, name: o.req_name, designation: o.designation || '',
    purpose: o.purpose, out_time: o.out_time, in_time: o.in_time,
    ref_no: o.ref_no, approver: o.actioned_by_name, approved_at: fmtDateTime(o.actioned_at),
  };
}

// Resolve the approver for a requester automatically: their department HEAD,
// else the configured fallback approver, else the first active admin. Never the
// requester themselves. When onLeave is true (requester says their head is on
// leave), route to the leave cover first: per-department override, else the
// global default leave cover, before falling back to the normal chain.
async function resolveApprover(requester, { onLeave = false } = {}) {
  const dept = (requester.department || '').trim();
  const pickEmp = async (id, label) => {
    if (!id) return null;
    const e = (await q('SELECT id, name, phone FROM employees WHERE id=$1 AND active=TRUE', [id])).rows[0];
    return e && e.id !== requester.id ? { emp_id: e.id, name: e.name, phone: e.phone, label } : null;
  };

  if (onLeave) {
    if (dept) {
      const d = (await q(`SELECT leave_cover_emp_id FROM dept_approvers WHERE lower(department)=lower($1)`, [dept])).rows[0];
      const cover = d && (await pickEmp(d.leave_cover_emp_id, 'Leave cover'));
      if (cover) return cover;
    }
    const def = (await q(`SELECT value FROM app_settings WHERE key='outpass_leavecover_emp_id'`)).rows[0];
    const cover = def && def.value && (await pickEmp(Number(def.value), 'Leave cover'));
    if (cover) return cover;
    // no leave cover configured -> fall through to the normal chain below
  }

  if (dept) {
    const h = (await q(
      `SELECT e.id, e.name, e.phone FROM dept_approvers d JOIN employees e ON e.id = d.head_emp_id
       WHERE lower(d.department) = lower($1) AND d.active = TRUE AND e.active = TRUE`, [dept])).rows[0];
    if (h && h.id !== requester.id) return { emp_id: h.id, name: h.name, phone: h.phone, label: dept + ' Head' };
  }
  const fb = (await q(`SELECT value FROM app_settings WHERE key = 'outpass_fallback_emp_id'`)).rows[0];
  if (fb && fb.value) {
    const f = await pickEmp(Number(fb.value), 'HR');
    if (f) return f;
  }
  const a = (await q(
    `SELECT id, name, phone FROM employees WHERE is_admin = TRUE AND active = TRUE AND id <> $1 ORDER BY id LIMIT 1`,
    [requester.id])).rows[0];
  return a ? { emp_id: a.id, name: a.name, phone: a.phone, label: 'Admin' } : null;
}

// ---- form metadata: the auto-resolved approver + the requester's own details ----
router.get('/meta', async (req, res) => {
  const ap = await resolveApprover(req.user);
  const apLeave = await resolveApprover(req.user, { onLeave: true });
  res.json({
    approver: ap ? { name: ap.name, label: ap.label } : null,
    leave_approver: apLeave ? { name: apLeave.name, label: apLeave.label } : null,
    me: { emp_no: req.user.emp_no, name: req.user.name, designation: req.user.job_title || '' },
  });
});

// ---- submit a request ----
router.post('/', async (req, res) => {
  const { type, on_duty, req_date, purpose, out_time, in_time, manager_on_leave } = req.body || {};
  if (!['outpass', 'gatepass'].includes(type)) return res.status(400).json({ error: 'Choose Outpass or Gatepass' });
  if (!purpose || !purpose.trim()) return res.status(400).json({ error: 'Purpose is required' });
  if (!out_time) return res.status(400).json({ error: 'Out-time is required' });
  if (type === 'gatepass' && !in_time) return res.status(400).json({ error: 'In-time is required for a gatepass' });

  const onLeave = !!manager_on_leave;
  const approver = await resolveApprover(req.user, { onLeave });
  if (!approver) return res.status(400).json({ error: 'No approver is configured for your department. Please contact admin.' });

  const ref = await nextOutpassRefNo();
  const actionToken = crypto.randomBytes(20).toString('hex');
  const { rows } = await q(
    `INSERT INTO outpass_requests(ref_no,type,on_duty,req_date,requester_id,purpose,out_time,in_time,approver_id,approver_label,manager_on_leave,action_token)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ref, type, !!on_duty, req_date || new Date(), req.user.id, purpose.trim(),
     out_time, type === 'gatepass' ? in_time : null, approver.emp_id, approver.label, onLeave, actionToken]);
  const id = rows[0].id;
  res.json({ ok: true, id, ref_no: ref });

  background((async () => {
    if (approver.phone) await wati.notify.outpass.request({ name: approver.name, phone: approver.phone }, {
      id, ref_no: ref, requester_name: req.user.name, type, purpose: purpose.trim(),
      date_label: fmtDate(req_date || new Date()), out_time, action_token: actionToken });
    await oexcel.syncOutpassLog();
  })());
});

// ---- lists: mine | approvals (routed to me) ----
router.get('/', async (req, res) => {
  const scope = req.query.scope === 'approvals' ? 'approvals' : 'mine';
  let rows;
  if (scope === 'mine') {
    rows = (await q(
      `SELECT o.*, ap.name AS approver_name FROM outpass_requests o
       LEFT JOIN employees ap ON ap.id = o.approver_id
       WHERE o.requester_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [req.user.id])).rows;
  } else {
    rows = (await q(
      `SELECT o.*, r.name AS requester_name FROM outpass_requests o
       JOIN employees r ON r.id = o.requester_id
       WHERE o.approver_id=$1 ORDER BY (o.status='pending') DESC, o.created_at DESC LIMIT 100`, [req.user.id])).rows;
  }
  res.json(rows.map(decorate));
});

// ---- detail (requester, the assigned approver, or admin) ----
router.get('/:id', async (req, res) => {
  const o = (await q(
    `SELECT o.*, r.emp_no AS req_code, r.name AS requester_name, r.job_title AS designation,
            ap.name AS approver_name
     FROM outpass_requests o
     JOIN employees r ON r.id = o.requester_id
     LEFT JOIN employees ap ON ap.id = o.approver_id
     WHERE o.id=$1`, [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'Not found' });
  const isApprover = o.approver_id === req.user.id;
  const isRequester = o.requester_id === req.user.id;
  if (!isApprover && !isRequester && !req.user.is_admin) return res.status(403).json({ error: 'Not allowed' });
  res.json({ ...decorate(o), perms: { isApprover, isRequester, canAction: isApprover && o.status === 'pending' } });
});

// ---- shared approve/reject core (used by the app routes AND the WhatsApp one-tap links) ----
async function applyApprove(o, actorId, actorName) {
  const token = crypto.randomBytes(16).toString('hex');
  await q(`UPDATE outpass_requests SET status='approved', actioned_by_id=$2, actioned_by_name=$3,
           actioned_at=now(), pdf_token=$4 WHERE id=$1`, [o.id, actorId, actorName, token]);
  background((async () => {
    const full = (await q(
      `SELECT o.*, r.emp_no AS req_code, r.name AS req_name, r.job_title AS designation, r.phone AS req_phone
       FROM outpass_requests o JOIN employees r ON r.id = o.requester_id WHERE o.id=$1`, [o.id])).rows[0];
    try {
      const pdf = await buildOutpassPDF(pdfData(full));
      const stamp = fmtDateTime(full.actioned_at).replace(/[:/,]/g, '-');
      await graph.uploadOutpassPdf(`${full.req_name} (${stamp}).pdf`, pdf);
    } catch (e) { console.error('outpass pdf/upload', e); }
    await oexcel.syncOutpassLog();
    if (full.req_phone) await wati.notify.outpass.approved(
      { name: full.req_name, phone: full.req_phone },
      { ref_no: full.ref_no, type: full.type, actioned_by_name: actorName, pdf_token: token });
  })());
  return token;
}
async function applyReject(o, actorId, actorName, reason) {
  await q(`UPDATE outpass_requests SET status='rejected', actioned_by_id=$2, actioned_by_name=$3,
           actioned_at=now(), reject_reason=$4 WHERE id=$1`, [o.id, actorId, actorName, reason || null]);
  background((async () => {
    const full = (await q(
      `SELECT o.*, r.name AS req_name, r.phone AS req_phone
       FROM outpass_requests o JOIN employees r ON r.id = o.requester_id WHERE o.id=$1`, [o.id])).rows[0];
    await oexcel.syncOutpassLog();
    if (full.req_phone) await wati.notify.outpass.rejected(
      { name: full.req_name, phone: full.req_phone },
      { ref_no: full.ref_no, type: full.type, actioned_by_name: actorName, reject_reason: reason || '' });
  })());
}

// ---- approve (in-app) ----
router.post('/:id/approve', async (req, res) => {
  const o = (await q('SELECT * FROM outpass_requests WHERE id=$1', [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.approver_id !== req.user.id) return res.status(403).json({ error: 'Only the chosen approver can action this' });
  if (o.status !== 'pending') return res.status(409).json({ error: 'Already ' + o.status });
  await applyApprove(o, req.user.id, req.user.name);
  res.json({ ok: true });
});

// ---- reject (in-app) ----
router.post('/:id/reject', async (req, res) => {
  const reason = ((req.body && req.body.reason) || '').trim();
  const o = (await q('SELECT * FROM outpass_requests WHERE id=$1', [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.approver_id !== req.user.id) return res.status(403).json({ error: 'Only the chosen approver can action this' });
  if (o.status !== 'pending') return res.status(409).json({ error: 'Already ' + o.status });
  if (!reason) return res.status(400).json({ error: 'Please add a reason for rejection' });
  await applyReject(o, req.user.id, req.user.name, reason);
  res.json({ ok: true });
});

module.exports = router;
module.exports._internal = { applyApprove, applyReject };
