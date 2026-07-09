-- Retire the Simmer brand (product owner decision, 2026-07-09).
-- Hide it from every customer-facing surface: the storefront brand grid,
-- brand microsite, ordering pages, and reservations. Data (orders, menu
-- items, journal entries against revenue account 4001) is preserved for
-- reporting — this only flips visibility, it deletes nothing. Idempotent.
UPDATE "concepts"
SET "isActive" = false, "storefrontVisible" = false
WHERE slug = 'simmer';
