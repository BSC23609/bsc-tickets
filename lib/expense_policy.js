// Loads the admin-editable expense policy (per-km rates + daily category limits)
// from the DB, lightly cached. Category falls back to CAT2 when unset.
const { q } = require('./db');

let _cache = null, _at = 0;

async function getPolicy() {
  if (_cache && Date.now() - _at < 30000) return _cache;
  const { rows } = await q('SELECT key, value FROM expense_policy');
  const m = {}; for (const r of rows) m[r.key] = Number(r.value);
  _cache = {
    rates: { bike: m.rate_bike ?? 3.5, car: m.rate_car ?? 5 },
    limits: {
      CAT1: { food: m.cat1_food ?? 750, accom: m.cat1_accom ?? 1500 },
      CAT2: { food: m.cat2_food ?? 500, accom: m.cat2_accom ?? 1000 },
    },
    log_hours: m.conveyance_log_hours ?? 48,
  };
  _at = Date.now();
  return _cache;
}
function invalidate() { _cache = null; }
const catOf = (emp) => (emp && emp.expense_category === 'CAT1' ? 'CAT1' : 'CAT2');

module.exports = { getPolicy, invalidate, catOf };
