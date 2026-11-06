// One-off OT / Shearing corrections applied server-side (behind CRON_SECRET), for when
// a management fix must be made to an already-approved month. Matches the exact SQL the
// in-app "Remove people" / "Add a line" buttons use. Returns per-op results plus the full
// current name lists so the caller can verify spellings and totals.
const { q } = require('./db');

const CO = { BSC: 'BSC', G2: 'G2' };
const STAFF_PREFIX = { BSC: 'BSC', G2: 'G2S' };
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function listPeople(company, month) {
  const ot = (await q(
    `SELECT labour_name AS name, COALESCE(SUM(amount),0)::int AS amount
     FROM labour_ot WHERE company=$1 AND period=$2 GROUP BY labour_name ORDER BY labour_name`,
    [company, month])).rows;
  const otStaff = (await q(
    `SELECT e.name AS name, COALESCE(SUM(o.amount),0)::int AS amount
     FROM ot_entries o JOIN employees e ON e.id=o.employee_id
     WHERE e.emp_no LIKE $1 AND o.status IN ('mgmt_approved','paid')
       AND o.ot_date >= ($2||'-01')::date AND o.ot_date < (($2||'-01')::date + interval '1 month')
     GROUP BY e.name ORDER BY e.name`,
    [STAFF_PREFIX[company] + '/%', month])).rows;
  const sh = (await q(
    `SELECT labour_name AS name, COALESCE(SUM(amount),0)::int AS amount
     FROM labour_shearing WHERE company=$1 AND period=$2 GROUP BY labour_name ORDER BY labour_name`,
    [company, month])).rows;
  const otTotal = ot.reduce((s, r) => s + Number(r.amount), 0) + otStaff.reduce((s, r) => s + Number(r.amount), 0);
  const shTotal = sh.reduce((s, r) => s + Number(r.amount), 0);
  return { ot, otStaff, sh, otTotal, shTotal };
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
    // ---- Find a claim by partial ref / employee name ----
    if (o.op === 'claim-find') {
      const needle = String(o.q || o.ref || o.name || '').trim();
      const rows = (await q(
        `SELECT s.ref_no, e.name AS emp, s.form_type, s.status, (s.paid_at IS NOT NULL) AS paid, s.total_amount
         FROM expense_submissions s LEFT JOIN employees e ON e.id=s.employee_id
         WHERE s.ref_no ILIKE '%'||$1||'%' OR e.name ILIKE '%'||$1||'%'
         ORDER BY s.created_at DESC LIMIT 25`, [needle])).rows;
      results.push({ op: 'claim-find', q: needle, matches: rows.map(r => ({ ref_no: r.ref_no, emp: r.emp, form_type: r.form_type, status: r.status, paid: r.paid, total_amount: Number(r.total_amount) })) });
      continue;
    }
    // ---- Expense-claim ops (identified by ref_no, not name) ----
    if (o.op === 'claim-get' || o.op === 'claim-set') {
      const ref = String(o.ref || '').trim();
      const row = (await q(`SELECT id, ref_no, form_type, status, (paid_at IS NOT NULL) AS paid, total_amount, payload FROM expense_submissions WHERE ref_no=$1`, [ref])).rows[0];
      if (!row) { results.push({ ...o, changed: 0, note: 'claim not found' }); continue; }
      const items = (row.payload && Array.isArray(row.payload.items)) ? row.payload.items.map(it => ({ desc: it.desc || it.description || '', amount: Number(it.amount || 0) })) : [];
      if (o.op === 'claim-get') {
        results.push({ op: 'claim-get', ref, form_type: row.form_type, status: row.status, paid: row.paid, total_amount: Number(row.total_amount), items });
        continue;
      }
      // claim-set
      const newTotal = Math.round(Number(o.total));
      if (!(newTotal >= 0)) { results.push({ op: 'claim-set', ref, changed: 0, note: 'bad total' }); continue; }
      const before = Number(row.total_amount);
      let itemsAfter = items;
      let payloadUpdated = false;
      if (row.form_type === 'misc' && row.payload && Array.isArray(row.payload.items) && row.payload.items.length) {
        const src = row.payload.items;
        const oldSum = src.reduce((s, it) => s + Number(it.amount || 0), 0);
        const newItems = src.map(it => ({ ...it }));
        if (newItems.length === 1) {
          newItems[0].amount = newTotal;
        } else if (oldSum > 0) {
          let acc = 0;
          for (let i = 0; i < newItems.length; i++) {
            if (i === newItems.length - 1) { newItems[i].amount = newTotal - acc; }
            else { const v = Math.round(Number(newItems[i].amount || 0) * newTotal / oldSum); newItems[i].amount = v; acc += v; }
          }
        }
        const newPayload = { ...row.payload, items: newItems };
        await q(`UPDATE expense_submissions SET total_amount=$2, payload=$3::jsonb, updated_at=now() WHERE id=$1`, [row.id, newTotal, JSON.stringify(newPayload)]);
        payloadUpdated = true;
        itemsAfter = newItems.map(it => ({ desc: it.desc || it.description || '', amount: Number(it.amount || 0) }));
      } else {
        await q(`UPDATE expense_submissions SET total_amount=$2, updated_at=now() WHERE id=$1`, [row.id, newTotal]);
      }
      results.push({ op: 'claim-set', ref, from: before, to: newTotal, changed: 1, form_type: row.form_type, paid: row.paid, line_items_rescaled: payloadUpdated, items: itemsAfter });
      continue;
    }

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
      let changed = r.rows.length, matched = r.rows.map(x => x.labour_name), via = 'labour';
      // OT: if no labour row matched, the person may be a staff employee (ot_entries).
      if (kind === 'ot' && changed === 0) {
        const s = await q(
          `DELETE FROM ot_entries o USING employees e
           WHERE o.employee_id=e.id AND e.emp_no LIKE $1
             AND regexp_replace(lower(btrim(e.name)),'\\s+',' ','g') = $2
             AND o.status IN ('mgmt_approved','paid')
             AND o.ot_date >= ($3||'-01')::date AND o.ot_date < (($3||'-01')::date + interval '1 month')
           RETURNING e.name, o.amount`,
          [STAFF_PREFIX[company] + '/%', norm(name), month]);
        changed = s.rows.length; matched = s.rows.map(x => x.name); via = 'staff';
      }
      results.push({ op: 'remove', kind, name, changed, via, matched });
    } else if (o.op === 'adjust') {
      // Reduce/increase a STAFF employee's OT total by `delta` (e.g. -50), applied to one
      // ot_entries row large enough to absorb it. Keeps amounts >= 0.
      const delta = Math.round(Number(o.delta));
      if (!delta) { results.push({ ...o, changed: 0, note: 'no delta' }); continue; }
      const sel = await q(
        `SELECT o.id, o.amount, e.name FROM ot_entries o JOIN employees e ON e.id=o.employee_id
         WHERE e.emp_no LIKE $1
           AND regexp_replace(lower(btrim(e.name)),'\\s+',' ','g') = $2
           AND o.status IN ('mgmt_approved','paid')
           AND o.ot_date >= ($3||'-01')::date AND o.ot_date < (($3||'-01')::date + interval '1 month')
           AND o.amount + $4 >= 0
         ORDER BY o.amount DESC LIMIT 1`,
        [STAFF_PREFIX[company] + '/%', norm(name), month, delta]);
      if (!sel.rows.length) { results.push({ op: 'adjust', kind, name, delta, changed: 0, note: 'no matching staff row big enough' }); continue; }
      const row = sel.rows[0];
      await q(`UPDATE ot_entries SET amount = amount + $2, updated_at=now() WHERE id=$1`, [row.id, delta]);
      results.push({ op: 'adjust', kind, name: row.name, delta, changed: 1, from: Number(row.amount), to: Number(row.amount) + delta });
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
