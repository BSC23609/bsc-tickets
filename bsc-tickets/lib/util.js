const { q } = require('./db');

// TKT/BSC/YYMMDD/NNN  — NNN is the daily serial.
async function nextRefNo() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePart = `${yy}${mm}${dd}`;
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM tickets WHERE ref_no LIKE $1`,
    [`TKT/BSC/${datePart}/%`]
  );
  const serial = String(rows[0].n + 1).padStart(3, '0');
  return `TKT/BSC/${datePart}/${serial}`;
}

// Given a ticket row + its category waits, decide what the requester can do now.
// Escalation is requester-initiated; this only reports availability (compute-on-read).
function escalationState(ticket, waits) {
  const open = ['open', 'in_progress', 'reopened'].includes(ticket.status);
  const out = { canEscalateL2: false, canEscalateL3: false, l2ReadyAt: null, l3ReadyAt: null };
  if (!open) return out;
  const now = Date.now();

  if (ticket.escalation_level < 2 && ticket.l2_emp_id) {
    const readyAt = new Date(ticket.raised_at).getTime() + waits.wait_l1_l2_mins * 60000;
    out.l2ReadyAt = new Date(readyAt).toISOString();
    out.canEscalateL2 = now >= readyAt;
  }
  if (ticket.escalation_level === 2 && ticket.l3_emp_id && ticket.escalated_l2_at) {
    const readyAt = new Date(ticket.escalated_l2_at).getTime() + waits.wait_l2_l3_mins * 60000;
    out.l3ReadyAt = new Date(readyAt).toISOString();
    out.canEscalateL3 = now >= readyAt;
  }
  return out;
}

// Resolution time / downtime in minutes (raised -> closed). Null until closed.
function downtimeMins(ticket) {
  if (!ticket.closed_at) return null;
  return Math.round((new Date(ticket.closed_at) - new Date(ticket.raised_at)) / 60000);
}

function fmtDuration(mins) {
  if (mins == null) return '—';
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`].filter(Boolean).join(' ');
}

module.exports = { nextRefNo, escalationState, downtimeMins, fmtDuration };
