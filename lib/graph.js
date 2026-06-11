// Microsoft Graph: OneDrive (hr@bharatsteels.in) storage + Excel log + mail.
// Everything here degrades GRACEFULLY and LOUDLY: if env vars are missing the
// functions log a clear warning and return null/false instead of throwing, so the
// app stays usable before credentials land (no silent failures).

const TENANT = process.env.GRAPH_TENANT_ID;
const CLIENT = process.env.GRAPH_CLIENT_ID;
const SECRET = process.env.GRAPH_CLIENT_SECRET;
const DRIVE_USER = process.env.GRAPH_DRIVE_USER || 'hr@bharatsteels.in';
const ROOT_FOLDER = process.env.GRAPH_ROOT_FOLDER || 'Ticket Management System';

const configured = () => Boolean(TENANT && CLIENT && SECRET);
let _tok = { value: null, exp: 0 };

function warn(msg) { console.warn('[graph] ' + msg); }

async function token() {
  if (!configured()) { warn('not configured — skipping (' + ROOT_FOLDER + ')'); return null; }
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

// Append one row to the master Excel log workbook (a table named "Tickets").
// Fire-and-forget from callers; never blocks the response. DB stays source of truth.
async function appendLogRow(values) {
  if (!configured()) return false;
  try {
    await ensureFolder(ROOT_FOLDER);
    const file = `${ROOT_FOLDER}/Ticket Log.xlsx`;
    const enc = encodeURI(file);
    // Create the workbook with a header row + table if it doesn't exist yet.
    const exists = await g(`${driveBase()}/root:/${enc}`);
    if (!exists.ok) {
      const header = [['Ref No','Raised','Requester','Dept','Category','Trade','Priority',
        'Location','Subject','Status','Esc Level','L1','L2','L3','Resolved','Closed',
        'Downtime (min)','Resolution Note']];
      // upload an empty xlsx is non-trivial via Graph; instead create via PUT of a minimal file
      await g(`${driveBase()}/root:/${enc}:/content`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(''),
      });
      // add header + table
      await g(`${driveBase()}/root:/${enc}:/workbook/worksheets/Sheet1/range(address='A1:R1')`, {
        method: 'PATCH', body: JSON.stringify({ values: header }),
      });
      await g(`${driveBase()}/root:/${enc}:/workbook/tables/add`, {
        method: 'POST', body: JSON.stringify({ address: 'Sheet1!A1:R1', hasHeaders: true }),
      });
    }
    await g(`${driveBase()}/root:/${enc}:/workbook/tables/Table1/rows/add`, {
      method: 'POST', body: JSON.stringify({ values: [values] }),
    });
    return true;
  } catch (e) { warn('appendLogRow failed: ' + e.message); return false; }
}

async function sendMail(to, subject, html) {
  if (!configured()) { warn('mail skipped (not configured): ' + subject); return false; }
  const r = await g(`/users/${encodeURIComponent(DRIVE_USER)}/sendMail`, {
    method: 'POST',
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [].concat(to).map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: false,
    }),
  });
  return r.ok;
}

module.exports = { configured, ensureFolder, createUploadSession, appendLogRow, sendMail, ROOT_FOLDER };
