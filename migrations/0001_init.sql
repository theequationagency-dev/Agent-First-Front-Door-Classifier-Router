-- Agent-First Front Door — D1 Schema
-- The Equation Agency LLC
--
-- Apply with:  wrangler d1 migrations apply equation-agency-agents [--remote]
-- Or directly: wrangler d1 execute equation-agency-agents --file=migrations/0001_init.sql
-- (add --remote to apply to the production D1 instance instead of local)

-- ---------------------------------------------------------------------------
-- services: what the agency offers. Read by both the agent JSON payload
-- and the MCP get_services tool — single source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER,          -- store cents, not dollars, to avoid float issues
  currency    TEXT DEFAULT 'USD',
  active      INTEGER NOT NULL DEFAULT 1,  -- 0/1 boolean
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------------------------------------------------------------------------
-- availability: open consultation slots. Read by check_availability
-- (both the /api/availability route and the MCP tool).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS availability (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_start  INTEGER NOT NULL,   -- unix timestamp
  slot_end    INTEGER NOT NULL,
  booked      INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_availability_booked_start
  ON availability (booked, slot_start);

-- ---------------------------------------------------------------------------
-- bookings: created by POST /api/book (and the MCP book_consult tool).
-- Each booking claims exactly one availability slot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id      INTEGER NOT NULL REFERENCES availability(id),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  notes        TEXT,
  source       TEXT NOT NULL DEFAULT 'unknown',  -- 'human' | 'agent' | 'mcp'
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- UNIQUE, not a plain index: "one booking per slot" is the rule the booking
-- path enforces in application code, and this is the backstop if a future
-- caller ever writes to bookings without going through createBooking().
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot_id ON bookings (slot_id);

-- ---------------------------------------------------------------------------
-- request_log: every request the Worker classifies. Used to review the
-- "unknown" bucket and tune the classifier ruleset over time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  path           TEXT NOT NULL,
  user_agent     TEXT,
  classification TEXT NOT NULL,  -- 'mcp' | 'agent' | 'human' | 'unknown'
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_request_log_classification_created
  ON request_log (classification, created_at);

-- ---------------------------------------------------------------------------
-- incidents: failures on the agent-facing path specifically — blocked
-- fetches, rate limits, D1 errors, MCP tool call failures. Kept separate
-- from request_log because these are signal for what agents can't yet do,
-- not just traffic classification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT,
  kind         TEXT NOT NULL,   -- 'rate_limit' | 'blocked_fetch' | 'db_error' | 'mcp_tool_failure' | 'other'
  detail       TEXT,            -- free-text error message / context
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_incidents_kind_created
  ON incidents (kind, created_at);
