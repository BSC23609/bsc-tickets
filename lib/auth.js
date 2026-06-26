const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookie = require('cookie');
const { q } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const COOKIE = 'bsc_tkt';
const MAXAGE = 60 * 60 * 24 * 365; // 1 year (sliding — refreshed on each app open)

function sign(emp) {
  return jwt.sign(
    { id: emp.id, emp_no: emp.emp_no, name: emp.name, is_admin: emp.is_admin },
    SECRET, { expiresIn: MAXAGE }
  );
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: MAXAGE,
  }));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE, '', {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
  }));
}

function readToken(req) {
  let raw = req.headers.cookie ? cookie.parse(req.headers.cookie)[COOKIE] : null;
  if (!raw) {
    // Fallback for installed PWAs (esp. iOS) that don't persist cookies across app close:
    // accept the same JWT from an Authorization: Bearer header.
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) raw = m[1];
  }
  if (!raw) return null;
  try { return jwt.verify(raw, SECRET); } catch { return null; }
}

// Loads the full, current employee row so role/active changes take effect live.
async function requireAuth(req, res, next) {
  const t = readToken(req);
  if (!t) return res.status(401).json({ error: 'Not signed in' });
  const { rows } = await q('SELECT * FROM employees WHERE id=$1 AND active=TRUE', [t.id]);
  if (!rows.length) return res.status(401).json({ error: 'Account inactive' });
  req.user = rows[0];
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

const hashPw = (pw) => bcrypt.hash(pw, 10);
const checkPw = (pw, hash) => bcrypt.compare(pw, hash || '');

module.exports = {
  sign, setAuthCookie, clearAuthCookie, readToken,
  requireAuth, requireAdmin, hashPw, checkPw,
};
