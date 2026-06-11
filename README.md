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
   `Files.ReadWrite.All` + `Mail.Send` (admin-consented), for the `hr@bharatsteels.in`
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

Proactive WhatsApp requires pre-approved templates. Create five, with body parameters
in this exact order ({{1}}, {{2}}, …):

| Template name          | Goes to   | Parameters |
|------------------------|-----------|------------|
| `ticket_raised`        | L1        | handler, ref, category, priority, requester, subject |
| `ticket_escalated_l2`  | L2        | handler, ref, category, priority, requester, subject |
| `ticket_escalated_l3`  | L3        | handler, ref, category, priority, requester, subject |
| `ticket_resolved`      | requester | requester, ref, subject, resolver |
| `ticket_reopened`      | L1        | handler, ref, subject, requester |

Suggested `ticket_raised` body: *"Hi {{1}}, a new ticket {{2}} ({{3}}, {{4}} priority)
was raised by {{5}}: {{6}}. Please action it in the BSC Tickets portal."*

---

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
