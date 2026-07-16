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

// Clock-only half of the check above: weekday + time-of-day, NO holiday lookup and so NO
// database hit. Crons call this first and bail before touching Neon — otherwise an overnight
// run wakes a suspended Neon compute just to discover it had nothing to do, and the cold
// start can blow the function's time budget (that's the 504s we were seeing).
function isWorkingClock(nowMs = Date.now()) {
  const p = istParts(nowMs);
  return p.dow !== 0 && p.minOfDay >= WK_START_MIN && p.minOfDay < WK_END_MIN;
}

// Friendly elapsed label for a minutes count, e.g. 125 -> "2 hours".
function elapsedLabel(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} hour${h > 1 ? 's' : ''}`;
  return `${h}h ${m}m`;
}

// Resolve a 'HH:MM AM/PM' display string on a given date (YYYY-MM-DD or Date) to a real
// instant, interpreting the wall-clock as IST. Returns ms, or null if unparseable.
// Used to turn a gatepass's expected in_time into a comparable timestamp.
function istClockToMs(dateInput, timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10); const mm = parseInt(m[2], 10);
  const ap = m[3] ? m[3].toUpperCase() : null;
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  let y, mo, da;
  if (dateInput instanceof Date) { const p = istParts(+dateInput); y = p.y; mo = p.mo; da = p.da; }
  else { const s = String(dateInput).slice(0, 10).split('-'); if (s.length !== 3) return null; y = +s[0]; mo = +s[1] - 1; da = +s[2]; }
  // Wall-clock IST → UTC ms (IST = UTC+5:30).
  return Date.UTC(y, mo, da, hh, mm) - IST_OFFSET;
}

// Great-circle distance in metres between two lat/lng points.
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// DB-free clock gate for the overdue-outpass cron: weekday within a broad watch window
// (default 08:00–20:00 IST), so night/Sunday runs skip before touching Neon (avoids the
// cold-start 504s). Window is wider than office hours because passes can run late.
function isOutpassWatchClock(startMin = 8 * 60, endMin = 20 * 60, nowMs = Date.now()) {
  const p = istParts(nowMs);
  return p.dow !== 0 && p.minOfDay >= startMin && p.minOfDay < endMin;
}

module.exports = { nextRefNo, nextOutpassRefNo, escalationState, downtimeMins, fmtDuration,
  businessMinutesBetween, isWorkingNow, isWorkingClock, elapsedLabel,
  istClockToMs, haversineMeters, isOutpassWatchClock };
