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
// Folder name can't contain a '/', so we use '&' for the Outpass/Gatepass archive.
const OUTPASS_FOLDER = process.env.GRAPH_OUTPASS_FOLDER || 'Outpass & Gatepass Requests';
const EXPENSE_FOLDER = process.env.GRAPH_EXPENSE_FOLDER || 'Expense Reimbursement';
const MAIL_SENDER = process.env.GRAPH_MAIL_SENDER || DRIVE_USER;

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

// Save an approved Outpass/Gatepass PDF into the hr@ OneDrive archive folder.
async function uploadOutpassPdf(fileName, buffer) {
  if (!configured()) return null;
  await ensureFolder(OUTPASS_FOLDER);
  const t = await token(); if (!t) return null;
  const url = 'https://graph.microsoft.com/v1.0' +
    `${driveBase()}/root:/${encodeURI(`${OUTPASS_FOLDER}/${fileName}`)}:/content`;
  const r = await fetch(url, { method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/pdf' }, body: buffer });
  if (!r.ok) { warn(`upload outpass pdf -> ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
  const j = await r.json().catch(() => null);
  return (j && j.webUrl) ? j.webUrl : true;
}

// Replace the Outpass Excel log in the same folder (rebuilt from the DB).
async function uploadOutpassLog(buffer) {
  if (!configured()) return false;
  await ensureFolder(OUTPASS_FOLDER);
  const t = await token(); if (!t) return false;
  const url = 'https://graph.microsoft.com/v1.0' +
    `${driveBase()}/root:/${encodeURI(`${OUTPASS_FOLDER}/Outpass Log.xlsx`)}:/content`;
  const r = await fetch(url, { method: 'PUT',
    headers: { Authorization: `Bearer ${t}`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: buffer });
  if (!r.ok) warn(`upload outpass log -> ${r.status}`);
  return r.ok;
}

// Save an Expense PDF into the hr@ OneDrive "Expense Reimbursement" folder.
async function uploadExpensePdf(fileName, buffer) {
  if (!configured()) return null;
  await ensureFolder(EXPENSE_FOLDER);
  const t = await token(); if (!t) return null;
  const url = 'https://graph.microsoft.com/v1.0' +
    `${driveBase()}/root:/${encodeURI(`${EXPENSE_FOLDER}/${fileName}`)}:/content`;
  const r = await fetch(url, { method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/pdf' }, body: buffer });
  if (!r.ok) { warn(`upload expense pdf -> ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
  const j = await r.json().catch(() => null);
  return (j && j.webUrl) ? j.webUrl : true;
}

// Replace the Expense Excel register in the folder (rebuilt from the DB).
async function uploadExpenseLog(buffer) {
  if (!configured()) return false;
  await ensureFolder(EXPENSE_FOLDER);
  const t = await token(); if (!t) return false;
  const url = 'https://graph.microsoft.com/v1.0' +
    `${driveBase()}/root:/${encodeURI(`${EXPENSE_FOLDER}/Expense Log.xlsx`)}:/content`;
  const r = await fetch(url, { method: 'PUT',
    headers: { Authorization: `Bearer ${t}`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: buffer });
  if (!r.ok) warn(`upload expense log -> ${r.status}`);
  return r.ok;
}

// Mint an upload session for an expense BILL (browser uploads it directly to
// OneDrive). Bills for a claim go in "Expense Reimbursement/<ref sanitized>".
async function createExpenseBillSession(ref, fileName) {
  if (!configured()) { warn('expense bill session skipped (storage not configured)'); return null; }
  const folder = `${EXPENSE_FOLDER}/${String(ref).replace(/\//g, '-')}`;
  await ensureFolder(folder);
  const itemPath = `${folder}/${fileName}`;
  const r = await g(`${driveBase()}/root:/${encodeURI(itemPath)}:/createUploadSession`, {
    method: 'POST',
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: fileName } }),
  });
  if (!r.ok || !r.json) return null;
  return { uploadUrl: r.json.uploadUrl, itemPath };
}

// Download a bill's bytes back from OneDrive (to merge into the PDF server-side).
async function fetchDriveItemContent(driveItemId) {
  if (!configured() || !driveItemId) return null;
  const t = await token(); if (!t) return null;
  const r = await fetch('https://graph.microsoft.com/v1.0' + `${driveBase()}/items/${driveItemId}/content`,
    { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) { warn(`fetch bill ${driveItemId} -> ${r.status}`); return null; }
  return Buffer.from(await r.arrayBuffer());
}

// Send an email via Graph (needs Mail.Send granted on the Azure app).
// attachments: [{ name, contentBytes(base64), contentType }]
async function sendMail({ to, cc, subject, html, attachments }) {
  if (!configured()) { warn('sendMail skipped (graph not configured)'); return false; }
  const t = await token(); if (!t) return false;
  const toList = (Array.isArray(to) ? to : [to]).filter(Boolean).map(a => ({ emailAddress: { address: a } }));
  const ccList = (Array.isArray(cc) ? cc : (cc ? [cc] : [])).map(a => ({ emailAddress: { address: a } }));
  const msg = {
    message: {
      subject, body: { contentType: 'HTML', content: html },
      toRecipients: toList, ccRecipients: ccList,
      attachments: (attachments || []).map(a => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name, contentType: a.contentType || 'application/pdf', contentBytes: a.contentBytes })),
    },
    saveToSentItems: true,
  };
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_SENDER)}/sendMail`;
  const r = await fetch(url, { method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
  if (!r.ok) { warn(`sendMail -> ${r.status} ${(await r.text()).slice(0, 200)}`); return false; }
  return true;
}

module.exports = { configured, ensureFolder, createUploadSession, uploadLogFile,
  uploadOutpassPdf, uploadOutpassLog, uploadExpensePdf, uploadExpenseLog, sendMail,
  createExpenseBillSession, fetchDriveItemContent,
  ROOT_FOLDER, OUTPASS_FOLDER, EXPENSE_FOLDER };
