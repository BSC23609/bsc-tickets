// Overtime pay calculator.
// Shift ends 19:00. OT is paid Rs.50 for every COMPLETED half hour past 19:00, regardless of salary.
//   19:00–19:29 -> 0     19:30 -> 50     20:00 -> 100     20:30 -> 150   ...
// end_time: 'HH:MM' 24h. Handles past-midnight ends (e.g. '00:30') by treating them as next-day.
const SHIFT_END_MIN = 19 * 60; // 7:00 PM
const HALF = 30;
const RATE_PER_HALF = 50;

function endToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  let mins = (+m[1]) * 60 + (+m[2]);
  if (+m[1] < 12) mins += 24 * 60; // 00:xx–11:xx = after midnight -> add a day
  return mins;
}

function computeOt(endHHMM) {
  const end = endToMinutes(endHHMM);
  if (end == null) return { valid: false, error: 'Enter a valid end time (HH:MM)' };
  const otMins = end - SHIFT_END_MIN;
  if (otMins <= 0) return { valid: false, error: 'OT end time must be after 7:00 PM' };
  const halves = Math.floor(otMins / HALF);
  const amount = halves * RATE_PER_HALF;
  const hours = +(otMins / 60).toFixed(2);
  return { valid: true, ot_minutes: otMins, hours, half_hours: halves, amount, rate_per_half: RATE_PER_HALF };
}

module.exports = { computeOt, endToMinutes, SHIFT_END_MIN, RATE_PER_HALF };
