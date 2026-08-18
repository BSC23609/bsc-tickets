// WATI (WhatsApp Business API) notifications.
//
// ── IMPORTANT: create all five templates as CATEGORY = UTILITY ──────────────
// Utility templates are exempt from Meta's per-user marketing frequency cap, so
// they deliver reliably. Keep the wording purely transactional (no greetings-as-
// marketing, no upsell, no promo) or Meta will reclassify them as Marketing.
//
// Each template has a dynamic "Visit Website" button whose URL is:
//     https://tickets.bharatsteels.in/t/{{ticketid}}
// (only the LAST part of the URL may be dynamic — here it's the ticket id, which
// the app turns into a deep link to that ticket after login).
//
// WATI matches variables BY NAME via the flat `parameters` array. Name the body
// and button variables exactly as below when you build each template:
//
//  Template name          To              Variables (name them exactly)
//  ---------------------  --------------  -------------------------------------------------
//  ticket_raised2         L1 / L2         name, ref, requester, category, priority, subject, ticketid
//  ticket_assigned2       L1              name, ref, requester, category, priority, subject, ticketid
//  ticket_reminder2       L1 / L2 / L3    name, ref, requester, category, subject, elapsed, ticketid
//  ticket_resolved2       requester       name, ref, subject, resolver, ticketid
//  ticket_reopened2       L1              name, ref, subject, requester, ticketid
//
// `ticketid` is the variable used in the button URL. Until WATI_BASE_URL +
// WATI_TOKEN are set, sends are logged (not sent) so nothing fails silently.

const BASE = (process.env.WATI_BASE_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WATI_TOKEN || '';
const configured = () => Boolean(BASE && TOKEN);

const TEMPLATES = {
  raised:       'ticket_raised2',
  maint_gate:   process.env.WATI_MAINT_GATE_TPL || 'maint_gate_approval',
  maint_rejected: process.env.WATI_MAINT_REJECTED_TPL || 'maint_gate_rejected',
  resolved:     'ticket_resolved4',
  reopened:     'ticket_reopened2',
  assigned:     'ticket_assigned2',
  reminder:     'ticket_reminder2',
  forwarded:    'ticket_forwarded2',
  ot_approval:  process.env.WATI_OT_APPROVAL_TPL || 'ot_approval',
  ot_rejected:  process.env.WATI_OT_REJECTED_TPL || 'ot_rejected',
  ot_hr_verify: process.env.WATI_OT_HR_TPL || 'ot_hr_verify',
  ot_mgmt:      process.env.WATI_OT_MGMT_TPL || 'ot_mgmt_approval',
  ot_accounts:  process.env.WATI_OT_ACCOUNTS_TPL || 'ot_accounts_pay',
  // v3 adds the {{pending}} variable (backlog from earlier days). Override via env if the
  // Meta approval for the new template hasn't landed yet.
  dailyReport:  process.env.WATI_DAILY_TPL   || 'daily_ticket_report3',
  myReport:     process.env.WATI_MYREPORT_TPL || 'my_ticket_report2',
  document:     'ticket_document',
  external:     'ticket_external',
  welcome:      'employee_welcome6',
};

const OUTPASS_TPL = {
  request:  'outpass_request2',
  approved: 'outpass_approved2',
  rejected: 'outpass_rejected2',
  overdue:  process.env.WATI_OVERDUE_TPL || 'outpass_overdue',   // gatepass not returned on time (→ HR/approver)
  returnReminder: process.env.WATI_RETURN_REMINDER_TPL || 'gatepass_return_reminder', // → requester, log your return
};

const EXPENSE_TPL = {
  cv_request:  process.env.WATI_CV_REQUEST_TPL  || 'conveyance_request_1',
  cv_approved: process.env.WATI_CV_APPROVED_TPL || 'conveyance_approved',
  cv_rejected: process.env.WATI_CV_REJECTED_TPL || 'conveyance_rejected',
  cv_pending:  process.env.WATI_CV_PENDING_TPL  || 'conveyance_pending',   // daily digest to a manager sitting on pending trips
};

const CHAIN_TPL = {
  submitted:    'expense_submitted',
  final_review: 'expense_final_review',
  returned:     'expense_returned',
  paid:         'expense_paid',
  cmd:          'expense_cmd',   // to CMD: body {name,note,requester,form,period,total,ref} + URL button "Download PDF" -> /dlx/{{token}}
  report:       'expense_report',// to CMD: body {name,cycle,count,total} + URL button "Download Excel" -> /rx/{{token}}
};

function warn(m) { console.warn('[wati] ' + m); }

// Per-category icon, prepended to the {{category}} value so the template shows it.
// Falls back to a neutral icon for any admin-added category.
const CATEGORY_ICON = {
  'IT / Network / Devices': '💻',
  'Maintenance / Facilities': '🔧',
  'SAP': '⚙️',
  'HR Query (HRM Request)': '👤',
};
const withIcon = (name) => `${CATEGORY_ICON[name] || '📋'} ${name || ''}`.trim();

// params: a plain object { varName: value, ... } — including `ticketid` for the
// dynamic URL button. WATI maps these to the template's named variables.
// WATI needs the full international number (e.g. 919994567890). Employee records are inconsistent —
// some have the 91 prefix, some are bare 10-digit, some have spaces/dashes/+. Normalize before sending,
// otherwise WATI silently declines (validWhatsAppNumber:false) for the badly-formatted ones only.
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d]/g, '');
  if (!p) return '';
  if (p.length === 10) p = '91' + p;                         // bare Indian mobile
  else if (p.length === 11 && p.startsWith('0')) p = '91' + p.slice(1); // leading 0
  return p;                                                  // 12-digit 91… or already international: leave
}

