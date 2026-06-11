# BSC Ticket Management System

Standalone internal ticketing for Bharat Steel (Chennai). Employees raise tickets
(IT, Maintenance/Facilities, SAP, HR), they auto-route to the right handler with
requester-initiated escalation, WhatsApp notifications, OneDrive photo + Excel logging,
and an admin dashboard.

Stack: Node/Express (single Vercel serverless function) · Neon Postgres · vanilla JS +
Tailwind frontend · Microsoft Graph (OneDrive/Excel/mail) · WATI (WhatsApp).

---

## What you need to generate (the only things not in this repo)

1. **Neon `DATABASE_URL`** — create a free project at neon.tech, copy the **pooled**
   connection string (host contains `-pooler`).
2. **Microsoft Graph app registration** — Azure app with **application** permissions
   `Files.ReadWrite.All` (admin-consented) — Mail.Send is NOT needed (no email), for the `hr@bharatsteels.in`
   mailbox/drive. Gives you `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`.
3. **WATI** — `WATI_BASE_URL` + `WATI_TOKEN`, and five pre-approved WhatsApp templates
   (see below).

The app **runs without these** — notifications and photo storage degrade gracefully and
log loudly until the secrets are added. Nothing fails silently.

---

## Local run

```bat
npm install
copy .env.example .env       :: then fill in DATABASE_URL (minimum) + JWT_SECRET
npm run migrate              :: creates tables, seeds 53 employees + routing + locations
npm run dev                  :: http://localhost:3000
```

Login with any employee number (e.g. `BSC/006`) and password `Bsc@123`. First login
forces a password change. Admins (`CMD`, `CEO`, `BSC/017`, `BSC/006`, `BSC/119`) land on
the admin panel; everyone else on the app.

---

## Deploy to Vercel (tickets.bharatsteels.in)

1. Push this repo to `github.com/BSC23609/bsc-tickets` (use `push.bat`).
2. In Vercel: **Add New Project** → import the repo. No build command needed.
3. **Settings → Environment Variables**: add everything from `.env.example`
   (`DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`, the `GRAPH_*` and `WATI_*` values).
4. **Run the migration once** against the Neon DB — easiest from your PC:
   set `DATABASE_URL` in `.env` and run `npm run migrate`.
5. **Custom domain**: Settings → Domains → add `tickets.bharatsteels.in`. In GoDaddy DNS
   add the CNAME Vercel shows you.
6. The daily 48-hour auto-close runs automatically via Vercel Cron (`vercel.json`).

---

## WATI templates (create these in your WATI dashboard)

**Create all five as CATEGORY = Utility** (not Marketing). Utility templates are exempt
from Meta's per-user frequency cap, so they deliver reliably — but the wording must stay
purely transactional (no greetings-as-marketing, emojis-as-promo, or upsell) or Meta
reclassifies them as Marketing. Employees must also have opted in once (sent any message
to your WhatsApp business number).

Each template uses **named variables** and a dynamic **Visit Website** button. Build the
button as: Button text `View ticket`, URL type **Dynamic**, URL
`https://tickets.bharatsteels.in/t/{{ticketid}}` (only the trailing `{{ticketid}}` is the
variable — the app turns it into a deep link to that ticket after login). Use the final
domain from the start: templates are read-only once submitted.

| Template name (underscores) | To | Variables to name |
|---|---|---|
| `ticket_raised` | L1 | name, ref, requester, category, priority, subject, ticketid |
| `ticket_escalated_l2` | L2 | name, ref, requester, category, priority, subject, ticketid |
| `ticket_escalated_l3` | L3 | name, ref, requester, category, priority, subject, ticketid |
| `ticket_resolved` | requester | name, ref, subject, resolver, ticketid |
| `ticket_reopened` | L1 | name, ref, subject, requester, ticketid |

Suggested `ticket_raised` body (Utility tone):
> Hi {{name}}, ticket {{ref}} has been raised by {{requester}} under {{category}} ({{priority}} priority). Issue: {{subject}}. Tap below to view and action it.

`ticketid` is the value used by the button URL; the app passes it automatically. Until
`WATI_BASE_URL` + `WATI_TOKEN` are set, notifications are logged (not sent) with a
`[wati]` prefix — nothing fails silently.

## Routing (seeded, editable in Admin → Categories & Routing)

| Category | L1 | L2 | L3 |
|---|---|---|---|
| IT / Network / Devices | Balamurali (BSC/127) | Bakthavachalam (BSC/006) | — |
| SAP | Nagasubramanian (BSC/136) | Bakthavachalam (BSC/006) | — |
| HR Query (HRM Request) | Aiswarya (BSC/125) | Bakthavachalam (BSC/006) | — |
| Maintenance / Facilities | per trade ↓ | Kannan (BSC/098) | — |
| → Mechanical | Velu (BSC/084) | | |
| → Electrical | Ragupathi (BSC/039) | | |
| → Plumbing | Ragupathi (BSC/039) | | |
| → General | Mathan (BSC/118) | | |

Cooling times default to 120 min per level; escalation is requester-initiated and becomes
available only after the cooling time elapses. L3 slots are blank for you to fill in Admin.

---

## Lifecycle

`open → in_progress → resolved → closed` (plus `reopened`). Handler marks **Resolved** →
requester gets WhatsApp → requester **Confirms** (→ closed) or **Reopens** (→ in progress).
No response in 48 h → auto-closed by the daily cron. Downtime = raised → closed.
