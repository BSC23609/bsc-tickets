// WATI (WhatsApp Business API) notifications.
// Proactive WhatsApp messages must use PRE-APPROVED TEMPLATES (Meta rule). Create
// these five templates in your WATI dashboard with the parameter order documented
// below, then set WATI_BASE_URL + WATI_TOKEN. Until then, sends are logged, not sent.
//
//  Template name            Sent to    Parameters (in order)
//  -----------------------  ---------  --------------------------------------------
//  ticket_raised            L1         1 handler  2 ref  3 category  4 priority  5 requester  6 subject
//  ticket_escalated_l2      L2         1 handler  2 ref  3 category  4 priority  5 requester  6 subject
//  ticket_escalated_l3      L3         1 handler  2 ref  3 category  4 priority  5 requester  6 subject
//  ticket_resolved          requester  1 requester 2 ref 3 subject  4 resolver
//  ticket_reopened          L1         1 handler  2 ref  3 subject  4 requester

const BASE = (process.env.WATI_BASE_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WATI_TOKEN || '';
const configured = () => Boolean(BASE && TOKEN);

const TEMPLATES = {
  raised:       'ticket_raised',
  escalated_l2: 'ticket_escalated_l2',
  escalated_l3: 'ticket_escalated_l3',
  resolved:     'ticket_resolved',
  reopened:     'ticket_reopened',
};

function warn(m) { console.warn('[wati] ' + m); }

// WATI expects { name, value } pairs keyed "1","2",… when using ordered params.
async function sendTemplate(phone, templateName, orderedParams) {
  if (!phone) { warn('no phone for ' + templateName); return false; }
  const params = orderedParams.map((v, i) => ({ name: String(i + 1), value: String(v ?? '') }));
  if (!configured()) {
    console.log(`[wati] (not configured) would send "${templateName}" to ${phone}:`,
      orderedParams.join(' | '));
    return false;
  }
  try {
    const url = `${BASE}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: TOKEN.startsWith('Bearer') ? TOKEN : `Bearer ${TOKEN}`,
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_name: templateName, broadcast_name: templateName, parameters: params }),
    });
    if (!r.ok) { warn(`${templateName} -> ${r.status} ${(await r.text()).slice(0, 200)}`); return false; }
    return true;
  } catch (e) { warn('send failed: ' + e.message); return false; }
}

// Convenience wrappers (fire-and-forget from callers).
const notify = {
  raised: (h, t) => sendTemplate(h.phone, TEMPLATES.raised,
    [h.name, t.ref_no, t.category_name, t.priority, t.requester_name, t.subject]),
  escalatedL2: (h, t) => sendTemplate(h.phone, TEMPLATES.escalated_l2,
    [h.name, t.ref_no, t.category_name, t.priority, t.requester_name, t.subject]),
  escalatedL3: (h, t) => sendTemplate(h.phone, TEMPLATES.escalated_l3,
    [h.name, t.ref_no, t.category_name, t.priority, t.requester_name, t.subject]),
  resolved: (req, t, resolver) => sendTemplate(req.phone, TEMPLATES.resolved,
    [req.name, t.ref_no, t.subject, resolver]),
  reopened: (h, t) => sendTemplate(h.phone, TEMPLATES.reopened,
    [h.name, t.ref_no, t.subject, t.requester_name]),
};

module.exports = { configured, sendTemplate, notify, TEMPLATES };
