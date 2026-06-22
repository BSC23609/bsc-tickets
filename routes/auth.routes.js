const express = require('express');
const { q } = require('../lib/db');
const auth = require('../lib/auth');
const router = express.Router();

// POST /api/login  { emp_no, password }
router.post('/login', async (req, res) => {
  const { emp_no, password } = req.body || {};
  if (!emp_no || !password) return res.status(400).json({ error: 'Employee number and password required' });
  const { rows } = await q('SELECT * FROM employees WHERE emp_no=$1', [String(emp_no).trim()]);
  const emp = rows[0];
  if (!emp || !emp.active) return res.status(401).json({ error: 'Invalid employee number or password' });
  const ok = await auth.checkPw(password, emp.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid employee number or password' });
  auth.setAuthCookie(res, auth.sign(emp));
  res.json({ ok: true, must_reset: emp.must_reset, is_admin: emp.is_admin, name: emp.name });
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
  res.json({
    id: u.id, emp_no: u.emp_no, name: u.name, email: u.email,
    department: u.department, job_title: u.job_title,
    is_admin: u.is_admin, must_reset: u.must_reset,
    can_self_raise: u.can_self_raise === true,
    apps: require('../lib/apps').appAccessFor(u),
  });
});

router.post('/logout', (req, res) => { auth.clearAuthCookie(res); res.json({ ok: true }); });

module.exports = router;
