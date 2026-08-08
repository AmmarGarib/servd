-- Bring the Simmer brand back (product owner decision, 2026-07-24).
--
-- Reverses 20260709120000_retire_simmer_brand, which only flipped visibility
-- and deleted nothing — so all historical data (orders, menu items, journal
-- entries against revenue account 4001) is still intact and simply becomes
-- reachable again. That retirement migration is deliberately left in place:
-- it is already recorded as applied in production, and migrations are
-- forward-only. Idempotent.
UPDATE "concepts"
SET "isActive" = true, "storefrontVisible" = true
WHERE slug = 'simmer';
