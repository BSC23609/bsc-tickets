// Run a promise as a background task that survives after the HTTP response.
// On Vercel this uses waitUntil() so the serverless function isn't frozen before
// the work (Excel rebuild, WhatsApp send) completes. Locally it just runs.
let _waitUntil = null;
try { _waitUntil = require('@vercel/functions').waitUntil; } catch { /* not on Vercel */ }

function background(promise) {
  const p = Promise.resolve(promise).catch((e) => console.error('[bg] task failed:', e && e.message));
  if (_waitUntil) { try { _waitUntil(p); return; } catch { /* no request context */ } }
  // local/dev fallback: let it run detached
  return p;
}

module.exports = { background };
