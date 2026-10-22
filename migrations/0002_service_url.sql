-- Agent-First Front Door — services.url
--
-- The page on your own site that describes each service, so an agent can
-- send a person to the right page instead of guessing one. NULL is fine: the
-- payload then says null and nothing else changes.

ALTER TABLE services ADD COLUMN url TEXT;
