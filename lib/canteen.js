// Canteen register — shared queries used by the routes, the PDF, the Excel mirror and the cron.
// The database is the source of truth; the OneDrive workbook is a read-only copy rebuilt from it.
const { q } = require('./db');

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');
const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;   // rejects 2026-02-30 etc.
};
const monthLabel = (mk) => MON[+mk.slice(5, 7) - 1] + ' ' + mk.slice(0, 4);
function prevMonth(mk, n = 1) {
  let y = +mk.slice(0, 4), m = +mk.slice(5, 7) - n;
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function monthBounds(mk) {
  const y = +mk.slice(0, 4), m = +mk.slice(5, 7);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${mk}-01`, `${mk}-${String(last).padStart(2, '0')}`];
}
const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
const num = (v) => (v == null ? 0 : Number(v));

async function storeName() {
  const r = (await q(`SELECT value FROM app_settings WHERE key='canteen_store_name'`)).rows[0];
  return (r && r.value) || 'PERUMAL SUPERMARKET';
}

// Per-item totals for one month, in print order (items with spend only).
async function monthItemTotals(mk) {
  const [from, to] = monthBounds(mk);
  const { rows } = await q(
    `SELECT i.id, i.name, i.category, i.sort_order, SUM(e.qty) AS qty, SUM(e.amount) AS amount
       FROM canteen_entries e JOIN canteen_items i ON i.id = e.item_id
      WHERE e.entry_date BETWEEN $1 AND $2
      GROUP BY i.id HAVING SUM(e.amount) > 0
      ORDER BY i.sort_order, i.name`, [from, to]);
  return rows.map((r) => ({ id: r.id, name: r.name, category: r.category, qty: num(r.qty), amount: num(r.amount) }));
}

// Item spend total per month for a list of months -> { 'YYYY-MM': total|null (null = no entries) }.
async function monthTotals(mks) {
  const out = {};
  for (const mk of mks) {
    const [from, to] = monthBounds(mk);
    const r = (await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS t FROM canteen_entries
                        WHERE entry_date BETWEEN $1 AND $2`, [from, to])).rows[0];
    out[mk] = r.n ? num(r.t) : null;
  }
  return out;
}

// Everything the monthly print sheet needs (same numbers for the on-screen preview and the PDF).
async function printModel(mk) {
  const rows = await monthItemTotals(mk);
  const footMonths = [mk, prevMonth(mk, 1), prevMonth(mk, 2)];
  const totals = await monthTotals(footMonths);
  return {
    month: mk, label: monthLabel(mk), store: await storeName(), rows,
    total: rows.reduce((s, r) => s + r.amount, 0),
    footer: footMonths.map((m) => (totals[m] == null ? null : { month: m, label: monthLabel(m), total: totals[m] })),
  };
}

// Category x month grid for a year (like the old CONSOLIDATED sheet), plus cook salary.
async function yearSummary(year) {
  const { rows } = await q(
    `SELECT to_char(e.entry_date,'MM')::int AS m, i.category, SUM(e.amount) AS amt
       FROM canteen_entries e JOIN canteen_items i ON i.id=e.item_id
      WHERE e.entry_date BETWEEN $1 AND $2
      GROUP BY 1, 2`, [`${year}-01-01`, `${year}-12-31`]);
  const cats = (await q(`SELECT name FROM canteen_categories ORDER BY sort_order, name`)).rows.map((r) => r.name);
  const grid = {};
  for (const r of rows) {
    if (!cats.includes(r.category)) cats.push(r.category);
    (grid[r.category] = grid[r.category] || Array(12).fill(0))[r.m - 1] += num(r.amt);
  }
  const cook = Array(12).fill(0);
  (await q(`SELECT month, amount FROM canteen_cook_salary WHERE month LIKE $1`, [`${year}-%`])).rows
    .forEach((r) => { cook[+r.month.slice(5, 7) - 1] = num(r.amount); });
  return { year: +year, categories: cats.map((c) => ({ name: c, values: grid[c] || Array(12).fill(0) })), cook };
}

module.exports = { MON, isMonth, isDate, monthLabel, prevMonth, monthBounds, normName, num,
  storeName, monthItemTotals, monthTotals, printModel, yearSummary };
