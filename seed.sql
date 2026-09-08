-- Agent-First Front Door — Seed Data (dev/testing only)
--
-- Run with: wrangler d1 execute equation-agency-agents --local --file=seed.sql
-- Do NOT run this against production — it's example data only.

INSERT INTO services (name, description, price_cents, currency, active) VALUES
  ('AI Strategy Session', 'A focused session mapping AI adoption opportunities across your business.', 45000, 'USD', 1),
  ('Digital Marketing Audit', 'Full audit of current digital marketing performance with prioritized fixes.', 30000, 'USD', 1),
  ('Agent-Ready Website Build', 'Build or retrofit a site with an agent-first front door architecture.', 250000, 'USD', 1);

-- Slots for the next 3 business days, 10am/1pm/3pm (adjust timestamps to your actual dates)
INSERT INTO availability (slot_start, slot_end, booked) VALUES
  (strftime('%s', 'now', '+1 day', 'start of day', '+10 hours'), strftime('%s', 'now', '+1 day', 'start of day', '+11 hours'), 0),
  (strftime('%s', 'now', '+1 day', 'start of day', '+13 hours'), strftime('%s', 'now', '+1 day', 'start of day', '+14 hours'), 0),
  (strftime('%s', 'now', '+2 day', 'start of day', '+15 hours'), strftime('%s', 'now', '+2 day', 'start of day', '+16 hours'), 0);
