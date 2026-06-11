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
