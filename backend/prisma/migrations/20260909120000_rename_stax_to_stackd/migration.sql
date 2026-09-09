-- Rebrand: the burger concept "stax" becomes "stackd".
--
-- Only the slug and display name change. The concept row keeps its id, so every
-- order, journal entry, menu item, reservation and report that references it by
-- id is untouched — this is a rename, not a re-creation.
--
-- Deliberately NOT touched: the "stax-padel" concept, which is the padel-court
-- business and a separate brand, and the eatstax.com custom domain, which is a
-- registered domain that still resolves to this brand.
--
-- Guarded so the migration is safe to run against a database where the rename
-- has already happened, or where the concept was never seeded.
UPDATE "concepts"
   SET "slug" = 'stackd',
       "name" = 'stackd'
 WHERE "slug" = 'stax'
   AND NOT EXISTS (SELECT 1 FROM "concepts" WHERE "slug" = 'stackd');

-- The location seeded alongside it follows the same rename.
UPDATE "locations"
   SET "slug" = 'stackd-kitchen'
 WHERE "slug" = 'stax-kitchen'
   AND NOT EXISTS (SELECT 1 FROM "locations" WHERE "slug" = 'stackd-kitchen');
