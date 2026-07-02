// Expense payment-approval chain config, stored as JSON in app_settings('expense_chain').
const { q } = require('./db');

let _c = null, _at = 0;
const DEFAULTS = { hr_approver_ids: [], final_approver_ids: [], accounts_email: 'accounts@bharatsteels.in', accounts_notify_id: null, cmd_notify_id: null };

async function getChain() {
  if (_c && Date.now() - _at < 15000) return _c;
  const r = (await q(`SELECT value FROM app_settings WHERE key='expense_chain'`)).rows[0];
  let v = {}; try { v = r ? JSON.parse(r.value) : {}; } catch { v = {}; }
  _c = { ...DEFAULTS, ...v };
  _c.hr_approver_ids = (_c.hr_approver_ids || []).map(Number);
  _c.final_approver_ids = (_c.final_approver_ids || []).map(Number);
  _c.accounts_notify_id = _c.accounts_notify_id ? Number(_c.accounts_notify_id) : null;
  _c.cmd_notify_id = _c.cmd_notify_id ? Number(_c.cmd_notify_id) : null;
  _at = Date.now();
  return _c;
}
async function setChain(cfg) {
  const v = JSON.stringify({ ...DEFAULTS, ...cfg });
  await q(`INSERT INTO app_settings(key,value) VALUES('expense_chain',$1)
           ON CONFLICT(key) DO UPDATE SET value=$1`, [v]);
  _c = null;
}
function invalidate() { _c = null; }

module.exports = { getChain, setChain, invalidate };