// Record every WATI send attempt so silent failures are visible in the admin log.
// Best-effort: logging must never break (or slow to a crawl) the actual send.
async function logWa(phone, template, result, detail) {
  try {
    const { q } = require('./db');
    await q(`INSERT INTO wa_log(phone, template, result, detail) VALUES($1,$2,$3,$4)`,
      [String(phone || ''), String(template || ''), result, String(detail || '').slice(0, 500)]);
  } catch (e) { /* never let logging break a notification */ }
}

// WATI rejects template params containing newlines, tabs, or 4+ consecutive spaces
// (HTTP 400 "Sample Content param text..."). Collapse all whitespace to single spaces.
function cleanParam(v){ return String(v ?? '').replace(/\s+/g, ' ').trim(); }

async function sendTemplate(phone, templateName, params) {
  const orig = phone;
  phone = normalizePhone(phone);
  if (!phone) { warn('no phone for ' + templateName); await logWa(orig, templateName, 'no_phone', 'empty/invalid number'); return false; }
  const parameters = Object.entries(params).map(([name, value]) => ({ name, value: cleanParam(value) || '-' }));
  if (!configured()) {
    console.log(`[wati] (not configured) would send "${templateName}" to ${phone}:`, JSON.stringify(params));
    await logWa(phone, templateName, 'skipped', 'WATI not configured');
    return false;
  }
  // Hard timeout: an unbounded fetch to WATI can hang for minutes, and on Vercel that burns the
  // whole function budget (which surfaced as 504s on the cron). Fail the send, never the run.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env.WATI_TIMEOUT_MS || 8000));
  try {
    const url = `${BASE}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: TOKEN.startsWith('Bearer') ? TOKEN : `Bearer ${TOKEN}`,
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_name: templateName, broadcast_name: templateName, parameters }),
      signal: ac.signal,
    });
    const bodyText = await r.text();
    if (!r.ok) { warn(`${templateName} -> ${r.status} ${bodyText.slice(0, 300)}`); await logWa(phone, templateName, 'http_error', `${r.status} ${bodyText.slice(0, 300)}`); return false; }
    // WATI returns HTTP 200 even when it refuses to send (template not found, parameter mismatch,
    // number not on WhatsApp...). The real outcome is in the JSON body's `result`/`validWhatsAppNumber`.
    let body = null; try { body = JSON.parse(bodyText); } catch {}
    if (body && (body.result === false || body.result === 'false' || body.validWhatsAppNumber === false)) {
      warn(`${templateName} -> WATI declined: ${bodyText.slice(0, 300)}`);
      await logWa(phone, templateName, 'declined', bodyText.slice(0, 300));
      return false;
    }
    await logWa(phone, templateName, 'sent', '');
    return true;
  } catch (e) {
    warn(e.name === 'AbortError' ? `${templateName} -> timed out` : 'send failed: ' + e.message);
    await logWa(phone, templateName, 'error', e.name === 'AbortError' ? 'timed out' : e.message);
    return false;
  } finally { clearTimeout(timer); }
}

// Convenience wrappers (call fire-and-forget; each passes `ticketid` for the button).
const notify = {
  ot: {
    // To the approver (Kannan / Kumar) when a staff member submits OT for approval.
    approval: (approver, o) => sendTemplate(approver.phone, TEMPLATES.ot_approval, {
      name: approver.name || 'Sir', employee: o.employee, date: o.date,
      hours: String(o.hours), amount: String(o.amount), pending: String(o.pending || 1),
      token: o.token || '' }),
    // To the employee when their OT is rejected — so they can revert & fix it.
    rejected: (emp, o) => sendTemplate(emp.phone, TEMPLATES.ot_rejected, {
      name: emp.name || '', date: o.date, amount: String(o.amount), stage: o.stage || 'approver', reason: o.reason || '-' }),
    // To HR (Rajasekar) when approved OT is waiting for verification.
    hrVerify: (hr, o) => sendTemplate(hr.phone, TEMPLATES.ot_hr_verify, {
      name: hr.name || 'Sir', count: String(o.count), total: String(o.total) }),
    // To Management (Goverdhan / Gourav / Shivam) for final approval of the monthly OT report.
    mgmt: (mgr, o) => sendTemplate(mgr.phone, TEMPLATES.ot_mgmt, {
      name: mgr.name || 'Sir', period: o.period, employees: String(o.employees),
      total: String(o.total) }),
    // To Accounts (Lakshmi) after management approval — asks them to check email for the report.
    accounts: (acc, o) => sendTemplate(acc.phone, TEMPLATES.ot_accounts, {
      name: acc.name || 'Sir', period: o.period, employees: String(o.employees), total: String(o.total) }),
  },
  raised: (h, t) => sendTemplate(h.phone, TEMPLATES.raised, {
    name: h.name, ref: t.ref_no, requester: t.requester_name,
    category: withIcon(t.category_name), priority: t.priority, subject: t.subject, ticketid: t.id }),
  // Maintenance gate: one-tap approve/reject to the gatekeeper (Mathan). Carries the token for the button.
  maintGate: (gk, t) => sendTemplate(gk.phone, TEMPLATES.maint_gate, {
    name: gk.name || 'Sir', ref: t.ref_no, requester: t.requester_name || '',
    subject: t.subject || '', category: t.category_name || '', token: t.maint_gate_token || '' }),
  // Maintenance gate: rejection notice to the requester.
  maintRejected: (req, t) => sendTemplate(req.phone, TEMPLATES.maint_rejected, {
    name: req.name || '', ref: t.ref_no || '', subject: t.subject || '' }),
  resolved: (req, t, resolver, remark) => sendTemplate(req.phone, TEMPLATES.resolved, {
    name: req.name, ref: t.ref_no, subject: t.subject, resolver, remark: remark || 'No remarks',
    ticketid: t.id, ctoken: t.confirm_token || '', rtoken: t.confirm_token || '' }),
  reopened: (h, t) => sendTemplate(h.phone, TEMPLATES.reopened, {
    name: h.name, ref: t.ref_no, subject: t.subject, requester: t.requester_name, ticketid: t.id }),

  // L2 assigned the ticket to an L1 handler.
  assigned: (h, t) => sendTemplate(h.phone, TEMPLATES.assigned, {
    name: h.name, ref: t.ref_no, requester: t.requester_name,
    category: withIcon(t.category_name), priority: t.priority, subject: t.subject, ticketid: t.id }),

  // Recurring inaction nudge. `elapsed` is a label like "2 hours" / "4 hours".
  reminder: (h, t, elapsed) => sendTemplate(h.phone, TEMPLATES.reminder, {
    name: h.name, ref: t.ref_no, requester: t.requester_name,
    category: withIcon(t.category_name), subject: t.subject, elapsed, ticketid: t.id }),

  // FYI to old L1, old L2, and the raiser when a ticket is forwarded to another area.
  forwarded: (p, t, fromCat, toCat) => sendTemplate(p.phone, TEMPLATES.forwarded, {
    name: p.name, ref: t.ref_no, subject: t.subject, from: fromCat, to: toCat, ticketid: t.id }),

  // Daily 6:30pm report. `reportdate` is the URL-button variable (appended to the
  // template's button base, e.g. https://tickets.bharatsteels.in/api/report/daily.pdf?key=…&date=).
  dailyReport: (to, r) => sendTemplate(to.phone, TEMPLATES.dailyReport, {
    name: to.name || 'Sir', date: r.label || r.dateISO,
    total: r.total, open: r.open,
    closed: (r.closed_total != null ? r.closed_total : r.closed),
    pending: String(r.pending || 0), reportdate: r.dateISO }),

  // Ticket put on external/vendor hold — to requester + L2. eta = "48 working hours".
  external: (req, t, by, eta, reason) => sendTemplate(req.phone, TEMPLATES.external, {
    name: req.name, ref: t.ref_no, subject: t.subject, by, eta, reason, ticketid: String(t.id) }),

  // Resolution attachment(s). Button variable `token` is the ticket's confirm_token,
  // appended to a base like https://tickets.bharatsteels.in/rd/
  document: (req, t) => sendTemplate(req.phone, TEMPLATES.document, {
    name: req.name, ref: t.ref_no, subject: t.subject, token: t.confirm_token || '' }),

  // Per-employee scoped report. The button variable `q` is "<date>_<empId>", appended
  // to a base like https://tickets.bharatsteels.in/api/report/daily.pdf?key=…&q=
  myReport: (to, r) => sendTemplate(to.phone, TEMPLATES.myReport, {
    name: to.name || 'there', date: r.label || r.dateISO,
    total: r.total, open: r.open,
    closed: (r.closed_total != null ? r.closed_total : r.closed),
    pending: String(r.pending || 0), q: `${r.dateISO}_${r.empId}` }),

  // New-employee onboarding / welcome. Sent once on add (and on demand via the
  // admin "Welcome" button). Template employee_welcome6 — variables: name, empno.
  // Static "Open BSC Portal" URL button -> https://tickets.bharatsteels.in
  welcome: (emp) => sendTemplate(emp.phone, TEMPLATES.welcome, {
    name: (emp.name || '').trim().split(/\s+/)[0] || emp.name || 'there',
    empno: emp.emp_no }),

  // ── Outpass / Gatepass (all Utility category) ──────────────────────────────
  // Templates in WATI:
  //  outpass_request2   approver   name, ref, requester, type, purpose, date, out_time
  //                                 two URL buttons (token): Approve -> /oga/{{token}}, Reject -> /ogr/{{token}}
  //  outpass_approved2  requester  name, ref, type, approver   button "Download pass" -> /dl/{{token}}
  //  outpass_rejected2  requester  name, ref, type, approver, reason   (no button)
  outpass: {
    request: (approver, o) => sendTemplate(approver.phone, OUTPASS_TPL.request, {
      name: approver.name, ref: o.ref_no, requester: o.requester_name,
      type: o.type === 'gatepass' ? 'Gatepass' : 'Outpass', purpose: o.purpose || '-',
      date: o.date_label, out_time: o.out_time || '-', token: o.action_token }),
    approved: (req, o) => sendTemplate(req.phone, OUTPASS_TPL.approved, {
      name: req.name, ref: o.ref_no, type: o.type === 'gatepass' ? 'Gatepass' : 'Outpass',
      approver: o.actioned_by_name, token: o.pdf_token }),
    rejected: (req, o) => sendTemplate(req.phone, OUTPASS_TPL.rejected, {
      name: req.name, ref: o.ref_no, type: o.type === 'gatepass' ? 'Gatepass' : 'Outpass',
      approver: o.actioned_by_name, reason: o.reject_reason || '-' }),
    // Overdue gatepass alert → approver + HR. `to` is {name, phone}; `o` carries the details.
    overdue: (to, o) => sendTemplate(to.phone, OUTPASS_TPL.overdue, {
      name: to.name || 'Sir', employee: o.employee || o.req_name || '-', ref: o.ref || o.ref_no || '-',
      out_time: o.out_time || '-', expected: o.expected || o.in_time || '-',
      overdue_min: String(o.overdue_min ?? '-'), purpose: o.purpose || '-',
      duty: o.duty || '-' }),
    returnReminder: (to, o) => sendTemplate(to.phone, OUTPASS_TPL.returnReminder, {
      name: to.name || o.employee || '-', ref: o.ref || o.ref_no || '-',
      out_time: o.out_time || '-', expected: o.expected || o.in_time || '-',
      overdue_min: String(o.overdue_min ?? '-') }),
  },

  // Local Conveyance → reporting-manager one-tap approval (per trip)
  conveyance: {
    request: (mgr, t) => sendTemplate(mgr.phone, EXPENSE_TPL.cv_request, {
      name: mgr.name, requester: t.requester, date: t.date_label,
      route: t.route, amount: t.amount_label, token: t.action_token }),
    approved: (emp, t) => sendTemplate(emp.phone, EXPENSE_TPL.cv_approved, {
      name: emp.name, date: t.date_label, route: t.route, approver: t.approver_name }),
    rejected: (emp, t) => sendTemplate(emp.phone, EXPENSE_TPL.cv_rejected, {
      name: emp.name, date: t.date_label, route: t.route, approver: t.approver_name, reason: t.reason }),
    // Daily digest: one message per manager with trips still awaiting them.
    pending: (mgr, d) => sendTemplate(mgr.phone, EXPENSE_TPL.cv_pending, {
      name: mgr.name, count: d.count, total: d.total_label, oldest: d.oldest, people: d.people }),
  },

  // Payment-approval chain (HR → final approver → accounts)
  expense: {
    submitted:   (hr, s)  => sendTemplate(hr.phone,  CHAIN_TPL.submitted,    { name: hr.name,  ref: s.ref_no, requester: s.emp_name, form: s.form_label, period: s.period_label, total: s.total_label, link: s.id }),
    finalReview: (ap, s)  => sendTemplate(ap.phone,  CHAIN_TPL.final_review, { name: ap.name,  ref: s.ref_no, requester: s.emp_name, form: s.form_label, period: s.period_label, total: s.total_label, link: s.id }),
    returned:    (emp, s) => sendTemplate(emp.phone, CHAIN_TPL.returned,     { name: emp.name, ref: s.ref_no, form: s.form_label, period: s.period_label, stage: s.stage_label, reason: s.reason, link: s.id }),
    paid:        (acc, s) => sendTemplate(acc.phone, CHAIN_TPL.paid,         { name: acc.name, ref: s.ref_no, requester: s.emp_name, form: s.form_label, period: s.period_label, total: s.total_label }),
    cmd:         (cmd, s, note) => sendTemplate(cmd.phone, CHAIN_TPL.cmd,     { name: cmd.name, note: note || '', requester: s.emp_name, form: s.form_label, period: s.period_label, total: s.total_label, ref: s.ref_no, token: s.pdf_token || '' }),
    report:      (cmd, s) => sendTemplate(cmd.phone, CHAIN_TPL.report,          { name: cmd.name, cycle: s.cycle, count: String(s.count), total: s.total_label, token: s.token }),
  },
};

module.exports = { configured, sendTemplate, notify, TEMPLATES, OUTPASS_TPL, EXPENSE_TPL, CHAIN_TPL, sendTemplateDebug };

// Diagnostic: send a template and return WATI's RAW reply (status + body) so an admin can see
// exactly why a send is or isn't going through, without digging through server logs.
async function sendTemplateDebug(phone, templateName, params) {
  if (!configured()) return { configured: false, note: 'WATI_BASE_URL / WATI_TOKEN not set — nothing is sent' };
  const parameters = Object.entries(params).map(([name, value]) => ({ name, value: cleanParam(value) || '-' }));
  const url = `${BASE}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env.WATI_TIMEOUT_MS || 8000));
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: TOKEN.startsWith('Bearer') ? TOKEN : `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_name: templateName, broadcast_name: templateName, parameters }),
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { configured: true, phone, template: templateName, sent_params: parameters,
             http_status: r.status, wati_result: json && json.result, response: (json || text) };
  } catch (e) {
    return { configured: true, phone, template: templateName, error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}
