// Microsoft Graph: OneDrive (hr@bharatsteels.in) storage for ticket photos and the
// Excel log. Degrades GRACEFULLY and LOUDLY — if env vars are missing the functions
// log a clear warning and return null/false instead of throwing, so the app stays
// usable before credentials land (no silent failures).
//
// Permission used: Files.ReadWrite.All. (Mail.Send is NOT used — the app has no email.)

const TENANT = process.env.GRAPH_TENANT_ID;
const CLIENT = process.env.GRAPH_CLIENT_ID;
const SECRET = process.env.GRAPH_CLIENT_SECRET;
const DRIVE_USER = process.env.GRAPH_DRIVE_USER || 'hr@bharatsteels.in';
const ROOT_FOLDER = process.env.GRAPH_ROOT_FOLDER || 'Ticket Management System';

const configured = () => Boolean(TENANT && CLIENT && SECRET);
let _tok = { value: null, exp: 0 };
function warn(msg) { console.warn('[graph] ' + msg); }

async function token() {
  if (!configured()) { warn('not configured — skipping'); return null; }
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json();
  if (!r.ok) { warn('token error: ' + JSON.stringify(j)); return null; }
  _tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return _tok.value;
}

async function g(pathUrl, opts = {}) {
  const t = await token();
  if (!t) return { ok: false, skipped: true };
  const r = await fetch('https://graph.microsoft.com/v1.0' + pathUrl, {
    ...opts,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!r.ok) warn(`${opts.method || 'GET'} ${pathUrl} -> ${r.status} ${text.slice(0, 300)}`);
  return { ok: r.ok, status: r.status, json };
}

const driveBase = () => `/users/${encodeURIComponent(DRIVE_USER)}/drive`;

// Ensure a folder path under the drive root exists; returns true/false.
async function ensureFolder(folderPath) {
  if (!configured()) return false;
  const parts = folderPath.split('/').filter(Boolean);
  let parentPath = '';
  for (const part of parts) {
    const target = parentPath ? `${parentPath}/${part}` : part;
    const check = await g(`${driveBase()}/root:/${encodeURI(target)}`);
    if (!check.ok) {
      const parentRef = parentPath
        ? `${driveBase()}/root:/${encodeURI(parentPath)}:/children`
        : `${driveBase()}/root/children`;
      await g(parentRef, {
        method: 'POST',
        body: JSON.stringify({ name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }),
      });
    }
    parentPath = target;
  }
  return true;
}

// Mint a resumable upload session so the BROWSER uploads the photo directly to
// OneDrive (bypasses Vercel's 4.5MB function body limit). Returns { uploadUrl }.
async function createUploadSession(ticketRef, fileName) {
  if (!configured()) { warn('upload session skipped (storage not configured)'); return null; }
  const folder = `${ROOT_FOLDER}/${ticketRef}`;
  await ensureFolder(folder);
  const itemPath = `${folder}/${fileName}`;
  const r = await g(`${driveBase()}/root:/${encodeURI(itemPath)}:/createUploadSession`, {
    method: 'POST',
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: fileName } }),
  });
  if (!r.ok || !r.json) return null;
  return { uploadUrl: r.json.uploadUrl, itemPath };
}

// Replace "Ticket Log.xlsx" with a freshly-built workbook (single PUT — robust).
// The buffer is generated from the DB by lib/excel.js.
async function uploadLogFile(buffer) {
  if (!configured()) return false;
  await ensureFolder(ROOT_FOLDER);
  const path = `${driveBase()}/root:/${encodeURI(`${ROOT_FOLDER}/Ticket Log.xlsx`)}:/content`;
  const t = await token();
  if (!t) return false;
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    body: buffer,
  });
  if (!r.ok) warn(`upload log -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.ok;
}

module.exports = { configured, ensureFolder, createUploadSession, uploadLogFile, ROOT_FOLDER };
