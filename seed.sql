-- Agent-First Front Door — Seed Data (dev/testing only)
--
-- Run with: wrangler d1 execute agent-front-door --local --file=seed.sql
-- Do NOT run this against production — it is example data, not yours.
--
-- Replace these rows with your own offerings once the plumbing works. The
-- shape is what matters: three things you sell, and some slots to book.

INSERT INTO services (name, description, price_cents, currency, active) VALUES
  ('Strategy Session', 'A focused session mapping opportunities across your business.', 45000, 'USD', 1),
  ('Audit', 'Full review of current performance with prioritized fixes.', 30000, 'USD', 1),
  ('Implementation', 'Build or retrofit a system end to end.', 250000, 'USD', 1);

-- Slots for the next few days, 10am/1pm/3pm, relative to when you run this.
INSERT INTO availability (slot_start, slot_end, booked) VALUES
  (strftime('%s', 'now', '+1 day', 'start of day', '+10 hours'), strftime('%s', 'now', '+1 day', 'start of day', '+11 hours'), 0),
  (strftime('%s', 'now', '+1 day', 'start of day', '+13 hours'), strftime('%s', 'now', '+1 day', 'start of day', '+14 hours'), 0),
  (strftime('%s', 'now', '+2 day', 'start of day', '+15 hours'), strftime('%s', 'now', '+2 day', 'start of day', '+16 hours'), 0);
