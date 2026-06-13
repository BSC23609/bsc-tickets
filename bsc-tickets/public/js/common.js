// Shared helpers used by every page.
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null; try { data = await res.json(); } catch {}
  if (res.status === 401) { location.href = '/'; throw new Error('Not signed in'); }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

function toast(msg, type = 'info') {
  const wrap = document.getElementById('toast') || (() => {
    const d = document.createElement('div');
    d.id = 'toast';
    d.className = 'fixed top-4 right-4 z-50 space-y-2';
    document.body.appendChild(d); return d;
  })();
  const colors = { info: 'bg-slate-800', success: 'bg-emerald-600', error: 'bg-red-600' };
  const el = document.createElement('div');
  el.className = `${colors[type]} text-white text-sm px-4 py-2.5 rounded-lg shadow-lg`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(mins) {
  if (mins == null) return '—';
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`].filter(Boolean).join(' ');
}

const STATUS_STYLE = {
  open:        ['bg-amber-100 text-amber-800', 'Open'],
  in_progress: ['bg-blue-100 text-blue-800', 'In Progress'],
  reopened:    ['bg-orange-100 text-orange-800', 'Reopened'],
  resolved:    ['bg-violet-100 text-violet-800', 'Resolved'],
  closed:      ['bg-emerald-100 text-emerald-800', 'Closed'],
};
const PRIORITY_STYLE = {
  Low: 'bg-slate-100 text-slate-700', Medium: 'bg-sky-100 text-sky-800',
  High: 'bg-amber-100 text-amber-800', Critical: 'bg-red-100 text-red-700',
};
function statusBadge(s) {
  const [cls, label] = STATUS_STYLE[s] || ['bg-slate-100 text-slate-700', s];
  return `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
}
function priorityBadge(p) {
  return `<span class="pill ${PRIORITY_STYLE[p] || ''}">${p}</span>`;
}

// Upload a File straight to OneDrive using a Graph upload session URL minted by the
// server, then register its metadata. Keeps large photos off the Vercel function.
async function uploadPhotoToOneDrive(ticketId, file, kind = 'issue') {
  const sess = await fetch(`/api/tickets/${ticketId}/photo-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: file.name, kind }), credentials: 'same-origin',
  });
  const sj = await sess.json();
  if (sess.status === 503) { toast('Photo storage not set up yet — ticket saved without photo', 'info'); return null; }
  if (!sess.ok) throw new Error(sj.error || 'Upload session failed');

  const put = await fetch(sj.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes 0-${file.size - 1}/${file.size}`, 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!put.ok) throw new Error('OneDrive upload failed');
  const item = await put.json();
  await api(`/tickets/${ticketId}/photo`, { method: 'POST', body: {
    kind, file_name: sj.file_name, web_url: item.webUrl, drive_item_id: item.id } });
  return item.webUrl;
}
