// One-off OT / Shearing corrections applied server-side (behind CRON_SECRET), for when
// a management fix must be made to an already-approved month. Matches the exact SQL the
// in-app "Remove people" / "Add a line" buttons use. Returns per-op results plus the full
// current name lists so the caller can verify spellings and totals.
const { q } = require('./db');

const CO = { BSC: 'BSC', G2: 'G2' };
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function listPeople(company, month) {
  const ot = (await q(
    `SELECT labour_name AS name, COALESCE(SUM(amount),0)::int AS amount
     FROM labour_ot WHERE company=$1 AND period=$2 GROUP BY labour_name ORDER BY labour_name`,
    [company, month])).rows;
  const sh = (await q(
    `SELECT labour_name AS name, COALESCE(SUM(amount),0)::int AS amount
     FROM labour_shearing WHERE company=$1 AND period=$2 GROUP BY labour_name ORDER BY labour_name`,
    [company, month])).rows;
  const otTotal = ot.reduce((s, r) => s + Number(r.amount), 0);
  const shTotal = sh.reduce((s, r) => s + Number(r.amount), 0);
  return { ot, sh, otTotal, shTotal };
}

async function refreshTotals(company, month) {
  await q(`INSERT INTO labour_period(company,period) VALUES($1,$2) ON CONFLICT (company,period) DO NOTHING`, [company, month]);
  await q(`UPDATE labour_period SET
     ot_total = COALESCE((SELECT SUM(amount) FROM labour_ot WHERE company=$1 AND period=$2),0),
     shearing_total = COALESCE((SELECT SUM(amount) FROM labour_shearing WHERE company=$1 AND period=$2),0),
     updated_at=now() WHERE company=$1 AND period=$2`, [company, month]);
}

async function applyEdits(body) {
  const company = CO[String(body.company || '').toUpperCase()];
  const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? body.month : null;
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (!company || !month) return { ok: false, error: 'Bad company/month', company, month };

  const results = [];
  for (const o of ops) {
    const kind = o.kind === 'shearing' ? 'shearing' : 'ot';
    const table = kind === 'ot' ? 'labour_ot' : 'labour_shearing';
    const name = String(o.name || '').trim();
    if (!name) { results.push({ ...o, changed: 0, note: 'empty name' }); continue; }

    if (o.op === 'remove') {
      // Case/space-insensitive exact match (handles "Lita  murmu" vs "Lita murmu").
      const r = await q(
        `DELETE FROM ${table} WHERE company=$1 AND period=$2
           AND regexp_replace(lower(btrim(labour_name)),'\\s+',' ','g') = $3
         RETURNING labour_name, amount`,
        [company, month, norm(name)]);
      results.push({ op: 'remove', kind, name, changed: r.rows.length, matched: r.rows.map(x => x.labour_name) });
    } else if (o.op === 'add') {
      const amount = Math.round(Number(o.amount));
      if (!(amount > 0)) { results.push({ ...o, changed: 0, note: 'bad amount' }); continue; }
      const code = String(o.code || '').trim();
      if (kind === 'ot') {
        const hours = +(amount / 100).toFixed(2);
        await q(`INSERT INTO labour_ot(company,labour_code,labour_name,ot_date,period,hours,amount,entered_by_name)
                 VALUES($1,$2,$3,($4||'-01')::date,$4,$5,$6,'manual (report-edit)')`,
          [company, code, name, month, hours, amount]);
      } else {
        const days = +(amount / 50).toFixed(1);
        await q(`INSERT INTO labour_shearing(company,labour_code,labour_name,days,amount,period,entered_by_name)
                 VALUES($1,$2,$3,$4,$5,$6,'manual (report-edit)')`,
          [company, code, name, days, amount, month]);
      }
      results.push({ op: 'add', kind, name, amount, changed: 1 });
    } else {
      results.push({ ...o, changed: 0, note: 'unknown op' });
    }
  }

  await refreshTotals(company, month);
  const after = await listPeople(company, month);
  return { ok: true, company, month, results, after };
}

module.exports = { applyEdits, listPeople };
