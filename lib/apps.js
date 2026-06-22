// Catalogue of portal apps shown on the home launcher.
// `restricted: true` apps are hidden by default and granted per employee (admins see all).
// Adding a new restricted app later = one entry here + one tile in public/home.html.
const APPS = [
  { key: 'tickets',  restricted: false },
  { key: 'outpass',  restricted: false },
  { key: 'expense',  restricted: false },
  { key: 'qms',      restricted: true  },
  { key: 'dispatch', restricted: true  },
  { key: 'genset',   restricted: true  },
];

const RESTRICTED = APPS.filter((a) => a.restricted).map((a) => a.key); // ['qms','dispatch']

// Returns a map { tickets:true, outpass:true, expense:true, qms:bool, dispatch:bool }.
// Non-restricted apps are always visible; restricted apps need is_admin or an explicit grant.
function appAccessFor(emp) {
  const acc = (emp && emp.app_access) || {};
  const out = {};
  for (const a of APPS) {
    out[a.key] = a.restricted ? (!!(emp && emp.is_admin) || acc[a.key] === true) : true;
  }
  return out;
}

module.exports = { APPS, RESTRICTED, appAccessFor };
