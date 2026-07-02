-- =====================================================================
--  BSC Ticket Management System — schema
--  Postgres (Neon).  Run once via:  npm run migrate
-- =====================================================================

CREATE TABLE IF NOT EXISTS employees (
  id            SERIAL PRIMARY KEY,
  emp_no        TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,                 -- normalised digits, e.g. 919444085016
  department    TEXT,
  job_title     TEXT,
  app_role      TEXT,
  is_admin      BOOLEAN DEFAULT FALSE,
  active        BOOLEAN DEFAULT TRUE,
  password_hash TEXT,
  must_reset    BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  active     BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  has_trades      BOOLEAN DEFAULT FALSE,
  l1_emp_id       INT REFERENCES employees(id),   -- used only when has_trades=false
  l2_emp_id       INT REFERENCES employees(id),
  l3_emp_id       INT REFERENCES employees(id),
  wait_l1_l2_mins INT DEFAULT 120,                -- cooling time L1 -> L2
  wait_l2_l3_mins INT DEFAULT 120,                -- cooling time L2 -> L3
  active          BOOLEAN DEFAULT TRUE,
  sort_order      INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trades (
  id          SERIAL PRIMARY KEY,
  category_id INT REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  l1_emp_id   INT REFERENCES employees(id),
  active      BOOLEAN DEFAULT TRUE,
  sort_order  INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tickets (
  id               SERIAL PRIMARY KEY,
  ref_no           TEXT UNIQUE NOT NULL,
  requester_id     INT REFERENCES employees(id),
  category_id      INT REFERENCES categories(id),
  trade_id         INT REFERENCES trades(id),
  priority         TEXT NOT NULL DEFAULT 'Medium',
  subject          TEXT NOT NULL,
  description       TEXT,
  location_id      INT REFERENCES locations(id),
  location_text    TEXT,
  status           TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | resolved | closed | reopened
  escalation_level INT NOT NULL DEFAULT 0,         -- 0 | 2 | 3
  l1_emp_id        INT REFERENCES employees(id),
  l2_emp_id        INT REFERENCES employees(id),
  l3_emp_id        INT REFERENCES employees(id),
  resolution_note  TEXT,
  raised_at        TIMESTAMPTZ DEFAULT now(),
  in_progress_at   TIMESTAMPTZ,
  escalated_l2_at  TIMESTAMPTZ,
  escalated_l3_at  TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  closed_auto      BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ticket_photos (
  id            SERIAL PRIMARY KEY,
  ticket_id     INT REFERENCES tickets(id) ON DELETE CASCADE,
  kind          TEXT DEFAULT 'issue',             -- issue | resolution
  file_name     TEXT,
  web_url       TEXT,
  drive_item_id TEXT,
  uploaded_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id         SERIAL PRIMARY KEY,
  ticket_id  INT REFERENCES tickets(id) ON DELETE CASCADE,
  event      TEXT,    -- raised|in_progress|escalated_l2|escalated_l3|resolved|confirmed_closed|auto_closed|reopened
  by_emp_id  INT REFERENCES employees(id),
  note       TEXT,
  at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status    ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_l1        ON tickets(l1_emp_id);
CREATE INDEX IF NOT EXISTS idx_events_ticket     ON ticket_events(ticket_id);

-- ===================== OUTPASS / GATEPASS =====================
CREATE TABLE IF NOT EXISTS outpass_approvers (
  id         SERIAL PRIMARY KEY,
  label      TEXT NOT NULL,                  -- shown in the requester's picker (e.g. "Bakthavachalam", "HR")
  emp_id     INT REFERENCES employees(id),   -- who receives the request and approves it
  active     BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0
);

-- Outpass/Gatepass routing: approver is the requester's DEPARTMENT HEAD (auto).
CREATE TABLE IF NOT EXISTS dept_approvers (
  department  TEXT PRIMARY KEY,                 -- matches employees.department (case-insensitive)
  head_emp_id INT REFERENCES employees(id),     -- the department head who approves
  active      BOOLEAN DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Small key/value store for app-wide settings (e.g. fallback approver).
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS outpass_requests (
  id               SERIAL PRIMARY KEY,
  ref_no           TEXT UNIQUE NOT NULL,
  type             TEXT NOT NULL DEFAULT 'outpass',   -- outpass | gatepass
  on_duty          BOOLEAN DEFAULT FALSE,
  req_date         DATE NOT NULL,
  requester_id     INT REFERENCES employees(id),
  purpose          TEXT,
  out_time         TEXT,                              -- 'HH:MM AM/PM' display string
  in_time          TEXT,                              -- gatepass only
  approver_id      INT REFERENCES employees(id),      -- routed-to approver
  approver_label   TEXT,                              -- chosen label (for log/display)
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  actioned_by_id   INT REFERENCES employees(id),
  actioned_by_name TEXT,
  actioned_at      TIMESTAMPTZ,
  reject_reason    TEXT,
  pdf_token        TEXT,                              -- unguessable token for the public download link
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outpass_requester ON outpass_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_outpass_approver  ON outpass_requests(approver_id);
CREATE INDEX IF NOT EXISTS idx_outpass_status    ON outpass_requests(status);

-- ===================== OUTPASS: manager-on-leave routing =====================
ALTER TABLE dept_approvers    ADD COLUMN IF NOT EXISTS leave_cover_emp_id INT REFERENCES employees(id);  -- per-dept leave cover (optional)
ALTER TABLE outpass_requests  ADD COLUMN IF NOT EXISTS manager_on_leave BOOLEAN DEFAULT FALSE;            -- requester flagged head as on leave
ALTER TABLE outpass_requests  ADD COLUMN IF NOT EXISTS action_token TEXT;                                 -- one-tap WhatsApp approve/reject token

-- ===================== TICKET ROUTING (pattern + L1 pool + holidays) =====================
-- pattern: 'assign' = L2 receives & assigns an L1 from the pool;  'direct' = straight to a single L1 (no L2).
ALTER TABLE categories ADD COLUMN IF NOT EXISTS pattern              TEXT DEFAULT 'assign';
ALTER TABLE categories ADD COLUMN IF NOT EXISTS wait_unassigned_mins INT  DEFAULT 60;   -- A: nudge L2 until they assign
ALTER TABLE categories ADD COLUMN IF NOT EXISTS wait_cycle_mins      INT  DEFAULT 120;  -- A: L1+L2 cycle after assign · B: L1 cycle
ALTER TABLE categories ADD COLUMN IF NOT EXISTS wait_l3_mins         INT  DEFAULT 240;  -- A: include L3 from this point (if L3 set)

-- L1 candidates an L2 can assign a ticket to (Pattern A).
CREATE TABLE IF NOT EXISTS category_l1_pool (
  category_id INT REFERENCES categories(id) ON DELETE CASCADE,
  emp_id      INT REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, emp_id)
);

-- Ticket assignment + reminder tracking (new escalation engine).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_at      TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_by_id   INT REFERENCES employees(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;

-- Working-calendar holidays (timers pause on these dates, like Sundays).
CREATE TABLE IF NOT EXISTS holidays (
  d     DATE PRIMARY KEY,
  label TEXT
);
INSERT INTO holidays(d,label) VALUES
  ('2026-08-15','Independence Day'),
  ('2026-09-14','Holiday'),
  ('2026-10-02','Gandhi Jayanti'),
  ('2026-10-19','Holiday'),
  ('2026-11-08','Holiday')
ON CONFLICT (d) DO NOTHING;

-- ===================== EXPENSE REIMBURSEMENT =====================
ALTER TABLE employees ADD COLUMN IF NOT EXISTS expense_category TEXT;   -- 'CAT1' | 'CAT2' (NULL = CAT2)

-- Admin-editable policy numbers (per-km rates + daily category limits).
CREATE TABLE IF NOT EXISTS expense_policy (
  key   TEXT PRIMARY KEY,
  value NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS expense_submissions (
  id             SERIAL PRIMARY KEY,
  ref_no         TEXT UNIQUE NOT NULL,
  employee_id    INT REFERENCES employees(id),
  form_type      TEXT NOT NULL,                       -- conveyance | outstation | misc
  period         TEXT,                                -- YYYY-MM (the travel month)
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- entries/trips/items (+ per-line bill refs)
  total_amount   NUMERIC NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'draft',       -- draft | pending | approved | rejected | generated
  flags          JSONB,                               -- over-limit notes for HR
  reviewed_by_id INT REFERENCES employees(id),
  reviewed_by_name TEXT,
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT,
  pdf_token      TEXT,                                -- public download token
  pdf_url        TEXT,                                -- OneDrive webUrl once saved
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  submitted_at   TIMESTAMPTZ
);

-- Local Conveyance → Reporting Manager approval (one-tap WhatsApp).
ALTER TABLE employees           ADD COLUMN IF NOT EXISTS reporting_manager_emp_id INT REFERENCES employees(id);
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS approver_emp_id          INT REFERENCES employees(id);
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS action_token             TEXT;

-- Payment-approval chain: HR review → chosen final approver → accounts.
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS hr_by_id          INT REFERENCES employees(id);
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS hr_by_name        TEXT;
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS hr_at             TIMESTAMPTZ;
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS final_approver_id INT REFERENCES employees(id);
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS final_by_name     TEXT;
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS final_at          TIMESTAMPTZ;
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS return_reason     TEXT;
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS return_stage      TEXT;

-- Seed the approval-chain config once (best-effort, by known emp_no; admin can edit).
INSERT INTO app_settings(key, value)
SELECT 'expense_chain', json_build_object(
  'hr_approver_ids',    COALESCE((SELECT json_agg(id) FROM employees WHERE emp_no = 'BSC/125'), '[]'::json),
  'final_approver_ids', COALESCE((SELECT json_agg(id) FROM employees WHERE emp_no IN ('BSC/017','CMD','CEO')), '[]'::json),
  'accounts_email',     'accounts@bharatsteels.in',
  'accounts_notify_id', NULL
)::text
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'expense_chain');

-- Per-trip Local Conveyance approval (each trip → reporting manager one-tap).
CREATE TABLE IF NOT EXISTS conveyance_trips (
  id              SERIAL PRIMARY KEY,
  employee_id     INT  NOT NULL REFERENCES employees(id),
  period          TEXT NOT NULL,                    -- 'YYYY-MM'
  trip_date       DATE NOT NULL,
  from_loc        TEXT,
  to_loc          TEXT,
  purpose         TEXT,
  vehicle         TEXT NOT NULL DEFAULT 'bike',
  km              NUMERIC NOT NULL DEFAULT 0,
  rate            NUMERIC NOT NULL DEFAULT 0,
  amount          NUMERIC NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  approver_emp_id INT REFERENCES employees(id),
  approver_name   TEXT,
  reviewed_at     TIMESTAMPTZ,
  reject_reason   TEXT,
  action_token    TEXT,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- first logged (drives late-flag)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_trips_emp_period ON conveyance_trips(employee_id, period);
CREATE INDEX IF NOT EXISTS idx_conv_trips_token      ON conveyance_trips(action_token);
-- Per-employee switch: does this person's conveyance need reporting-manager approval? (default yes)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS conveyance_needs_manager BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_exp_emp    ON expense_submissions(employee_id);
CREATE INDEX IF NOT EXISTS idx_exp_status ON expense_submissions(status);
CREATE INDEX IF NOT EXISTS idx_exp_form   ON expense_submissions(form_type);

-- Standard ticket categories + trades (names only; assign L1/L2 handlers in Admin → Categories).
INSERT INTO categories(name, has_trades, pattern, sort_order)
SELECT v.name, TRUE, 'assign', v.so FROM (VALUES
  ('IT and Systems', 10), ('SAP', 20), ('HR', 30)
) AS v(name, so)
WHERE NOT EXISTS (SELECT 1 FROM categories);

INSERT INTO trades(category_id, name, sort_order)
SELECT c.id, t.name, t.so FROM categories c
JOIN (VALUES
  ('IT and Systems','Network / WiFi',1),
  ('IT and Systems','Server',2),
  ('IT and Systems','Device Issue',3),
  ('IT and Systems','Printer Issue',4),
  ('IT and Systems','Telephone',5),
  ('SAP','New Query Report',1),
  ('SAP','Issue with Existing Query',2),
  ('SAP','SO Modification',3),
  ('HR','Attendance Regularisation',1),
  ('HR','Conveyance / Reimbursement',2),
  ('HR','PF / ESI',3)
) AS t(cat,name,so) ON lower(c.name)=lower(t.cat)
WHERE NOT EXISTS (SELECT 1 FROM trades);

-- Self-tickets: a person logs a task for themselves (often delegated by CMD/CEO).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_self         BOOLEAN DEFAULT FALSE;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requested_by_id INT REFERENCES employees(id);

-- Designated outpass approvers can't approve their own passes — route theirs to HR (the fallback approver).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS outpass_via_hr BOOLEAN NOT NULL DEFAULT FALSE;

-- Location-based handler assignment for a trade (e.g. Maintenance → Electrical).
-- When a trade is location_based: the ticket's location is mandatory and the L1 is
-- looked up per location; the trade's own l1_emp_id acts as the fallback.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS location_based BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS trade_location_l1 (
  id          SERIAL PRIMARY KEY,
  trade_id    INT NOT NULL REFERENCES trades(id)    ON DELETE CASCADE,
  location_id INT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  l1_emp_id   INT REFERENCES employees(id),
  UNIQUE(trade_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_trade_loc ON trade_location_l1(trade_id);

-- Self-ticket "Requested by" can also be a company/site (not just an employee).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requested_by_label TEXT;
INSERT INTO app_settings(key,value)
  VALUES ('requester_groups', E'Crayon\nMetfraa Office\nMetfraa Factory\nG2')
  ON CONFLICT(key) DO NOTHING;

-- Per-employee gate for the "Raise for myself" (self-task) feature. Off by default.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS can_self_raise BOOLEAN NOT NULL DEFAULT FALSE;
-- Per-employee access to restricted launcher apps (qms, dispatch). {} = no restricted apps granted.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS app_access JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Per-ticket token for the requester's one-tap WhatsApp actions (confirm-close / reopen).
-- Rotated on every resolve, so an old resolved message's buttons stop working after a re-resolve.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS confirm_token TEXT;
CREATE INDEX IF NOT EXISTS idx_tickets_confirm_token ON tickets(confirm_token);

-- Per-employee scoped daily reports: each subscriber gets a report filtered to the
-- categories / trades they care about. Empty scope or no tickets that day = nothing sent.
CREATE TABLE IF NOT EXISTS report_subscriptions (
  employee_id  INT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  category_ids INT[] NOT NULL DEFAULT '{}',
  trade_ids    INT[] NOT NULL DEFAULT '{}'
);

-- ===== Genset (DG) daily logs =====
CREATE TABLE IF NOT EXISTS gensets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kva TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- seed DG-1 / DG-2 only when the table is empty (safe to re-run)
INSERT INTO gensets (name, kva, sort_order)
SELECT v.name, v.kva, v.so
FROM (VALUES ('DG-1','42 kVA',1), ('DG-2','125 kVA',2)) AS v(name, kva, so)
WHERE NOT EXISTS (SELECT 1 FROM gensets);

CREATE TABLE IF NOT EXISTS genset_logs (
  id SERIAL PRIMARY KEY,
  genset_id INT NOT NULL REFERENCES gensets(id),
  log_date DATE NOT NULL,
  start_hrs NUMERIC(10,1) NOT NULL,
  stop_hrs  NUMERIC(10,1) NOT NULL,
  running_hrs NUMERIC(10,1) NOT NULL,
  fuel_added NUMERIC(10,1),
  load_pct   NUMERIC(6,1),
  e_oil TEXT,
  c_oil TEXT,
  remarks TEXT,
  recorded_by INT REFERENCES employees(id),
  recorded_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_genset_logs_genset_date ON genset_logs(genset_id, log_date);

-- ===== External / vendor support hold (pauses reminders until a working-hours ETA) =====
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_hold   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_hours  NUMERIC(6,1);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_set_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_count  INT NOT NULL DEFAULT 0;

-- Conveyance: mark which claim (submission ref) a trip was included in, so a month
-- can stay open after approval and new trips form an additional claim without re-claiming paid ones.
ALTER TABLE conveyance_trips ADD COLUMN IF NOT EXISTS claim_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_ctrips_claim ON conveyance_trips(claim_ref);
