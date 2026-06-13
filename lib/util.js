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

// OGP/BSC/YYMMDD/NNNN — daily serial for outpass/gatepass requests.
async function nextOutpassRefNo() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePart = `${yy}${mm}${dd}`;
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM outpass_requests WHERE ref_no LIKE $1`,
    [`OGP/BSC/${datePart}/%`]);
  return `OGP/BSC/${datePart}/${String(rows[0].n + 1).padStart(4, '0')}`;
}

// ===================== WORKING-HOURS CALENDAR =====================
// Mon–Sat 09:30–18:00 IST, excluding Sundays and the holidays passed in.
const IST_OFFSET = 5.5 * 3600 * 1000;
const WK_START_MIN = 9 * 60 + 30;   // 09:30
const WK_END_MIN   = 18 * 60;       // 18:00

function istParts(ms) {
  const d = new Date(ms + IST_OFFSET);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(),
    dow: d.getUTCDay(), minOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateStr: d.toISOString().slice(0, 10),
  };
}

// Count working minutes between two instants (Date | ms | ISO string).
function businessMinutesBetween(start, end, holidaySet = new Set()) {
  const startMs = +new Date(start), endMs = +new Date(end);
  if (!(endMs > startMs)) return 0;
  let total = 0, guard = 0;
  let cur = startMs;
  while (cur < endMs && guard++ < 800) {
    const p = istParts(cur);
    const istMidnightUTC = Date.UTC(p.y, p.mo, p.da) - IST_OFFSET; // 00:00 IST of this date, in UTC ms
    const winStart = istMidnightUTC + WK_START_MIN * 60000;
    const winEnd   = istMidnightUTC + WK_END_MIN * 60000;
    const working = p.dow !== 0 && !holidaySet.has(p.dateStr);
    if (working) {
      const s = Math.max(startMs, winStart), e = Math.min(endMs, winEnd);
      if (e > s) total += (e - s) / 60000;
    }
    cur = istMidnightUTC + 24 * 3600000; // next IST midnight
  }
  return Math.floor(total);
}

// Is it inside working hours right now? (used to gate reminder sends)
function isWorkingNow(holidaySet = new Set(), nowMs = Date.now()) {
  const p = istParts(nowMs);
  return p.dow !== 0 && !holidaySet.has(p.dateStr) && p.minOfDay >= WK_START_MIN && p.minOfDay < WK_END_MIN;
}

// Friendly elapsed label for a minutes count, e.g. 125 -> "2 hours".
function elapsedLabel(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} hour${h > 1 ? 's' : ''}`;
  return `${h}h ${m}m`;
}

module.exports = { nextRefNo, nextOutpassRefNo, escalationState, downtimeMins, fmtDuration,
  businessMinutesBetween, isWorkingNow, elapsedLabel };
