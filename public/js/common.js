// Shared helpers used by every page.
function bscToken() { try { return localStorage.getItem('bsc_token'); } catch { return null; } }
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json' };
  const tok = bscToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  // Reads are idempotent, so retry them through a Neon cold start (free-tier suspends when idle;
  // the first hit after a nap can hang or 5xx). Writes are NOT auto-retried — one attempt only,
  // so we never risk a double-write. Each attempt has a hard client timeout so a hung request
  // fails fast and lets the retry warm the DB instead of leaving the UI stuck/blank.
  const isGet = method === 'GET';
  const maxAttempts = isGet ? 3 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    // Generous on reads: a cold Neon compute can take 20s+ to wake on the first hit.
    const timer = setTimeout(() => ac.abort(), isGet ? 32000 : 35000);
    try {
      const res = await fetch('/api' + path, {
        method, headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
        signal: ac.signal,
      });
      clearTimeout(timer);
      let data = null; try { data = await res.json(); } catch {}
      if (data && data.token) { try { localStorage.setItem('bsc_token', data.token); } catch {} }
      if (path === '/logout') { try { localStorage.removeItem('bsc_token'); } catch {} }
      if (res.status === 401) { try { localStorage.removeItem('bsc_token'); } catch {} location.href = '/'; throw new Error('Not signed in'); }
      // Transient server error on a read → wait a beat (Neon waking) and try again.
      if (isGet && res.status >= 500 && attempt < maxAttempts) { lastErr = new Error((data && data.error) || ('HTTP ' + res.status)); await _sleep(attempt * 500); continue; }
      if (!res.ok) throw new Error((data && data.error) || 'Request failed');
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e && e.message === 'Not signed in') throw e;   // 401 redirect already handled
      // An AbortError means our own timeout fired — almost always a sleeping database waking up.
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      lastErr = aborted ? new Error('The database is waking up — please tap Refresh in a moment.') : e;
      if (isGet && attempt < maxAttempts) { await _sleep(attempt * 700); continue; }  // retry reads
      throw lastErr;
    }
  }
  throw lastErr || new Error('Request failed');
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
  external:    ['bg-fuchsia-100 text-fuchsia-800', 'Escalated externally'],
};
// While a ticket is on external/vendor hold and still open, show the external status.
function tStatusKey(t) {
  return (t && t.external_hold && ['open', 'in_progress', 'reopened'].includes(t.status)) ? 'external' : (t && t.status);
}
const PRIORITY_STYLE = {
  Low: 'bg-slate-100 text-slate-700', Medium: 'bg-sky-100 text-sky-800',
  High: 'bg-amber-100 text-amber-800', Critical: 'bg-red-100 text-red-700',
};
function statusBadge(s) {
  const [cls, label] = STATUS_STYLE[s] || ['bg-slate-100 text-slate-700', s];
  return `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
}
function statusBadgeT(t) { return statusBadge(tStatusKey(t)); }
function priorityBadge(p) {
  return `<span class="pill ${PRIORITY_STYLE[p] || ''}">${p}</span>`;
}

// Upload a File straight to OneDrive using a Graph upload session URL minted by the
// server, then register its metadata. Keeps large photos off the Vercel function.
async function uploadPhotoToOneDrive(ticketId, file, kind = 'issue') {
  const sess = await fetch(`/api/tickets/${ticketId}/photo-session`, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, bscToken() ? { Authorization: 'Bearer ' + bscToken() } : {}),
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

// ===== PWA: service-worker registration + "Install app" prompt =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
// Capture the install event (Android / desktop Chrome) and reveal an #installBtn if the page has one.
let _bscInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _bscInstallPrompt = e;
  const b = document.getElementById('installBtn');
  if (b) b.classList.remove('hidden');
});
window.installApp = async function () {
  if (_bscInstallPrompt) {
    _bscInstallPrompt.prompt();
    try { await _bscInstallPrompt.userChoice; } catch (e) {}
    _bscInstallPrompt = null;
    const b = document.getElementById('installBtn');
    if (b) b.classList.add('hidden');
  } else {
    // iOS Safari has no prompt API — guide the user through the Share sheet.
    alert('To install the app:\n\niPhone/iPad — tap the Share icon, then "Add to Home Screen".\nAndroid — open the browser menu (⋮) and tap "Install app" / "Add to Home screen".');
  }
};
window.addEventListener('appinstalled', () => {
  const b = document.getElementById('installBtn');
  if (b) b.classList.add('hidden');
});

// ===== In-app launch splash (full logo) — works on Android AND iOS =====
window.hideBscSplash = function () {
  const el = document.getElementById('bscSplash');
  if (!el) return;
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  setTimeout(() => { if (el && el.parentNode) el.remove(); }, 450);
};
(function () {
  const el = document.getElementById('bscSplash');
  if (!el) return;
  const page = el.dataset.splash;
  if (page === 'home') {
    // Show once per launch session; skip on in-app navigation back to home.
    if (sessionStorage.getItem('bsc_home_splash')) { el.remove(); return; }
    const fade = () => { window.hideBscSplash(); sessionStorage.setItem('bsc_home_splash', '1'); };
    if (document.readyState === 'complete') setTimeout(fade, 650);
    else window.addEventListener('load', () => setTimeout(fade, 650));
  }
  // 'entry' (login page) is faded by index.html once the session check resolves.
  // Hard failsafe so the splash can never get stuck if a request hangs.
  setTimeout(() => { if (document.getElementById('bscSplash')) window.hideBscSplash(); }, 6000);
})();
