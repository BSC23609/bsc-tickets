const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const wati = require('../lib/wati');
const router = express.Router();

const OTP_TTL_MIN = 10, OTP_MAX_ATTEMPTS = 5, OTP_RESEND_SEC = 45;
const maskPhone = (p) => { const s = String(p || '').replace(/\D/g, ''); return s.length >= 4 ? '\u2022\u2022' + s.slice(-4) : '\u2022\u2022\u2022\u2022'; };

// POST /api/forgot  { emp_no }  — send a 6-digit reset code to the employee's WhatsApp.
router.post('/forgot', async (req, res) => {
  const emp_no = String((req.body || {}).emp_no || '').trim();
  if (!emp_no) return res.status(400).json({ error: 'Employee number required' });
  const emp = (await q('SELECT * FROM employees WHERE emp_no=$1', [emp_no])).rows[0];
  // Don't reveal whether an account exists — generic reply when not found/inactive.
  const generic = { ok: true, message: 'If this employee number is registered, a reset code has been sent to the WhatsApp number on file.' };
  if (!emp || !emp.active) return res.json(generic);
  if (!emp.phone) return res.json({ ok: true, no_phone: true, message: 'No WhatsApp number is on file for this account. Please contact HR to reset your password.' });
  // Resend throttle: one live code per 45s.
  const recent = (await q(`SELECT created_at FROM password_otps WHERE employee_id=$1 AND used=FALSE AND expires_at>now() ORDER BY id DESC LIMIT 1`, [emp.id])).rows[0];
  if (recent && (Date.now() - new Date(recent.created_at)) < OTP_RESEND_SEC * 1000)
    return res.status(429).json({ error: 'A code was just sent — please wait a moment before requesting another.' });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otp_hash = await auth.hashPw(otp);
  await q(`UPDATE password_otps SET used=TRUE WHERE employee_id=$1 AND used=FALSE`, [emp.id]);   // invalidate older codes
  await q(`INSERT INTO password_otps(employee_id, otp_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`, [emp.id, otp_hash, String(OTP_TTL_MIN)]);
  try { await wati.notify.passwordOtp({ name: emp.name, phone: emp.phone }, otp); }
  catch (e) { console.error('[otp] send failed', e.message); }
  res.json({ ok: true, phone_hint: maskPhone(emp.phone), message: `A 6-digit code was sent to your WhatsApp (${maskPhone(emp.phone)}). It expires in ${OTP_TTL_MIN} minutes.` });
});

// POST /api/reset-with-otp  { emp_no, otp, new_password }  — verify code and set a new password.
router.post('/reset-with-otp', async (req, res) => {
  const emp_no = String((req.body || {}).emp_no || '').trim();
  const otp = String((req.body || {}).otp || '').trim();
  const new_password = String((req.body || {}).new_password || '');
  if (!emp_no || !otp || !new_password) return res.status(400).json({ error: 'Employee number, code and new password are required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const emp = (await q('SELECT * FROM employees WHERE emp_no=$1', [emp_no])).rows[0];
  const bad = () => res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
  if (!emp || !emp.active) return bad();
  const row = (await q(`SELECT * FROM password_otps WHERE employee_id=$1 AND used=FALSE AND expires_at>now() ORDER BY id DESC LIMIT 1`, [emp.id])).rows[0];
  if (!row) return bad();
  if (row.attempts >= OTP_MAX_ATTEMPTS) { await q(`UPDATE password_otps SET used=TRUE WHERE id=$1`, [row.id]); return res.status(429).json({ error: 'Too many attempts. Please request a new code.' }); }
  const ok = await auth.checkPw(otp, row.otp_hash);
  if (!ok) { await q(`UPDATE password_otps SET attempts=attempts+1 WHERE id=$1`, [row.id]); return res.status(400).json({ error: 'Incorrect code. Please try again.' }); }
  const hash = await auth.hashPw(new_password);
  await q(`UPDATE employees SET password_hash=$1, must_reset=FALSE WHERE id=$2`, [hash, emp.id]);
  await q(`UPDATE password_otps SET used=TRUE WHERE id=$1`, [row.id]);
  res.json({ ok: true, message: 'Password updated. You can now sign in with your new password.' });
});

// POST /api/login  { emp_no, password }
router.post('/login', async (req, res) => {
  const { emp_no, password } = req.body || {};
  if (!emp_no || !password) return res.status(400).json({ error: 'Employee number and password required' });
  const { rows } = await q('SELECT * FROM employees WHERE emp_no=$1', [String(emp_no).trim()]);
  const emp = rows[0];
  if (!emp || !emp.active) return res.status(401).json({ error: 'Invalid employee number or password' });
  const ok = await auth.checkPw(password, emp.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid employee number or password' });
  const token = auth.sign(emp);
  auth.setAuthCookie(res, token);
  res.json({ ok: true, must_reset: emp.must_reset, is_admin: emp.is_admin, name: emp.name, token });
});

// POST /api/change-password  { current?, new_password }  (used for forced + voluntary reset)
router.post('/change-password', auth.requireAuth, async (req, res) => {
  const { current, new_password } = req.body || {};
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  // If not a forced reset, verify the current password.
  if (!req.user.must_reset) {
    const ok = await auth.checkPw(current || '', req.user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hash = await auth.hashPw(new_password);
  await q('UPDATE employees SET password_hash=$1, must_reset=FALSE WHERE id=$2', [hash, req.user.id]);
  res.json({ ok: true });
});

// GET /api/me
router.get('/me', auth.requireAuth, async (req, res) => {
  const u = req.user;
  // Sliding session: every time the app opens / loads, refresh the cookie AND hand back a
  // fresh token, so an active user is never logged out. Lapses only after a full year idle.
  const token = auth.sign(u);
  auth.setAuthCookie(res, token);
  res.json({
    id: u.id, emp_no: u.emp_no, name: u.name, email: u.email,
    department: u.department, job_title: u.job_title,
    is_admin: u.is_admin, must_reset: u.must_reset,
    can_self_raise: u.can_self_raise === true,
    ot_approver: ((await q(`SELECT value FROM app_settings WHERE key IN ('ot_approver_production','ot_approver_dispatch')`)).rows.map(r => +r.value)).includes(u.id),
    ot_hr: (await q(`SELECT 1 FROM app_settings WHERE key='ot_hr_emp_id' AND value=$1`, [String(u.id)])).rows.length > 0,
    ot_mgmt: ((await q(`SELECT value FROM app_settings WHERE key='ot_mgmt_emp_ids'`)).rows[0]?.value || '').split(',').map(Number).includes(u.id),
    expense_final: u.is_admin || ((await require('../lib/chain').getChain()).final_approver_ids || []).includes(u.id),
    apps: require('../lib/apps').appAccessFor(u),
    token,
  });
});

router.post('/logout', (req, res) => { auth.clearAuthCookie(res); res.json({ ok: true }); });

module.exports = router;
