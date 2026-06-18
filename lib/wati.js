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
  resolved:     'ticket_resolved2',
  reopened:     'ticket_reopened2',
  assigned:     'ticket_assigned2',
  reminder:     'ticket_reminder2',
  forwarded:    'ticket_forwarded',
  dailyReport:  'daily_ticket_report',
};

const OUTPASS_TPL = {
  request:  'outpass_request2',
  approved: 'outpass_approved2',
  rejected: 'outpass_rejected2',
};

const EXPENSE_TPL = {
  cv_request:  'conveyance_request',
  cv_approved: 'conveyance_approved',
  cv_rejected: 'conveyance_rejected',
};

const CHAIN_TPL = {
  submitted:    'expense_submitted',
  final_review: 'expense_final_review',
  returned:     'expense_returned',
  paid:         'expense_paid',
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
async function sendTemplate(phone, templateName, params) {
  if (!phone) { warn('no phone for ' + templateName); return false; }
  const parameters = Object.entries(params).map(([name, value]) => ({ name, value: String(value ?? '') }));
  if (!configured()) {
    console.log(`[wati] (not configured) would send "${templateName}" to ${phone}:`,
      JSON.stringify(params));
    return false;
  }
  try {
    const url = `${BASE}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: TOKEN.startsWith('Bearer') ? TOKEN : `Bearer ${TOKEN}`,
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_name: templateName, broadcast_name: templateName, parameters }),
    });
    if (!r.ok) { warn(`${templateName} -> ${r.status} ${(await r.text()).slice(0, 200)}`); return false; }
    return true;
  } catch (e) { warn('send failed: ' + e.message); return false; }
}

// Convenience wrappers (call fire-and-forget; each passes `ticketid` for the button).
const notify = {
  raised: (h, t) => sendTemplate(h.phone, TEMPLATES.raised, {
    name: h.name, ref: t.ref_no, requester: t.requester_name,
    category: withIcon(t.category_name), priority: t.priority, subject: t.subject, ticketid: t.id }),
  resolved: (req, t, resolver, remark) => sendTemplate(req.phone, TEMPLATES.resolved, {
    name: req.name, ref: t.ref_no, subject: t.subject, resolver, remark: remark || 'No remarks', ticketid: t.id }),
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
    total: r.total, open: r.open, closed: r.closed, reportdate: r.dateISO }),

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
  },

  // Payment-approval chain (HR → final approver → accounts)
  expense: {
    submitted:   (hr, s)  => sendTemplate(hr.phone,  CHAIN_TPL.submitted,    { name: hr.name,  ref: s.ref_no, requester: s.emp_name, form: s.form_label, period: s.period_label, total: s.total_label, link: s.id }),
    finalReview: (ap, s)  => sendTemplate(ap.phone,  CHAIN_TPL.final_review, { name: ap.name,  ref: s.ref_no, requester: s.emp_name, form: s.form_label, period: s.period_label, total: s.total_label, link: s.id }),
    returned:    (emp, s) => sendTemplate(emp.phone, CHAIN_TPL.returned,     { name: emp.name, ref: s.ref_no, form: s.form_label, period: s.period_label, stage: s.stage_label, reason: s.reason, link: s.id }),
    paid:        (acc, s) => sendTemplate(acc.phone, CHAIN_TPL.paid,         { name: acc.name, ref: s.ref_no, requester: s.emp_name, form: s.form_label, period: s.period_label, total: s.total_label }),
  },
};

module.exports = { configured, sendTemplate, notify, TEMPLATES, OUTPASS_TPL, EXPENSE_TPL, CHAIN_TPL };
