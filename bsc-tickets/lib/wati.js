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
};

const OUTPASS_TPL = {
  request:  'outpass_request2',
  approved: 'outpass_approved2',
  rejected: 'outpass_rejected2',
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
  resolved: (req, t, resolver) => sendTemplate(req.phone, TEMPLATES.resolved, {
    name: req.name, ref: t.ref_no, subject: t.subject, resolver, ticketid: t.id }),
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
};

module.exports = { configured, sendTemplate, notify, TEMPLATES, OUTPASS_TPL };
